package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"log"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	testIssuer = "eventhub-users"
	testKid    = "users-key-1"
)

func mustKey() *rsa.PrivateKey {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return k
}

var (
	signKey  = mustKey() // the key published in the test JWKS
	otherKey = mustKey() // a key the gateway does not trust
)

// jwksServer serves a mutable JWKS and counts the hits.
type jwksServer struct {
	*httptest.Server
	mu    sync.Mutex
	keys  map[string]*rsa.PublicKey
	down  bool
	delay time.Duration
	raw   string // served as is when not empty
	hits  int
}

func newJWKSServer(t *testing.T, keys map[string]*rsa.PublicKey) *jwksServer {
	s := &jwksServer{keys: keys}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.hits++
		down, delay, raw := s.down, s.delay, s.raw
		type entry struct{ Kty, Kid, Use, Alg, N, E string }
		var list []entry
		for kid, k := range s.keys {
			list = append(list, entry{"RSA", kid, "sig", "RS256",
				base64.RawURLEncoding.EncodeToString(k.N.Bytes()),
				base64.RawURLEncoding.EncodeToString(big.NewInt(int64(k.E)).Bytes())})
		}
		s.mu.Unlock()
		time.Sleep(delay)
		if down {
			http.Error(w, "down", http.StatusInternalServerError)
			return
		}
		if raw != "" {
			w.Write([]byte(raw))
			return
		}
		out := make([]map[string]string, 0, len(list))
		for _, e := range list {
			out = append(out, map[string]string{"kty": e.Kty, "kid": e.Kid, "use": e.Use, "alg": e.Alg, "n": e.N, "e": e.E})
		}
		json.NewEncoder(w).Encode(map[string]any{"keys": out})
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *jwksServer) set(f func(*jwksServer)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f(s)
}

func (s *jwksServer) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hits
}

func defaultKeys() map[string]*rsa.PublicKey {
	return map[string]*rsa.PublicKey{testKid: &signKey.PublicKey}
}

func newTestVerifier(srv *jwksServer, clk *clock) *Verifier {
	cache := NewKeyCache(NewURLJWKS(srv.URL, srv.Client()), 30*time.Second, clk.now)
	return NewVerifier(cache, testIssuer)
}

// testVerifier trusts signKey under testKid; the cooldown clock never advances.
func testVerifier(t *testing.T) *Verifier {
	return newTestVerifier(newJWKSServer(t, defaultKeys()), &clock{t: time.Now()})
}

func claimsFor(sub string, roles ...string) jwt.MapClaims {
	if roles == nil {
		roles = []string{}
	}
	now := time.Now()
	return jwt.MapClaims{"sub": sub, "roles": roles, "iss": testIssuer, "iat": now.Unix(),
		"exp": now.Add(30 * time.Minute).Unix(), "jti": "j-" + sub}
}

func signWith(t *testing.T, key *rsa.PrivateKey, kid string, c jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, c)
	if kid != "" {
		tok.Header["kid"] = kid
	}
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// tokenFor signs a valid token of sub with the trusted key. Tests that need it before a *testing.T exists use bearerFor.
func tokenFor(sub string, roles ...string) string {
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claimsFor(sub, roles...))
	tok.Header["kid"] = testKid
	s, err := tok.SignedString(signKey)
	if err != nil {
		panic(err)
	}
	return s
}

func bearerFor(sub string) string { return "Bearer " + tokenFor(sub) }

func authHdr(sub string) map[string]string { return map[string]string{"Authorization": bearerFor(sub)} }

// seen records what the downstream handler received.
type seen struct {
	mu   sync.Mutex
	hits int
	hdr  http.Header
}

func (s *seen) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.hits++
		s.hdr = r.Header.Clone()
		s.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
}

// authChain is Resolve+Auth in front of a recording handler, with a secure (requireAuth) and an open endpoint.
func authChain(t *testing.T, v *Verifier) (http.Handler, *seen) {
	eps := NewEndpoints(newFakeStore(
		epWith(User, "GET", "/secure", 100, RateLimitGlobal, true),
		epWith(User, "GET", "/open", 100, RateLimitGlobal, false)))
	eps.Refresh(context.Background())
	s := &seen{}
	return Chain(s.handler(), Resolve(eps), Auth(v)), s
}

