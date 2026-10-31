package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeStore is an in-memory Store.
type fakeStore struct {
	mu   sync.Mutex
	data map[[3]string]Endpoint
	// indexFails makes the first N EnsureIndex calls fail, like Mongo being down at boot.
	indexFails int
}

func newFakeStore(eps ...Endpoint) *fakeStore {
	s := &fakeStore{data: map[[3]string]Endpoint{}}
	for _, e := range eps {
		s.data[[3]string{string(e.Kind), e.Method, e.Path}] = e
	}
	return s
}

func (s *fakeStore) EnsureIndex(context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.indexFails > 0 {
		s.indexFails--
		return fmt.Errorf("mongo down")
	}
	return nil
}

func (s *fakeStore) List(_ context.Context, kind Kind) ([]Endpoint, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Endpoint
	for _, e := range s.data {
		if kind == "" || e.Kind == kind {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path+out[i].Method < out[j].Path+out[j].Method })
	return out, nil
}

func (s *fakeStore) InsertIfAbsent(_ context.Context, e Endpoint) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := [3]string{string(e.Kind), e.Method, e.Path}
	if _, ok := s.data[k]; ok {
		return false, nil
	}
	s.data[k] = e
	return true, nil
}

func (s *fakeStore) Update(_ context.Context, key Endpoint, p EndpointPatch) (Endpoint, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := [3]string{string(key.Kind), key.Method, key.Path}
	cur, ok := s.data[k]
	if !ok {
		return Endpoint{}, false, nil
	}
	if p.MaxPerMin != nil {
		cur.MaxPerMin = *p.MaxPerMin
	}
	if p.RateLimitBy != nil {
		cur.RateLimitBy = *p.RateLimitBy
	}
	if p.RequireAuth != nil {
		cur.RequireAuth = *p.RequireAuth
	}
	if p.IsPublic != nil {
		cur.IsPublic = *p.IsPublic
	}
	s.data[k] = cur
	return cur, true, nil
}

func (s *fakeStore) Delete(_ context.Context, es []Endpoint) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range es {
		delete(s.data, [3]string{string(e.Kind), e.Method, e.Path})
	}
	return nil
}

// ep builds a public endpoint without rateLimitBy/requireAuth, like an old document that an admin made public.
func ep(kind Kind, method, path string, max int) Endpoint {
	return Endpoint{Kind: kind, Method: method, Path: path, MaxPerMin: max, IsPublic: true}
}

// private returns e with isPublic false, which is also how documents stored before the field existed read.
func private(e Endpoint) Endpoint {
	e.IsPublic = false
	return e
}

func epWith(kind Kind, method, path string, max int, by RateLimitBy, auth bool) Endpoint {
	e := ep(kind, method, path, max)
	e.RateLimitBy, e.RequireAuth = by, auth
	return e
}

