package main

import (
	"bytes"
	"context"
	"encoding/pem"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

// wsGateway serves the real mux (Cors + Logging + /ws) with a hub tuned for fast tests.
func wsGateway(t *testing.T, tune ...func(*Hub)) (*httptest.Server, *Hub) {
	t.Helper()
	return wsGatewayWith(t, testVerifier(t), tune...)
}

func wsGatewayWith(t *testing.T, v *Verifier, tune ...func(*Hub)) (*httptest.Server, *Hub) {
	t.Helper()
	store := newFakeStore()
	eps := NewEndpoints(store)
	if err := eps.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	hub := NewHub()
	for _, f := range tune {
		f(hub)
	}
	srv := httptest.NewServer(newMux(store, eps, hub, v, NewPipeline(eps, v, NewLimiter(time.Now), nil, NewProxy(NewDiscovery("http://127.0.0.1:1")))))
	t.Cleanup(srv.Close)
	return srv, hub
}

func dialWS(t *testing.T, srv *httptest.Server, query string, hdr http.Header) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	d := websocket.Dialer{HandshakeTimeout: 2 * time.Second}
	c, resp, err := d.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws"+query, hdr)
	if c != nil {
		t.Cleanup(func() { c.Close() })
	}
	return c, resp, err
}

func readFrame(t *testing.T, c *websocket.Conn) string {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, b, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(b)
}

func connect(t *testing.T, srv *httptest.Server, query string, hdr http.Header) *websocket.Conn {
	t.Helper()
	c, _, err := dialWS(t, srv, query, hdr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if f := readFrame(t, c); f != `{"type":"connected"}` {
		t.Fatalf("first frame = %s", f)
	}
	return c
}

// user is the header of a signed token for id.
func user(id string) http.Header { return http.Header{"Authorization": {bearerFor(id)}} }

func TestWSRequiresToken(t *testing.T) {
	srv, hub := wsGateway(t)
	hub.Register(newClient("victim", 4))
	for _, tc := range []struct {
		name, query string
		hdr         http.Header
	}{
		{"nothing", "", nil},
		{"X-User-Id alone", "", http.Header{"X-User-Id": {"victim"}}},
		{"user_id alone", "?user_id=victim", nil},
		{"both without token", "?user_id=victim", http.Header{"X-User-Id": {"victim"}}},
		{"empty access_token", "?access_token=", nil},
	} {
		_, resp, err := dialWS(t, srv, tc.query, tc.hdr)
		if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: err=%v resp=%v, want 401", tc.name, err, resp)
			continue
		}
		if resp.Header.Get("WWW-Authenticate") != "Bearer" {
			t.Errorf("%s: WWW-Authenticate = %q", tc.name, resp.Header.Get("WWW-Authenticate"))
		}
	}
}

func TestWSRejectsInvalidTokens(t *testing.T) {
	pubPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: mustMarshalPub(t)})
	hs256, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claimsFor("x")).SignedString(pubPEM)
	if err != nil {
		t.Fatal(err)
	}
	none, err := jwt.NewWithClaims(jwt.SigningMethodNone, claimsFor("x")).SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatal(err)
	}
	expired := claimsFor("x")
	expired["exp"] = time.Now().Add(-5 * time.Minute).Unix()
	badIss := claimsFor("x")
	badIss["iss"] = "someone-else"
	tokens := map[string]string{
		"malformed":           "abc",
		"expired":             signWith(t, signKey, testKid, expired),
		"wrong issuer":        signWith(t, signKey, testKid, badIss),
		"alg none":            none,
		"HS256 key confusion": hs256,
		"unknown kid":         signWith(t, signKey, "ghost", claimsFor("x")),
		"foreign key":         signWith(t, otherKey, testKid, claimsFor("x")),
	}
	srv, _ := wsGateway(t)
	for name, tok := range tokens {
		for via, dial := range map[string]func() (*http.Response, error){
			"header": func() (*http.Response, error) {
				_, resp, err := dialWS(t, srv, "", http.Header{"Authorization": {"Bearer " + tok}})
				return resp, err
			},
			"query": func() (*http.Response, error) {
				_, resp, err := dialWS(t, srv, "?access_token="+url.QueryEscape(tok), nil)
				return resp, err
			},
		} {
			resp, err := dial()
			if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("WWW-Authenticate") != "Bearer" {
				t.Errorf("%s via %s: err=%v resp=%v, want 401 with WWW-Authenticate", name, via, err, resp)
			}
		}
	}
}

func TestWSKeysUnavailable(t *testing.T) {
	jwks := newJWKSServer(t, defaultKeys())
	jwks.set(func(s *jwksServer) { s.down = true })
	srv, _ := wsGatewayWith(t, newTestVerifier(jwks, &clock{t: time.Now()}))
	_, resp, err := dialWS(t, srv, "", user("alice"))
	if err == nil || resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("err=%v resp=%v, want 503", err, resp)
	}
	if resp.Header.Get("WWW-Authenticate") != "" {
		t.Error("503 must not challenge")
	}
}