func call(h http.Handler, path string, hdr map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", path, nil)
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestAuthSetsVerifiedIdentity(t *testing.T) {
	h, down := authChain(t, testVerifier(t))
	valid := tokenFor("user-1", "PARTICIPANT", "ORGANIZER")
	noRoles := tokenFor("user-2")
	foreign := signWith(t, otherKey, testKid, claimsFor("x"))
	forged := map[string]string{"X-User-Id": "evil", "X-User-Roles": "ADMIN"}
	with := func(extra map[string]string) map[string]string {
		m := map[string]string{}
		for k, v := range forged {
			m[k] = v
		}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	tests := []struct {
		name, path string
		hdr        map[string]string
		code       int
		user       string
		roles      string
		auth       string
	}{
		{"valid token on requireAuth, forged headers replaced", "/user/secure",
			with(map[string]string{"Authorization": "Bearer " + valid}), 204, "user-1", "PARTICIPANT,ORGANIZER", "Bearer " + valid},
		{"valid token on requireAuth without roles", "/user/secure",
			map[string]string{"Authorization": "Bearer " + noRoles, "X-User-Roles": "ADMIN"}, 204, "user-2", "", "Bearer " + noRoles},
		{"valid token on public route", "/user/open",
			with(map[string]string{"Authorization": "Bearer " + valid}), 204, "user-1", "PARTICIPANT,ORGANIZER", "Bearer " + valid},
		{"public route without token: forged headers stripped", "/user/open", with(nil), 204, "", "", ""},
		{"public route with invalid token: forged headers stripped, token forwarded", "/user/open",
			with(map[string]string{"Authorization": "Bearer not.a.jwt"}), 204, "", "", "Bearer not.a.jwt"},
		{"public route with token of another key", "/user/open",
			with(map[string]string{"Authorization": "Bearer " + foreign}), 204, "", "", "Bearer " + foreign},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := call(h, tc.path, tc.hdr)
			if w.Code != tc.code {
				t.Fatalf("status %d want %d", w.Code, tc.code)
			}
			got := down.hdr
			if got.Get("X-User-Id") != tc.user || got.Get("X-User-Roles") != tc.roles {
				t.Errorf("downstream identity %q/%q want %q/%q", got.Get("X-User-Id"), got.Get("X-User-Roles"), tc.user, tc.roles)
			}
			if got.Get("Authorization") != tc.auth {
				t.Errorf("Authorization not forwarded unchanged: %q want %q", got.Get("Authorization"), tc.auth)
			}
		})
	}
}

func TestAuthRejectsOnRequireAuth(t *testing.T) {
	pubPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: mustMarshalPub(t)})
	hs256, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claimsFor("x")).SignedString(pubPEM)
	if err != nil {
		t.Fatal(err)
	}
	none, err := jwt.NewWithClaims(jwt.SigningMethodNone, claimsFor("x")).SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatal(err)
	}
	noneKid := jwt.NewWithClaims(jwt.SigningMethodNone, claimsFor("x"))
	noneKid.Header["kid"] = testKid
	noneKidTok, _ := noneKid.SignedString(jwt.UnsafeAllowNoneSignatureType)
	hs256Kid := jwt.NewWithClaims(jwt.SigningMethodHS256, claimsFor("x"))
	hs256Kid.Header["kid"] = testKid
	hs256KidTok, _ := hs256Kid.SignedString(pubPEM)

	expired := claimsFor("x")
	expired["exp"] = time.Now().Add(-5 * time.Minute).Unix()
	badIss := claimsFor("x")
	badIss["iss"] = "someone-else"
	noExp := claimsFor("x")
	delete(noExp, "exp")
	noSub := claimsFor("x")
	delete(noSub, "sub")
	emptySub := claimsFor("")
	badRoles := claimsFor("x")
	badRoles["roles"] = "ADMIN"

	tests := []struct {
		name string
		auth string
	}{
		{"no token", ""},
		{"basic scheme", "Basic dTpw"},
		{"empty bearer", "Bearer "},
		{"malformed", "Bearer abc"},
		{"malformed three parts", "Bearer a.b.c"},
		{"expired", "Bearer " + signWith(t, signKey, testKid, expired)},
		{"wrong issuer", "Bearer " + signWith(t, signKey, testKid, badIss)},
		{"missing exp", "Bearer " + signWith(t, signKey, testKid, noExp)},
		{"missing sub", "Bearer " + signWith(t, signKey, testKid, noSub)},
		{"empty sub", "Bearer " + signWith(t, signKey, testKid, emptySub)},
		{"roles not an array", "Bearer " + signWith(t, signKey, testKid, badRoles)},
		{"different key, known kid", "Bearer " + signWith(t, otherKey, testKid, claimsFor("x"))},
		{"alg none", "Bearer " + none},
		{"alg none with kid", "Bearer " + noneKidTok},
		{"HS256 with the public key as secret", "Bearer " + hs256},
		{"HS256 with the public key as secret and kid", "Bearer " + hs256KidTok},
		{"missing kid", "Bearer " + signWith(t, signKey, "", claimsFor("x"))},
		{"unknown kid", "Bearer " + signWith(t, signKey, "ghost", claimsFor("x"))},
	}
	clk := &clock{t: time.Now()}
	srv := newJWKSServer(t, defaultKeys())
	h, down := authChain(t, newTestVerifier(srv, clk))
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clk.add(time.Minute) // past the cooldown, so unknown kids really go through a refetch
			hdr := map[string]string{"X-User-Id": "evil", "X-User-Roles": "ADMIN"}
			if tc.auth != "" {
				hdr["Authorization"] = tc.auth
			}
			before := down.hits
			w := call(h, "/user/secure", hdr)
			if w.Code != 401 || w.Header().Get("WWW-Authenticate") != "Bearer" {
				t.Errorf("status %d www-authenticate %q", w.Code, w.Header().Get("WWW-Authenticate"))
			}
			if down.hits != before {
				t.Error("rejected request reached the downstream")
			}
			if tok := strings.TrimPrefix(tc.auth, "Bearer "); len(tok) > 8 && strings.Contains(w.Body.String(), tok) {
				t.Error("response echoes the token")
			}
		})
	}
	// A token with an unknown kid after the cooldown makes the gateway refetch, but the rejection stands.
	if srv.count() < 2 {
		t.Errorf("unknown kid after cooldown should refetch, jwks hits = %d", srv.count())
	}
}