// fakeDiscoverer answers /consult with the hosts of each kind in order (the last one repeats).
func fakeDiscoverer(t *testing.T, hosts map[string][]string) (*httptest.Server, *int) {
	var mu sync.Mutex
	calls := 0
	idx := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		kind := r.URL.Query().Get("kind")
		hs := hosts[kind]
		if len(hs) == 0 {
			http.Error(w, "none", http.StatusServiceUnavailable)
			return
		}
		i := idx[kind]
		if i >= len(hs) {
			i = len(hs) - 1
		}
		idx[kind]++
		json.NewEncoder(w).Encode(map[string]string{"host": hs[i]})
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func hostOf(srv *httptest.Server) string { return strings.TrimPrefix(srv.URL, "http://") }

func TestMatchLiteralBeatsParam(t *testing.T) {
	eps := []Endpoint{
		ep(User, "GET", "/users/{id}", 1),
		ep(User, "GET", "/users/me", 2),
		ep(User, "GET", "/users/{id}/orders", 3),
		ep(User, "POST", "/users/{id}", 4),
		ep(User, "GET", "/{a}/{b}", 5),
	}
	cases := []struct {
		method, path string
		want         int
		ok           bool
	}{
		{"GET", "/users/me", 2, true},
		{"GET", "/users/42", 1, true},
		{"GET", "/users/42/orders", 3, true},
		{"POST", "/users/42", 4, true},
		{"GET", "/other/x", 5, true},
		{"DELETE", "/users/42", 0, false},
		{"GET", "/users/42/orders/9", 0, false},
		{"GET", "/users/", 0, false},
	}
	for _, c := range cases {
		got, ok := matchPath(eps, c.method, c.path)
		if ok != c.ok || (ok && got.MaxPerMin != c.want) {
			t.Errorf("%s %s: got %+v ok=%v, want max=%d ok=%v", c.method, c.path, got, ok, c.want, c.ok)
		}
	}
}

func TestSplitKind(t *testing.T) {
	for in, want := range map[string][2]string{
		"/payments/charge/1": {"payments", "/charge/1"},
		"/payments":          {"payments", "/"},
		"/payments/":         {"payments", "/"},
	} {
		k, rest := splitKind(in)
		if string(k) != want[0] || rest != want[1] {
			t.Errorf("%q: got %q %q", in, k, rest)
		}
	}
}

func TestParseOpenAPI(t *testing.T) {
	spec := `{"openapi":"3.0.0","paths":{
		"/users/{id}":{"get":{},"delete":{},"parameters":[{"name":"id"}],"summary":"x"},
		"/users":{"post":{},"$ref":"#/x"}}}`
	got, err := parseOpenAPI(strings.NewReader(spec))
	if err != nil {
		t.Fatal(err)
	}
	var s []string
	for _, e := range got {
		s = append(s, e.Method+" "+e.Path)
	}
	want := "POST /users,DELETE /users/{id},GET /users/{id}"
	if strings.Join(s, ",") != want {
		t.Errorf("got %v want %s", s, want)
	}
	if _, err := parseOpenAPI(strings.NewReader(`{"openapi":"3.0.0"}`)); err == nil {
		t.Error("spec without paths should fail")
	}
	if _, err := parseOpenAPI(strings.NewReader(`nope`)); err == nil {
		t.Error("invalid json should fail")
	}
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func TestLimiter(t *testing.T) {
	c := &clock{t: time.Unix(1000, 0)}
	l := NewLimiter(c.now)
	k := limitKey{id: "u:a", kind: User, method: "GET", path: "/x"}
	for i := 0; i < 2; i++ {
		if ok, _ := l.Allow(k, 2); !ok {
			t.Fatalf("request %d should pass", i)
		}
	}
	if ok, retry := l.Allow(k, 2); ok || retry != time.Minute {
		t.Errorf("third should fail with retry 1m, got ok=%v retry=%v", ok, retry)
	}
	other := k
	other.id = "u:b"
	if ok, _ := l.Allow(other, 2); !ok {
		t.Error("other user must be isolated")
	}
	c.add(30 * time.Second)
	if ok, retry := l.Allow(k, 2); ok || retry != 30*time.Second {
		t.Errorf("still blocked mid-window, got ok=%v retry=%v", ok, retry)
	}
	c.add(30 * time.Second)
	if ok, _ := l.Allow(k, 2); !ok {
		t.Error("window should have reset")
	}
	if ok, _ := l.Allow(limitKey{id: "z"}, 0); ok {
		t.Error("max 0 blocks everything")
	}
	c.add(2 * time.Minute)
	l.Cleanup()
	if len(l.windows) != 0 {
		t.Errorf("expired windows should be cleaned, have %d", len(l.windows))
	}
}

func TestRateLimitMiddleware(t *testing.T) {
	c := &clock{t: time.Unix(1000, 0)}
	l := NewLimiter(c.now)
	eps := NewEndpoints(newFakeStore(ep(User, "GET", "/x", 1)))
	eps.Refresh(context.Background())
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }), Resolve(eps), RateLimit(l, nil))
	do := func(user string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/user/x", nil)
		if user != "" {
			r.Header.Set("X-User-Id", user)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := do("u"); w.Code != 204 {
		t.Errorf("first: %d", w.Code)
	}
	w := do("u")
	if w.Code != 429 || w.Header().Get("Retry-After") != "60" {
		t.Errorf("second: %d retry-after=%q", w.Code, w.Header().Get("Retry-After"))
	}
	if w := do("v"); w.Code != 204 {
		t.Errorf("other user: %d", w.Code)
	}
	if w := do(""); w.Code != 204 {
		t.Errorf("anonymous must not get 401 from the limiter: %d", w.Code)
	}
}

// modeHandler builds Resolve+Auth+RateLimit around one endpoint and returns a caller (user, remote ip) -> status.
func modeHandler(e Endpoint, tp TrustedProxies) func(user, ip string) int {
	eps := NewEndpoints(newFakeStore(e))
	eps.Refresh(context.Background())
	l := NewLimiter(time.Now)
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }),
		Resolve(eps), Auth(), RateLimit(l, tp))
	return func(user, ip string) int {
		r := httptest.NewRequest("GET", "/user/x", nil)
		r.RemoteAddr = ip + ":4000"
		if user != "" {
			r.Header.Set("X-User-Id", user)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
}

func TestRateLimitModes(t *testing.T) {
	t.Run("user_or_ip is the default", func(t *testing.T) {
		do := modeHandler(ep(User, "GET", "/x", 1), nil) // no rateLimitBy stored
		if do("a", "1.1.1.1") != 204 || do("a", "2.2.2.2") != 429 {
			t.Error("same user must share a budget across IPs")
		}
		if do("b", "1.1.1.1") != 204 {
			t.Error("users must be isolated")
		}
		if do("", "3.3.3.3") != 204 || do("", "3.3.3.3") != 429 {
			t.Error("anonymous callers from the same IP share a budget")
		}
		if do("", "4.4.4.4") != 204 {
			t.Error("different IPs must be isolated")
		}
		if do("3.3.3.3", "9.9.9.9") != 204 {
			t.Error("a user id must not collide with an IP key")
		}
	})
	t.Run("ip", func(t *testing.T) {
		do := modeHandler(epWith(User, "GET", "/x", 2, RateLimitIP, false), nil)
		for i, u := range []string{"a", "b", ""} {
			want := 204
			if i == 2 {
				want = 429
			}
			if got := do(u, "1.1.1.1"); got != want {
				t.Errorf("call %d (user %q): got %d want %d", i, u, got, want)
			}
		}
		if do("a", "2.2.2.2") != 204 {
			t.Error("other IP must have its own budget")
		}
	})
	t.Run("global", func(t *testing.T) {
		do := modeHandler(epWith(User, "GET", "/x", 2, RateLimitGlobal, false), nil)
		if do("a", "1.1.1.1") != 204 || do("b", "2.2.2.2") != 204 || do("", "3.3.3.3") != 429 {
			t.Error("budget must be shared across users and IPs")
		}
	})
}

func TestAuthMiddleware(t *testing.T) {
	c := &clock{t: time.Unix(1000, 0)}
	l := NewLimiter(c.now)
	eps := NewEndpoints(newFakeStore(
		epWith(User, "GET", "/secure", 1, RateLimitGlobal, true),
		epWith(User, "GET", "/open", 5, RateLimitGlobal, false)))
	eps.Refresh(context.Background())
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }),
		Resolve(eps), Auth(), RateLimit(l, nil))
	do := func(path, user string) int {
		r := httptest.NewRequest("GET", path, nil)
		if user != "" {
			r.Header.Set("X-User-Id", user)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if do("/user/open", "") != 204 || do("/user/open", "u") != 204 {
		t.Error("requireAuth=false must pass with and without header")
	}
	// Unauthenticated calls are rejected before the limiter: they must not eat the budget of 1.
	for i := 0; i < 3; i++ {
		if got := do("/user/secure", ""); got != 401 {
			t.Fatalf("no header: got %d want 401", got)
		}
	}
	if got := do("/user/secure", "u"); got != 204 {
		t.Errorf("with header: got %d want 204 (budget consumed by 401s?)", got)
	}
	if got := do("/user/secure", "u"); got != 429 {
		t.Errorf("second authenticated call: got %d want 429", got)
	}
}

func TestClientIP(t *testing.T) {
	tp, err := ParseTrustedProxies("10.0.0.1, 192.168.0.0/16,fd00::/8")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, remote, xff string
		trusted           TrustedProxies
		want              string
	}{
		{"no proxies, forged xff ignored", "8.8.8.8:1234", "1.2.3.4", nil, "8.8.8.8"},
		{"untrusted remote, forged xff ignored", "8.8.8.8:1234", "1.2.3.4", tp, "8.8.8.8"},
		{"trusted remote, rightmost untrusted", "10.0.0.1:1", "6.6.6.6, 1.2.3.4, 10.0.0.1", tp, "1.2.3.4"},
		{"forged leftmost is skipped", "10.0.0.1:1", "6.6.6.6, 1.2.3.4", tp, "1.2.3.4"},
		{"cidr entries", "192.168.5.5:1", "7.7.7.7, 192.168.1.1", tp, "7.7.7.7"},
		{"ipv6 cidr", "[fd00::1]:1", "2001:db8::5", tp, "2001:db8::5"},
		{"trusted remote, no xff", "10.0.0.1:1", "", tp, "10.0.0.1"},
		{"all trusted", "10.0.0.1:1", "10.0.0.1, 192.168.1.1", tp, "10.0.0.1"},
		{"invalid xff falls back", "10.0.0.1:1", "1.2.3.4, garbage", tp, "10.0.0.1"},
		{"remote without port", "8.8.4.4", "", nil, "8.8.4.4"},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.remote
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := ClientIP(r, c.trusted); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
	for _, bad := range []string{"nope", "10.0.0.0/99", "1.2.3"} {
		if _, err := ParseTrustedProxies(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
	if tp, err := ParseTrustedProxies(""); err != nil || len(tp) != 0 {
		t.Errorf("empty: %v %v", tp, err)
	}
}

func TestRateLimitIPBehindTrustedProxy(t *testing.T) {
	tp, _ := ParseTrustedProxies("10.0.0.1")
	eps := NewEndpoints(newFakeStore(epWith(User, "GET", "/x", 1, RateLimitIP, false)))
	eps.Refresh(context.Background())
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }),
		Resolve(eps), RateLimit(NewLimiter(time.Now), tp))
	do := func(remote, xff string) int {
		r := httptest.NewRequest("GET", "/user/x", nil)
		r.RemoteAddr = remote
		r.Header.Set("X-Forwarded-For", xff)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if do("10.0.0.1:1", "5.5.5.5") != 204 || do("10.0.0.1:1", "6.6.6.6") != 204 || do("10.0.0.1:1", "5.5.5.5") != 429 {
		t.Error("clients behind the trusted proxy must be told apart by X-Forwarded-For")
	}
	// An untrusted peer cannot dodge the limit by forging X-Forwarded-For.
	if do("8.8.8.8:1", "1.1.1.1") != 204 || do("8.8.8.8:1", "2.2.2.2") != 429 {
		t.Error("forged X-Forwarded-For from an untrusted peer must be ignored")
	}
}

func TestChainOrder(t *testing.T) {
	var order []string
	mk := func(name string) Middleware {
		return func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				order = append(order, name)
				next.ServeHTTP(w, r)
			})
		}
	}
	h := Chain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { order = append(order, "end") }), mk("a"), mk("b"), mk("c"))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	if strings.Join(order, ",") != "a,b,c,end" {
		t.Errorf("order: %v", order)
	}
}