func TestWSIdentitySources(t *testing.T) {
	srv, hub := wsGateway(t)
	push := func(id string) bool { return hub.Send(id, []byte(`{"to":"`+id+`"}`)) }
	tokQuery := func(id string) string { return "?access_token=" + url.QueryEscape(tokenFor(id)) }

	h := connect(t, srv, "", user("alice"))
	if !push("alice") || readFrame(t, h) != `{"to":"alice"}` {
		t.Error("header identity did not receive")
	}
	q := connect(t, srv, tokQuery("bob"), nil)
	if !push("bob") || readFrame(t, q) != `{"to":"bob"}` {
		t.Error("query identity did not receive")
	}
	both := connect(t, srv, tokQuery("mallory"), user("carol"))
	if push("mallory") {
		t.Error("query token must not win over the header")
	}
	if !push("carol") || readFrame(t, both) != `{"to":"carol"}` {
		t.Error("header must win over the query")
	}
}

func TestWSSpoofedIdentityIgnored(t *testing.T) {
	srv, hub := wsGateway(t)
	victim := connect(t, srv, "", user("victim"))
	hdr := user("attacker")
	hdr.Set("X-User-Id", "victim")
	hdr.Set("X-User-Roles", "ADMIN")
	atk := connect(t, srv, "?user_id=victim", hdr)

	if !hub.Send("attacker", []byte(`{"to":"attacker"}`)) || readFrame(t, atk) != `{"to":"attacker"}` {
		t.Error("connection must be registered under the token's sub")
	}
	// The victim's own connection was not replaced (no close 4000) and only gets its own pushes.
	if !hub.Send("victim", []byte(`{"to":"victim"}`)) || readFrame(t, victim) != `{"to":"victim"}` {
		t.Error("victim must keep receiving its own pushes")
	}
	atk.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	if _, b, err := atk.ReadMessage(); err == nil {
		t.Errorf("attacker received %s, want nothing", b)
	}
}

func TestWSTokenNotLogged(t *testing.T) {
	var buf syncBuffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)
	srv, _ := wsGateway(t)

	tok := tokenFor("alice")
	c := connect(t, srv, "?access_token="+url.QueryEscape(tok), nil)
	c.Close()
	bad := "not.a.jwt-secret-marker"
	dialWS(t, srv, "?access_token="+bad, nil)

	// The accepted connection is logged when its handler returns, which may be after Close.
	deadline := time.Now().Add(2 * time.Second)
	for strings.Count(buf.String(), "GET /ws") < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	out := buf.String()
	if !strings.Contains(out, "GET /ws") || !strings.Contains(out, "user=alice") {
		t.Fatalf("expected the request to be logged with the verified user, got %q", out)
	}
	if strings.Contains(out, tok) || strings.Contains(out, "access_token") || strings.Contains(out, bad) {
		t.Errorf("log leaks the token: %q", out)
	}
}

// syncBuffer is a log sink safe for the server goroutines and the test to share.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestWSNewestConnectionWins(t *testing.T) {
	srv, hub := wsGateway(t)
	first := connect(t, srv, "", user("alice"))
	second := connect(t, srv, "", user("alice"))

	first.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err := first.ReadMessage()
	ce, ok := err.(*websocket.CloseError)
	if !ok || ce.Code != 4000 || ce.Text != "replaced by a newer connection" {
		t.Fatalf("first connection error = %#v, want close 4000", err)
	}
	if !hub.Send("alice", []byte(`{"n":1}`)) || readFrame(t, second) != `{"n":1}` {
		t.Error("the newer connection must receive")
	}
}

func TestWSCleanupOnDisconnect(t *testing.T) {
	srv, hub := wsGateway(t)
	c := connect(t, srv, "", user("alice"))
	c.Close()
	deadline := time.Now().Add(2 * time.Second)
	for hub.Send("alice", []byte("x")) {
		if time.Now().After(deadline) {
			t.Fatal("connection still registered after the client left")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWSKeepalivePings(t *testing.T) {
	srv, _ := wsGateway(t, func(h *Hub) { h.pingEvery = 20 * time.Millisecond })
	c := connect(t, srv, "", user("alice"))
	pinged := make(chan struct{}, 1)
	c.SetPingHandler(func(string) error {
		select {
		case pinged <- struct{}{}:
		default:
		}
		return nil
	})
	go func() { c.SetReadDeadline(time.Now().Add(2 * time.Second)); c.ReadMessage() }()
	select {
	case <-pinged:
	case <-time.After(2 * time.Second):
		t.Fatal("no ping received")
	}
}

func TestWSDropsSilentClient(t *testing.T) {
	srv, hub := wsGateway(t, func(h *Hub) { h.pongWait = 50 * time.Millisecond })
	c := connect(t, srv, "", user("alice")) // never reads again, so never answers pings
	_ = c
	deadline := time.Now().Add(2 * time.Second)
	for hub.Send("alice", []byte("x")) {
		if time.Now().After(deadline) {
			t.Fatal("silent connection was not dropped by the read deadline")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWSOtherRoutesUnaffected(t *testing.T) {
	srv, _ := wsGateway(t)
	resp, err := http.Get(srv.URL + "/healthcheck")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("healthcheck: %v %v", resp, err)
	}
	resp.Body.Close()
}

func TestStatusWriterHijack(t *testing.T) {
	var hijacked atomic.Bool
	h := Logging()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Error("wrapped writer must support Hijacker")
			return
		}
		conn, _, err := hj.Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		hijacked.Store(true)
		conn.Close()
	}))
	srv := httptest.NewServer(h)
	defer srv.Close()
	http.Get(srv.URL) // the connection is closed by the handler: an error is expected
	if !hijacked.Load() {
		t.Error("handler did not hijack through the Logging writer")
	}
}