func mustMarshalPub(t *testing.T) []byte {
	b, err := x509.MarshalPKIXPublicKey(&signKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestAuthLeeway(t *testing.T) {
	h, _ := authChain(t, testVerifier(t))
	c := claimsFor("x")
	c["exp"] = time.Now().Add(-10 * time.Second).Unix()
	if w := call(h, "/user/secure", map[string]string{"Authorization": "Bearer " + signWith(t, signKey, testKid, c)}); w.Code != 204 {
		t.Errorf("token expired 10s ago must pass with 30s leeway: %d", w.Code)
	}
}

func TestAuthOpenEndpointAnonymousOnBadToken(t *testing.T) {
	h, down := authChain(t, testVerifier(t))
	expired := claimsFor("x")
	expired["exp"] = time.Now().Add(-time.Hour).Unix()
	for name, auth := range map[string]string{
		"malformed": "Bearer abc",
		"expired":   "Bearer " + signWith(t, signKey, testKid, expired),
		"forged":    "Bearer " + signWith(t, otherKey, testKid, claimsFor("x")),
	} {
		if w := call(h, "/user/open", map[string]string{"Authorization": auth, "X-User-Id": "evil"}); w.Code != 204 {
			t.Errorf("%s: %d", name, w.Code)
		}
		if down.hdr.Get("X-User-Id") != "" || down.hdr.Get("Authorization") != auth {
			t.Errorf("%s: want anonymous with Authorization untouched, got id=%q auth=%q", name, down.hdr.Get("X-User-Id"), down.hdr.Get("Authorization"))
		}
	}
}

func TestAuthRateLimitKeyedByVerifiedSub(t *testing.T) {
	eps := NewEndpoints(newFakeStore(ep(User, "GET", "/x", 1)))
	eps.Refresh(context.Background())
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }),
		Resolve(eps), Auth(testVerifier(t)), RateLimit(NewLimiter(time.Now), nil))
	do := func(ip, sub, forged string) int {
		hdr := map[string]string{}
		if sub != "" {
			hdr["Authorization"] = bearerFor(sub)
		}
		if forged != "" {
			hdr["X-User-Id"] = forged
		}
		r := httptest.NewRequest("GET", "/user/x", nil)
		r.RemoteAddr = ip + ":1"
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if do("1.1.1.1", "a", "b") != 204 {
		t.Fatal("first call of a")
	}
	if do("2.2.2.2", "a", "c") != 429 {
		t.Error("a forged X-User-Id must not select another bucket: a shares its budget")
	}
	if do("1.1.1.1", "b", "") != 204 {
		t.Error("the forged id b must not have been charged")
	}
	if do("3.3.3.3", "", "z1") != 204 || do("3.3.3.3", "", "z2") != 429 {
		t.Error("anonymous callers are keyed by IP whatever X-User-Id they send")
	}
}