func TestDefaultHeaders(t *testing.T) {
	var got http.Header
	h := Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got = r.Header }), DefaultHeaders())

	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.1.2.3:5555"
	r.Host = "gw.example"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	id := got.Get("X-Request-Id")
	if len(id) != 32 || w.Header().Get("X-Request-Id") != id {
		t.Errorf("request id %q, response %q", id, w.Header().Get("X-Request-Id"))
	}
	if got.Get("X-Forwarded-For") != "10.1.2.3" || got.Get("X-Forwarded-Host") != "gw.example" || got.Get("X-Gateway") != "gateway" {
		t.Errorf("headers: %v", got)
	}

	r = httptest.NewRequest("GET", "/", nil)
	r.Header.Set("X-Request-Id", "abc")
	r.Header.Set("X-Forwarded-For", "1.1.1.1")
	r.Header.Set("X-Forwarded-Host", "ui.example")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if got.Get("X-Request-Id") != "abc" || w.Header().Get("X-Request-Id") != "abc" ||
		got.Get("X-Forwarded-For") != "1.1.1.1" || got.Get("X-Forwarded-Host") != "ui.example" {
		t.Errorf("incoming values not kept: %v", got)
	}
}

func newGateway(t *testing.T, store Store, disc *Discovery) (*httptest.Server, *Endpoints) {
	eps := NewEndpoints(store)
	if err := eps.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	l := NewLimiter(time.Now)
	srv := httptest.NewServer(newMux(store, eps, NewPipeline(eps, l, nil, NewProxy(disc))))
	t.Cleanup(srv.Close)
	return srv, eps
}