func TestAuthLoggingShowsVerifiedUser(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	eps := NewEndpoints(newFakeStore(ep(User, "GET", "/open", 10)))
	eps.Refresh(context.Background())
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}), Logging(), Resolve(eps), Auth(testVerifier(t)))
	tok := tokenFor("real-user")
	call(h, "/user/open", map[string]string{"Authorization": "Bearer " + tok, "X-User-Id": "evil"})
	call(h, "/user/open", map[string]string{"X-User-Id": "evil"})
	out := buf.String()
	if !strings.Contains(out, "user=real-user") || !strings.Contains(out, "user=-") || strings.Contains(out, "evil") {
		t.Errorf("log: %s", out)
	}
	if strings.Contains(out, tok) || strings.Contains(out, "Bearer") {
		t.Error("log leaks the token")
	}
}

func TestKeyCacheUnknownKidSingleRefetch(t *testing.T) {
	srv := newJWKSServer(t, defaultKeys())
	srv.set(func(s *jwksServer) { s.delay = 50 * time.Millisecond })
	clk := &clock{t: time.Now()}
	kc := NewKeyCache(NewURLJWKS(srv.URL, srv.Client()), 30*time.Second, clk.now)
	ctx := context.Background()
	if _, err := kc.Key(ctx, testKid); err != nil || srv.count() != 1 {
		t.Fatalf("lazy first fetch: err=%v hits=%d", err, srv.count())
	}
	storm := func() {
		var wg sync.WaitGroup
		for i := 0; i < 50; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := kc.Key(ctx, "ghost"); !errors.Is(err, ErrUnknownKid) {
					t.Errorf("err = %v", err)
				}
			}()
		}
		wg.Wait()
	}
	storm()
	if srv.count() != 1 {
		t.Errorf("within the cooldown no refetch is allowed, hits = %d", srv.count())
	}
	clk.add(31 * time.Second)
	storm()
	if srv.count() != 2 {
		t.Errorf("50 concurrent unknown kids must share one refetch, hits = %d", srv.count())
	}
	storm()
	if srv.count() != 2 {
		t.Errorf("cooldown restarted after the refetch, hits = %d", srv.count())
	}
}

func TestKeyRotationPickedUp(t *testing.T) {
	clk := &clock{t: time.Now()}
	srv := newJWKSServer(t, defaultKeys())
	h, _ := authChain(t, newTestVerifier(srv, clk))
	tok1 := "Bearer " + signWith(t, signKey, testKid, claimsFor("a"))
	tok2 := "Bearer " + signWith(t, otherKey, "users-key-2", claimsFor("b"))
	if w := call(h, "/user/secure", map[string]string{"Authorization": tok1}); w.Code != 204 {
		t.Fatalf("old key: %d", w.Code)
	}
	srv.set(func(s *jwksServer) { s.keys["users-key-2"] = &otherKey.PublicKey })
	if w := call(h, "/user/secure", map[string]string{"Authorization": tok2}); w.Code != 401 {
		t.Errorf("new kid inside the cooldown must be rejected: %d", w.Code)
	}
	clk.add(time.Minute)
	if w := call(h, "/user/secure", map[string]string{"Authorization": tok2}); w.Code != 204 {
		t.Errorf("rotated key not picked up: %d", w.Code)
	}
	if w := call(h, "/user/secure", map[string]string{"Authorization": tok1}); w.Code != 204 {
		t.Errorf("old key still published, must keep working: %d", w.Code)
	}
}

func TestKeyCacheRefresh(t *testing.T) {
	ctx := context.Background()
	clk := &clock{t: time.Now()}
	srv := newJWKSServer(t, defaultKeys())
	kc := NewKeyCache(NewURLJWKS(srv.URL, srv.Client()), time.Hour, clk.now)
	if err := kc.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	// Failure modes keep the old keys.
	srv.set(func(s *jwksServer) { s.down = true })
	if err := kc.Refresh(ctx); err == nil {
		t.Error("refresh must report the failure")
	}
	for name, raw := range map[string]string{"bad json": "{", "no usable keys": `{"keys":[{"kty":"EC","kid":"e"}]}`} {
		srv.set(func(s *jwksServer) { s.down, s.raw = false, raw })
		if err := kc.Refresh(ctx); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
	if _, err := kc.Key(ctx, testKid); err != nil {
		t.Errorf("old keys must survive failed refreshes: %v", err)
	}
	// A good refresh replaces the set: the retired key drops out.
	srv.set(func(s *jwksServer) {
		s.raw = ""
		s.keys = map[string]*rsa.PublicKey{"users-key-2": &otherKey.PublicKey}
	})
	if err := kc.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := kc.Key(ctx, "users-key-2"); err != nil {
		t.Errorf("new key: %v", err)
	}
	if _, err := kc.Key(ctx, testKid); !errors.Is(err, ErrUnknownKid) {
		t.Errorf("retired key must be gone: %v", err)
	}
}

func TestParseJWKSOnlyRSA(t *testing.T) {
	n := base64.RawURLEncoding.EncodeToString(signKey.N.Bytes())
	doc := `{"keys":[
		{"kty":"EC","kid":"ec","crv":"P-256","x":"AA","y":"AA"},
		{"kty":"oct","kid":"hmac","k":"AA"},
		{"kty":"RSA","n":"` + n + `","e":"AQAB"},
		{"kty":"RSA","kid":"enc","use":"enc","n":"` + n + `","e":"AQAB"},
		{"kty":"RSA","kid":"bad","n":"!!","e":"AQAB"},
		{"kty":"RSA","kid":"ok","n":"` + n + `","e":"AQAB"}]}`
	keys, err := parseJWKS([]byte(doc))
	if err != nil || len(keys) != 1 || keys["ok"] == nil || keys["ok"].E != 65537 || keys["ok"].N.Cmp(signKey.N) != 0 {
		t.Errorf("keys=%v err=%v", keys, err)
	}
}

func TestJWKSDownAtStartup(t *testing.T) {
	clk := &clock{t: time.Now()}
	srv := newJWKSServer(t, defaultKeys())
	srv.set(func(s *jwksServer) { s.down = true })
	v := newTestVerifier(srv, clk) // constructing must not need the JWKS
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer down.Close()
	ds, _ := fakeDiscoverer(t, map[string][]string{"user": {hostOf(down)}})
	gw, _ := newGatewayAuth(t, newFakeStore(
		epWith(User, "GET", "/secure", 100, RateLimitGlobal, true),
		epWith(User, "GET", "/open", 100, RateLimitGlobal, false)), NewDiscovery(ds.URL), v)
	tok := authHdr("u1")

	if resp, _ := get(t, "GET", gw.URL+"/user/secure", "", tok); resp.StatusCode != 503 {
		t.Errorf("token + JWKS down on requireAuth: %d want 503", resp.StatusCode)
	}
	if resp, _ := get(t, "GET", gw.URL+"/user/secure", "", nil); resp.StatusCode != 401 {
		t.Errorf("no token on requireAuth: %d want 401", resp.StatusCode)
	}
	if resp, _ := get(t, "GET", gw.URL+"/user/open", "", tok); resp.StatusCode != 200 {
		t.Errorf("public route with token while JWKS down: %d want 200", resp.StatusCode)
	}
	if resp, _ := get(t, "GET", gw.URL+"/user/open", "", nil); resp.StatusCode != 200 {
		t.Errorf("public route: %d want 200", resp.StatusCode)
	}
	// Recovery: once Users is back and the cooldown has passed, the next request fetches the keys.
	srv.set(func(s *jwksServer) { s.down = false })
	clk.add(time.Minute)
	if resp, _ := get(t, "GET", gw.URL+"/user/secure", "", tok); resp.StatusCode != 200 {
		t.Errorf("after recovery: %d want 200", resp.StatusCode)
	}
}

func TestDiscoveryJWKSFetcher(t *testing.T) {
	srv := newJWKSServer(t, defaultKeys())
	dead := httptest.NewServer(http.NotFoundHandler())
	deadHost := hostOf(dead)
	dead.Close()
	ds, calls := fakeDiscoverer(t, map[string][]string{"user": {deadHost, hostOf(srv.Server)}})
	disc := NewDiscovery(ds.URL)
	kc := NewKeyCache(NewDiscoveryJWKS(disc, srv.Client()), time.Hour, time.Now)
	ctx := context.Background()
	if err := kc.Refresh(ctx); err == nil {
		t.Fatal("dead host: want error")
	}
	// The failed host was forgotten, so the next fetch consults the discoverer again and reaches the live one.
	if err := kc.Refresh(ctx); err != nil || *calls != 2 {
		t.Errorf("err=%v consults=%d", err, *calls)
	}
	if _, err := kc.Key(ctx, testKid); err != nil {
		t.Error(err)
	}
}

func TestKeyCacheRunRefreshes(t *testing.T) {
	srv := newJWKSServer(t, defaultKeys())
	kc := NewKeyCache(NewURLJWKS(srv.URL, srv.Client()), time.Hour, time.Now)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { kc.Run(ctx, 10*time.Millisecond); close(done) }()
	deadline := time.Now().Add(2 * time.Second)
	for srv.count() < 3 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if srv.count() < 3 {
		t.Errorf("Run should refresh periodically, hits = %d", srv.count())
	}
}