func get(t *testing.T, method, url, body string, hdr map[string]string) (*http.Response, string) {
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func TestProxyStripsPrefix(t *testing.T) {
	var gotPath, gotQuery, gotBody, gotMethod, gotUser, gotGW string
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotPath, gotQuery, gotBody, gotMethod = r.URL.Path, r.URL.RawQuery, string(b), r.Method
		gotUser, gotGW = r.Header.Get("X-User-Id"), r.Header.Get("X-Gateway")
		w.WriteHeader(201)
		fmt.Fprint(w, "ok")
	}))
	defer down.Close()
	ds, _ := fakeDiscoverer(t, map[string][]string{"payments": {hostOf(down)}})
	gw, _ := newGateway(t, newFakeStore(ep(Payments, "POST", "/charge/{id}", 10)), NewDiscovery(ds.URL))
	h := map[string]string{"X-User-Id": "u1"}

	resp, body := get(t, "POST", gw.URL+"/payments/charge/7?a=1&b=x", "hello", h)
	if resp.StatusCode != 201 || body != "ok" || gotPath != "/charge/7" || gotQuery != "a=1&b=x" ||
		gotBody != "hello" || gotMethod != "POST" || gotUser != "u1" || gotGW != "gateway" {
		t.Errorf("status=%d body=%q path=%q query=%q down body=%q method=%q user=%q gw=%q",
			resp.StatusCode, body, gotPath, gotQuery, gotBody, gotMethod, gotUser, gotGW)
	}
	if resp.Header.Get("X-Request-Id") == "" {
		t.Error("response should echo X-Request-Id")
	}
	if resp, _ := get(t, "GET", gw.URL+"/payments/charge/7", "", h); resp.StatusCode != 404 {
		t.Errorf("method not registered: %d", resp.StatusCode)
	}
	if resp, _ := get(t, "GET", gw.URL+"/nope/x", "", h); resp.StatusCode != 404 {
		t.Errorf("unknown kind: %d", resp.StatusCode)
	}
	if resp, _ := get(t, "GET", gw.URL+"/healthcheck", "", nil); resp.StatusCode != 200 {
		t.Errorf("healthcheck: %d", resp.StatusCode)
	}
}

func TestProxyNoInstance(t *testing.T) {
	ds, _ := fakeDiscoverer(t, nil)
	gw, _ := newGateway(t, newFakeStore(ep(Payments, "GET", "/x", 10)), NewDiscovery(ds.URL))
	if resp, _ := get(t, "GET", gw.URL+"/payments/x", "", map[string]string{"X-User-Id": "u"}); resp.StatusCode != 503 {
		t.Errorf("want 503, got %d", resp.StatusCode)
	}
}

func TestProxyRediscoversOnDialFailure(t *testing.T) {
	var gotBody string
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		fmt.Fprint(w, "alive")
	}))
	defer down.Close()
	dead := httptest.NewServer(http.NotFoundHandler())
	deadHost := hostOf(dead)
	dead.Close() // nothing listens there any more

	ds, calls := fakeDiscoverer(t, map[string][]string{"payments": {deadHost, hostOf(down)}})
	gw, _ := newGateway(t, newFakeStore(ep(Payments, "POST", "/x", 10)), NewDiscovery(ds.URL))
	h := map[string]string{"X-User-Id": "u"}

	resp, body := get(t, "POST", gw.URL+"/payments/x", "payload", h)
	if resp.StatusCode != 200 || body != "alive" || gotBody != "payload" {
		t.Errorf("status=%d body=%q downstream body=%q", resp.StatusCode, body, gotBody)
	}
	if *calls != 2 {
		t.Errorf("want 2 consults, got %d", *calls)
	}
	// the new host is cached now
	get(t, "POST", gw.URL+"/payments/x", "again", h)
	if *calls != 2 {
		t.Errorf("host should be cached, consults=%d", *calls)
	}
}

func TestAdmin(t *testing.T) {
	store := newFakeStore(ep(User, "GET", "/users/{id}", 60), ep(Payments, "GET", "/p", 60))
	ds, _ := fakeDiscoverer(t, nil)
	gw, eps := newGateway(t, store, NewDiscovery(ds.URL))
	put := func(body string) (*http.Response, string) {
		return get(t, "PUT", gw.URL+"/admin/endpoints", body, nil)
	}

	for _, b := range []string{`nope`, `{"kind":"user","method":"GET","path":"/users/{id}"}`, `{"kind":"user","method":"GET","path":"/users/{id}","rateLimitBy":"bogus"}`,
		`{"kind":"user","method":"GET","path":"/users/{id}","rateLimitBy":""}`, `{"kind":"user","path":"/users/{id}","maxPerMin":1}`,
		`{"kind":"user","method":"GET","maxPerMin":1}`, `{"method":"GET","path":"/users/{id}","maxPerMin":1}`,
		`{"kind":"user","method":"GET","path":"/users/{id}","maxPerMin":-1}`,
		`{"kind":"bogus","method":"GET","path":"/x","maxPerMin":1}`,
		`{"kind":"user","method":"","path":"/x","maxPerMin":1}`} {
		if resp, _ := put(b); resp.StatusCode != 400 {
			t.Errorf("%s: want 400, got %d", b, resp.StatusCode)
		}
	}
	if resp, _ := put(`{"kind":"user","method":"GET","path":"/other","maxPerMin":5}`); resp.StatusCode != 404 {
		t.Errorf("want 404, got %d", resp.StatusCode)
	}
	resp, body := put(`{"kind":"user","method":"get","path":"/users/{id}","maxPerMin":0}`)
	var got Endpoint
	json.Unmarshal([]byte(body), &got)
	if resp.StatusCode != 200 || got != epWith(User, "GET", "/users/{id}", 0, RateLimitUserOrIP, false) {
		t.Errorf("PUT: %d %s", resp.StatusCode, body)
	}
	if m, _ := eps.Match(User, "GET", "/users/1"); m.MaxPerMin != 0 {
		t.Error("cache not refreshed after PUT")
	}
	// maxPerMin 0 blocks the endpoint
	if resp, _ := get(t, "GET", gw.URL+"/user/users/1", "", map[string]string{"X-User-Id": "u"}); resp.StatusCode != 429 {
		t.Errorf("want 429 for maxPerMin 0, got %d", resp.StatusCode)
	}

	_, body = get(t, "GET", gw.URL+"/admin/endpoints?kind=payments", "", nil)
	var list []Endpoint
	json.Unmarshal([]byte(body), &list)
	if len(list) != 1 || list[0].Kind != Payments {
		t.Errorf("list: %s", body)
	}
}

func TestAdminPartialUpdate(t *testing.T) {
	store := newFakeStore(ep(User, "GET", "/users/{id}", 60), ep(Payments, "POST", "/charge", 60))
	ds, _ := fakeDiscoverer(t, nil)
	gw, eps := newGateway(t, store, NewDiscovery(ds.URL))
	put := func(body string) (*http.Response, Endpoint) {
		resp, b := get(t, "PUT", gw.URL+"/admin/endpoints", body, nil)
		var e Endpoint
		json.Unmarshal([]byte(b), &e)
		return resp, e
	}
	id := `"kind":"user","method":"get","path":"/users/{id}"`

	resp, e := put(`{` + id + `,"requireAuth":true}`)
	if resp.StatusCode != 200 || e != epWith(User, "GET", "/users/{id}", 60, RateLimitUserOrIP, true) {
		t.Errorf("only requireAuth: %d %+v", resp.StatusCode, e)
	}
	resp, e = put(`{` + id + `,"rateLimitBy":"ip"}`)
	if resp.StatusCode != 200 || e != epWith(User, "GET", "/users/{id}", 60, RateLimitIP, true) {
		t.Errorf("only rateLimitBy must keep requireAuth: %d %+v", resp.StatusCode, e)
	}
	resp, e = put(`{` + id + `,"requireAuth":false}`)
	if resp.StatusCode != 200 || e != epWith(User, "GET", "/users/{id}", 60, RateLimitIP, false) {
		t.Errorf("explicit false must be applied: %d %+v", resp.StatusCode, e)
	}
	resp, e = put(`{` + id + `,"maxPerMin":3,"rateLimitBy":"global","requireAuth":true}`)
	if resp.StatusCode != 200 || e != epWith(User, "GET", "/users/{id}", 3, RateLimitGlobal, true) {
		t.Errorf("all fields: %d %+v", resp.StatusCode, e)
	}
	if m, _ := eps.Match(User, "GET", "/users/1"); m != e {
		t.Errorf("cache not refreshed: %+v", m)
	}
	if other, _ := store.List(context.Background(), Payments); other[0] != ep(Payments, "POST", "/charge", 60) {
		t.Errorf("other endpoint touched: %+v", other[0])
	}
	if resp, _ := put(`{` + id + `,"rateLimitBy":"bogus"}`); resp.StatusCode != 400 {
		t.Errorf("invalid enum: %d", resp.StatusCode)
	}
	if resp, _ := put(`{` + id + `}`); resp.StatusCode != 400 {
		t.Errorf("empty patch: %d", resp.StatusCode)
	}
	if resp, _ := put(`{"kind":"user","method":"GET","path":"/nope","requireAuth":true}`); resp.StatusCode != 404 {
		t.Errorf("unregistered: %d", resp.StatusCode)
	}
}

func TestMissingFieldsReadAsDefaults(t *testing.T) {
	store := newFakeStore(private(ep(User, "GET", "/old", 5))) // stored by an earlier version
	ds, _ := fakeDiscoverer(t, nil)
	gw, eps := newGateway(t, store, NewDiscovery(ds.URL))
	_, body := get(t, "GET", gw.URL+"/admin/endpoints", "", nil)
	var list []Endpoint
	json.Unmarshal([]byte(body), &list)
	if len(list) != 1 || list[0].RateLimitBy != RateLimitUserOrIP || list[0].RequireAuth || list[0].IsPublic {
		t.Errorf("list: %s", body)
	}
	if !strings.Contains(body, `"rateLimitBy":"user_or_ip"`) || !strings.Contains(body, `"requireAuth":false`) ||
		!strings.Contains(body, `"isPublic":false`) {
		t.Errorf("defaults must be in the output: %s", body)
	}
	if c := eps.byKind[User]; len(c) != 1 || c[0].RateLimitBy != RateLimitUserOrIP || c[0].IsPublic {
		t.Errorf("cache (must keep private endpoints): %+v", c)
	}
	if _, ok := eps.Match(User, "GET", "/old"); ok {
		t.Error("legacy doc without isPublic must be private")
	}
}

func openAPIServer(t *testing.T, spec string, status int) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/openapi.json" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(status)
		fmt.Fprint(w, spec)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSyncDoesNotOverwriteMax(t *testing.T) {
	svc := openAPIServer(t, `{"paths":{"/a":{"get":{}},"/b":{"post":{}}}}`, 200)
	ds, _ := fakeDiscoverer(t, map[string][]string{"events": {hostOf(svc)}})
	store := newFakeStore(ep(Events, "GET", "/a", 7))
	eps := NewEndpoints(store)
	s := NewSyncer(NewDiscovery(ds.URL), store, eps, 60)

	added, removed, err := s.SyncKind(context.Background(), Events)
	if err != nil || added != 1 || removed != 0 {
		t.Fatalf("added=%d removed=%d err=%v", added, removed, err)
	}
	list, _ := store.List(context.Background(), Events)
	if len(list) != 2 || list[0].MaxPerMin != 7 || list[1].MaxPerMin != 60 {
		t.Errorf("unexpected store: %+v", list)
	}
	if list[1].RateLimitBy != RateLimitUserOrIP || list[1].RequireAuth || list[1].IsPublic {
		t.Errorf("new endpoint must get the defaults (private): %+v", list[1])
	}
}

func TestSyncKeepsExistingAuthSettings(t *testing.T) {
	svc := openAPIServer(t, `{"paths":{"/a":{"get":{}}}}`, 200)
	ds, _ := fakeDiscoverer(t, map[string][]string{"events": {hostOf(svc)}})
	store := newFakeStore(epWith(Events, "GET", "/a", 7, RateLimitGlobal, true))
	s := NewSyncer(NewDiscovery(ds.URL), store, NewEndpoints(store), 60)
	if added, removed, err := s.SyncKind(context.Background(), Events); err != nil || added != 0 || removed != 0 {
		t.Fatalf("added=%d removed=%d err=%v", added, removed, err)
	}
	list, _ := store.List(context.Background(), Events)
	if list[0] != epWith(Events, "GET", "/a", 7, RateLimitGlobal, true) {
		t.Errorf("existing values overwritten: %+v", list[0])
	}
}

func TestSyncKeepsExistingIsPublic(t *testing.T) {
	svc := openAPIServer(t, `{"paths":{"/a":{"get":{}}}}`, 200)
	ds, _ := fakeDiscoverer(t, map[string][]string{"events": {hostOf(svc)}})
	store := newFakeStore(ep(Events, "GET", "/a", 7)) // public
	s := NewSyncer(NewDiscovery(ds.URL), store, NewEndpoints(store), 60)
	if _, _, err := s.SyncKind(context.Background(), Events); err != nil {
		t.Fatal(err)
	}
	if list, _ := store.List(context.Background(), Events); !list[0].IsPublic {
		t.Errorf("sync overwrote isPublic: %+v", list[0])
	}
}

func TestSyncRemovesStaleOnlyOnSuccess(t *testing.T) {
	good := openAPIServer(t, `{"paths":{"/keep":{"get":{}}}}`, 200)
	bad := openAPIServer(t, `garbage`, 200)
	down := openAPIServer(t, ``, 500)
	ds, _ := fakeDiscoverer(t, map[string][]string{
		"events": {hostOf(good)}, "payments": {hostOf(bad)}, "user": {hostOf(down)}, // reports: no instance
	})
	store := newFakeStore(
		ep(Events, "GET", "/keep", 1), ep(Events, "GET", "/gone", 1),
		ep(Payments, "GET", "/old", 1), ep(User, "GET", "/old", 1), ep(Reports, "GET", "/old", 1))
	s := NewSyncer(NewDiscovery(ds.URL), store, NewEndpoints(store), 60)
	ctx := context.Background()

	if _, removed, err := s.SyncKind(ctx, Events); err != nil || removed != 1 {
		t.Errorf("events: removed=%d err=%v", removed, err)
	}
	for _, k := range []Kind{Payments, User, Reports} {
		if _, _, err := s.SyncKind(ctx, k); err == nil {
			t.Errorf("%s should fail", k)
		}
	}
	all, _ := store.List(ctx, "")
	var names []string
	for _, e := range all {
		names = append(names, string(e.Kind)+e.Path)
	}
	sort.Strings(names)
	want := "events/keep,payments/old,reports/old,user/old"
	if strings.Join(names, ",") != want {
		t.Errorf("got %v want %s", names, want)
	}
}

func TestSyncRunRetriesFailedKinds(t *testing.T) {
	var mu sync.Mutex
	attempts := 0
	svc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		attempts++
		n := attempts
		mu.Unlock()
		if n == 1 {
			http.Error(w, "boom", 500)
			return
		}
		fmt.Fprint(w, `{"paths":{"/a":{"get":{}}}}`)
	}))
	defer svc.Close()
	hosts := map[string][]string{}
	for _, k := range allKinds {
		hosts[string(k)] = []string{hostOf(svc)}
	}
	ds, _ := fakeDiscoverer(t, hosts)
	store := newFakeStore()
	s := NewSyncer(NewDiscovery(ds.URL), store, NewEndpoints(store), 60)
	s.minDelay, s.maxDelay = time.Millisecond, 2*time.Millisecond

	done := make(chan struct{})
	go func() { s.Run(context.Background()); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not finish")
	}
	all, _ := store.List(context.Background(), "")
	if len(all) != len(allKinds) {
		t.Errorf("want one endpoint per kind, got %d", len(all))
	}
}

func TestSyncRunRecoversWhenStoreComesUpLater(t *testing.T) {
	svc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"paths":{"/a":{"get":{}}}}`)
	}))
	defer svc.Close()
	hosts := map[string][]string{}
	for _, k := range allKinds {
		hosts[string(k)] = []string{hostOf(svc)}
	}
	ds, _ := fakeDiscoverer(t, hosts)
	store := newFakeStore()
	store.indexFails = 2
	s := NewSyncer(NewDiscovery(ds.URL), store, NewEndpoints(store), 60)
	s.minDelay, s.maxDelay = time.Millisecond, 2*time.Millisecond

	done := make(chan struct{})
	go func() { s.Run(context.Background()); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not recover after the store came up")
	}
	all, _ := store.List(context.Background(), "")
	if len(all) != len(allKinds) {
		t.Errorf("want one endpoint per kind, got %d", len(all))
	}
}

func TestLoggingKeepsFlusher(t *testing.T) {
	var flushed bool
	h := Logging()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
			flushed = true
		}
		w.WriteHeader(418)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/user/x", nil))
	if !flushed {
		t.Error("wrapped writer must support Flusher")
	}
}

func TestCors(t *testing.T) {
	hits := 0
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Access-Control-Allow-Origin", "https://downstream.example")
		w.Header().Set("Access-Control-Allow-Credentials", "false")
		fmt.Fprint(w, "ok")
	}))
	defer down.Close()
	ds, _ := fakeDiscoverer(t, map[string][]string{"payments": {hostOf(down)}})
	gw, _ := newGateway(t, newFakeStore(ep(Payments, "GET", "/x", 10), epWith(Payments, "GET", "/secure", 10, RateLimitUserOrIP, true)), NewDiscovery(ds.URL))
	origin := map[string]string{"Origin": "https://ui.example"}
	withUser := map[string]string{"Origin": "https://ui.example", "X-User-Id": "u1"}

	checkAllow := func(name string, resp *http.Response) {
		t.Helper()
		if v := resp.Header.Values("Access-Control-Allow-Origin"); len(v) != 1 || v[0] != "https://ui.example" {
			t.Errorf("%s: Allow-Origin = %v", name, v)
		}
		if v := resp.Header.Values("Access-Control-Allow-Credentials"); len(v) != 1 || v[0] != "true" {
			t.Errorf("%s: Allow-Credentials = %v", name, v)
		}
		if resp.Header.Get("Access-Control-Expose-Headers") != "X-Request-Id" {
			t.Errorf("%s: Expose-Headers = %q", name, resp.Header.Get("Access-Control-Expose-Headers"))
		}
	}

	// Preflight: 204, no X-User-Id, never reaches the downstream.
	resp, _ := get(t, "OPTIONS", gw.URL+"/payments/x", "", map[string]string{
		"Origin": "https://ui.example", "Access-Control-Request-Method": "POST",
		"Access-Control-Request-Headers": "content-type,x-user-id",
	})
	if resp.StatusCode != 204 || hits != 0 {
		t.Errorf("preflight: status=%d downstream hits=%d", resp.StatusCode, hits)
	}
	for k, want := range map[string]string{
		"Access-Control-Allow-Origin":      "https://ui.example",
		"Access-Control-Allow-Credentials": "true",
		"Access-Control-Allow-Headers":     "content-type,x-user-id",
		"Access-Control-Allow-Methods":     "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
		"Access-Control-Max-Age":           "86400",
	} {
		if got := resp.Header.Get(k); got != want {
			t.Errorf("preflight %s = %q, want %q", k, got, want)
		}
	}
	// Preflight on a route the gateway does not know is still answered.
	if resp, _ := get(t, "OPTIONS", gw.URL+"/nope/x", "", map[string]string{
		"Origin": "https://ui.example", "Access-Control-Request-Method": "GET"}); resp.StatusCode != 204 {
		t.Errorf("preflight unknown route: %d", resp.StatusCode)
	}

	// Proxied response: gateway values only, downstream's are dropped.
	resp, _ = get(t, "GET", gw.URL+"/payments/x", "", withUser)
	if resp.StatusCode != 200 || hits != 1 {
		t.Errorf("proxied: status=%d hits=%d", resp.StatusCode, hits)
	}
	checkAllow("proxied", resp)

	// Rejections and non-proxied routes.
	resp, _ = get(t, "GET", gw.URL+"/nope/x", "", withUser)
	if resp.StatusCode != 404 {
		t.Errorf("unknown route: %d", resp.StatusCode)
	}
	checkAllow("404", resp)
	resp, _ = get(t, "GET", gw.URL+"/payments/secure", "", origin)
	if resp.StatusCode != 401 {
		t.Errorf("missing user: %d", resp.StatusCode)
	}
	checkAllow("401", resp)
	resp, _ = get(t, "GET", gw.URL+"/admin/endpoints", "", origin)
	if resp.StatusCode != 200 {
		t.Errorf("admin: %d", resp.StatusCode)
	}
	checkAllow("admin", resp)
	resp, _ = get(t, "GET", gw.URL+"/healthcheck", "", origin)
	checkAllow("healthcheck", resp)

	// No Origin: no CORS headers.
	resp, _ = get(t, "GET", gw.URL+"/payments/x", "", map[string]string{"X-User-Id": "u1"})
	if v := resp.Header.Get("Access-Control-Allow-Origin"); v != "" {
		t.Errorf("no Origin but Allow-Origin = %q", v)
	}
}

func TestPrivateEndpoints(t *testing.T) {
	var hits int32
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		fmt.Fprint(w, "down:"+r.URL.Path)
	}))
	defer down.Close()
	ds, _ := fakeDiscoverer(t, map[string][]string{"user": {hostOf(down)}})
	store := newFakeStore(
		private(ep(User, "GET", "/users/me", 1)),
		ep(User, "GET", "/users/{id}", 60),
		private(ep(User, "POST", "/users/me", 1)),
		private(ep(User, "GET", "/secret", 1)),
		private(ep(User, "GET", "/files/{name}", 60)),
		ep(User, "GET", "/files/public", 60))
	gw, _ := newGateway(t, store, NewDiscovery(ds.URL))
	h := map[string]string{"X-User-Id": "u1"}

	ref, refBody := get(t, "GET", gw.URL+"/user/nothing-here", "", h)
	resp, body := get(t, "GET", gw.URL+"/user/secret", "", h)
	if resp.StatusCode != 404 || ref.StatusCode != 404 || body != refBody ||
		resp.Header.Get("Content-Type") != ref.Header.Get("Content-Type") {
		t.Errorf("private must look like a missing endpoint: %d %q vs %d %q", resp.StatusCode, body, ref.StatusCode, refBody)
	}
	// maxPerMin is 1: private calls must answer 404 every time, never 429, since they consume no budget.
	for i := 0; i < 3; i++ {
		if resp, _ := get(t, "GET", gw.URL+"/user/secret", "", h); resp.StatusCode != 404 {
			t.Fatalf("call %d: %d", i, resp.StatusCode)
		}
	}
	if n := atomic.LoadInt32(&hits); n != 0 {
		t.Fatalf("downstream hit %d times for private endpoints", n)
	}

	// Shadowing: the private literal wins the match, so /users/me is 404 and does not fall through to /users/{id}.
	if resp, _ := get(t, "GET", gw.URL+"/user/users/me", "", h); resp.StatusCode != 404 {
		t.Errorf("/users/me: %d", resp.StatusCode)
	}
	if resp, body := get(t, "GET", gw.URL+"/user/users/42", "", h); resp.StatusCode != 200 || body != "down:/users/42" {
		t.Errorf("/users/42: %d %q", resp.StatusCode, body)
	}
	// A private wildcard does not hide its public literal sibling.
	if resp, body := get(t, "GET", gw.URL+"/user/files/public", "", h); resp.StatusCode != 200 || body != "down:/files/public" {
		t.Errorf("/files/public: %d %q", resp.StatusCode, body)
	}
	if resp, _ := get(t, "GET", gw.URL+"/user/files/other", "", h); resp.StatusCode != 404 {
		t.Errorf("/files/other: %d", resp.StatusCode)
	}
	if n := atomic.LoadInt32(&hits); n != 2 {
		t.Errorf("downstream hits: %d want 2", n)
	}
}

func TestPrivateMethodIsolation(t *testing.T) {
	eps := NewEndpoints(newFakeStore(private(ep(User, "POST", "/users/me", 1)), ep(User, "GET", "/users/me", 1)))
	eps.Refresh(context.Background())
	if _, ok := eps.Match(User, "GET", "/users/me"); !ok {
		t.Error("private POST must not block public GET")
	}
	if _, ok := eps.Match(User, "POST", "/users/me"); ok {
		t.Error("private POST must be not found")
	}
}

func TestAdminPutIsPublic(t *testing.T) {
	store := newFakeStore(private(ep(User, "GET", "/users/{id}", 60)))
	ds, _ := fakeDiscoverer(t, nil)
	gw, eps := newGateway(t, store, NewDiscovery(ds.URL))
	put := func(body string) (*http.Response, Endpoint) {
		resp, b := get(t, "PUT", gw.URL+"/admin/endpoints", body, nil)
		var e Endpoint
		json.Unmarshal([]byte(b), &e)
		return resp, e
	}
	id := `"kind":"user","method":"GET","path":"/users/{id}"`
	if _, ok := eps.Match(User, "GET", "/users/1"); ok {
		t.Fatal("must start private")
	}
	if resp, e := put(`{` + id + `,"isPublic":true}`); resp.StatusCode != 200 || !e.IsPublic || e.MaxPerMin != 60 {
		t.Errorf("flip on: %d %+v", resp.StatusCode, e)
	}
	if _, ok := eps.Match(User, "GET", "/users/1"); !ok {
		t.Error("public flip not effective after PUT")
	}
	if resp, e := put(`{` + id + `,"isPublic":false}`); resp.StatusCode != 200 || e.IsPublic {
		t.Errorf("flip off must be a valid non-empty patch: %d %+v", resp.StatusCode, e)
	}
	if _, ok := eps.Match(User, "GET", "/users/1"); ok {
		t.Error("private flip not effective after PUT")
	}
	if resp, e := put(`{` + id + `,"maxPerMin":5}`); resp.StatusCode != 200 || e.IsPublic || e.MaxPerMin != 5 {
		t.Errorf("other patches must not touch isPublic: %d %+v", resp.StatusCode, e)
	}
	// Admin GET still lists private endpoints, with the field.
	_, body := get(t, "GET", gw.URL+"/admin/endpoints", "", nil)
	if !strings.Contains(body, `"path":"/users/{id}"`) || !strings.Contains(body, `"isPublic":false`) {
		t.Errorf("admin list: %s", body)
	}
}

func TestSyncInsertsPrivate(t *testing.T) {
	svc := openAPIServer(t, `{"paths":{"/a":{"get":{}}}}`, 200)
	ds, _ := fakeDiscoverer(t, map[string][]string{"events": {hostOf(svc)}})
	store := newFakeStore()
	s := NewSyncer(NewDiscovery(ds.URL), store, NewEndpoints(store), 60)
	if _, _, err := s.SyncKind(context.Background(), Events); err != nil {
		t.Fatal(err)
	}
	if list, _ := store.List(context.Background(), Events); len(list) != 1 || list[0].IsPublic {
		t.Errorf("synced endpoint must be private: %+v", list)
	}
}
