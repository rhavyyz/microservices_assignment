package discovery

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func host(s *httptest.Server) string { return strings.TrimPrefix(s.URL, "http://") }

func fakeDiscoverer(t *testing.T, hosts ...string) (*httptest.Server, *int) {
	var mu sync.Mutex
	consults := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		consults++
		json.NewEncoder(w).Encode(map[string]string{"host": hosts[0]})
		if len(hosts) > 1 {
			hosts = hosts[1:]
		}
	}))
	t.Cleanup(s.Close)
	t.Setenv("SERVICE_DISCOVERER_URL", s.URL)
	Reset()
	t.Cleanup(Reset)
	return s, &consults
}

func target(t *testing.T) *httptest.Server {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		w.Write([]byte(r.Header.Get("X-Test") + "|" + r.Header.Get("Content-Type") + "|" + string(b)))
	}))
	t.Cleanup(s.Close)
	return s
}

func TestRegister(t *testing.T) {
	var got map[string]string
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer s.Close()
	t.Setenv("SERVICE_DISCOVERER_URL", s.URL)
	t.Setenv("SERVICE_HOST", "payments-1:9000")
	if err := Register(Payments); err != nil {
		t.Fatal(err)
	}
	if got["kind"] != "payments" || got["host"] != "payments-1:9000" {
		t.Fatalf("got %v", got)
	}
}

// flakyDiscoverer fails the first `failures` register calls with a 503, then answers 204.
func flakyDiscoverer(t *testing.T, failures int) (*int, *[]time.Duration) {
	calls := 0
	var delays []time.Duration
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls <= failures {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(s.Close)
	t.Setenv("SERVICE_DISCOVERER_URL", s.URL)
	t.Setenv("SERVICE_HOST", "payments-1:9000")
	orig := sleep
	sleep = func(d time.Duration) { delays = append(delays, d) }
	t.Cleanup(func() { sleep = orig })
	return &calls, &delays
}

func TestRegisterRetriesUntilSuccess(t *testing.T) {
	calls, delays := flakyDiscoverer(t, 3)
	if err := Register(Payments); err != nil {
		t.Fatal(err)
	}
	if *calls != 4 {
		t.Fatalf("calls = %d", *calls)
	}
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}
	if !slices.Equal(*delays, want) {
		t.Fatalf("delays = %v, want %v", *delays, want)
	}
}

func TestRegisterGivesUpWithBackoff(t *testing.T) {
	calls, delays := flakyDiscoverer(t, 1000)
	err := Register(Payments)
	if err == nil || !strings.Contains(err.Error(), "could not register with the service-discoverer") ||
		!strings.Contains(err.Error(), "register failed: 503 not ready") {
		t.Fatalf("err = %v", err)
	}
	if *calls != 10 {
		t.Fatalf("calls = %d", *calls)
	}
	want := []time.Duration{1, 2, 4, 8, 16, 30, 30, 30, 30}
	for i := range want {
		want[i] *= time.Second
	}
	if !slices.Equal(*delays, want) {
		t.Fatalf("delays = %v, want %v", *delays, want)
	}
}

func TestRegisterRetriesConnectionErrors(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	dead.Close()
	t.Setenv("SERVICE_DISCOVERER_URL", dead.URL)
	t.Setenv("SERVICE_HOST", "payments-1:9000")
	n := 0
	orig := sleep
	sleep = func(time.Duration) { n++ }
	t.Cleanup(func() { sleep = orig })
	if err := Register(Payments); err == nil {
		t.Fatal("expected an error")
	}
	if n != 9 {
		t.Fatalf("sleeps = %d", n)
	}
}

func TestRequestCachesHost(t *testing.T) {
	tg := target(t)
	_, consults := fakeDiscoverer(t, host(tg))
	for i := 0; i < 3; i++ {
		resp, err := Request("POST", User, "/x", Options{Headers: map[string]string{"X-Test": "1"}, Body: map[string]int{"a": 1}})
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(b) != `1|application/json|{"a":1}` {
			t.Fatalf("got %s", b)
		}
	}
	if *consults != 1 {
		t.Fatalf("consults = %d", *consults)
	}
}

func TestRediscoversWhenUnreachable(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	deadHost := host(dead)
	dead.Close()
	good := target(t)
	_, consults := fakeDiscoverer(t, deadHost, host(good))

	resp, err := Request("POST", Events, "/x", Options{Body: map[string]int{"b": 2}})
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if *consults != 2 {
		t.Fatalf("consults = %d", *consults)
	}
	resp, _ = Request("POST", Events, "/x", Options{})
	resp.Body.Close()
	if *consults != 2 {
		t.Fatalf("cache not reused, consults = %d", *consults)
	}
}

func TestConsultDoesNotCache(t *testing.T) {
	_, consults := fakeDiscoverer(t, "a:1", "b:2")
	for _, want := range []string{"a:1", "b:2"} {
		got, err := Consult(User)
		if err != nil || got != want {
			t.Fatalf("got %q, %v; want %q", got, err, want)
		}
	}
	if *consults != 2 {
		t.Fatalf("consults = %d", *consults)
	}
}

func TestConsultSentinelErrors(t *testing.T) {
	status := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", status)
	}))
	defer s.Close()
	t.Setenv("SERVICE_DISCOVERER_URL", s.URL)
	for _, c := range []struct {
		status int
		want   error
	}{{503, ErrNoInstance}, {400, ErrUnknownKind}} {
		status = c.status
		_, err := Consult(Payments)
		if !errors.Is(err, c.want) || !strings.Contains(err.Error(), "consult payments failed: ") {
			t.Errorf("status %d: err = %v", c.status, err)
		}
		other := ErrUnknownKind
		if c.want == ErrUnknownKind {
			other = ErrNoInstance
		}
		if errors.Is(err, other) {
			t.Errorf("status %d: must not match %v", c.status, other)
		}
	}
	status = 500
	if _, err := Consult(Payments); err == nil || errors.Is(err, ErrNoInstance) || errors.Is(err, ErrUnknownKind) {
		t.Errorf("500: err = %v", err)
	}
}

func TestReset(t *testing.T) {
	_, consults := fakeDiscoverer(t, "a:1", "b:2")
	if h, _ := resolve(Payments, ""); h != "a:1" {
		t.Fatalf("host = %q", h)
	}
	if h, _ := resolve(Payments, ""); h != "a:1" || *consults != 1 {
		t.Fatalf("not cached: %q after %d consults", h, *consults)
	}
	Reset()
	if h, _ := resolve(Payments, ""); h != "b:2" || *consults != 2 {
		t.Errorf("after Reset: %q after %d consults", h, *consults)
	}
}

// fakeClock replaces now for the test and returns a function advancing it.
func fakeClock(t *testing.T) func(time.Duration) {
	cur := time.Unix(1000, 0)
	orig := now
	now = func() time.Time { return cur }
	t.Cleanup(func() { now = orig })
	return func(d time.Duration) { cur = cur.Add(d) }
}

func TestCacheTTLExpiresAndMovesToNextHost(t *testing.T) {
	advance := fakeClock(t)
	_, consults := fakeDiscoverer(t, "a:1", "b:2", "c:3")
	t.Setenv("DISCOVERY_CACHE_TTL_SECONDS", "5")
	get := func(want string, wantConsults int) {
		t.Helper()
		if h, err := resolve(Payments, ""); err != nil || h != want || *consults != wantConsults {
			t.Fatalf("got %q, %v after %d consults; want %q after %d", h, err, *consults, want, wantConsults)
		}
	}
	get("a:1", 1)
	advance(4 * time.Second)
	get("a:1", 1)
	advance(time.Second) // age == TTL: expired
	get("b:2", 2)
	advance(4 * time.Second)
	get("b:2", 2)
	advance(2 * time.Second)
	get("c:3", 3)
}

func TestCacheTTLZeroConsultsEveryTime(t *testing.T) {
	fakeClock(t)
	_, consults := fakeDiscoverer(t, "a:1", "b:2")
	t.Setenv("DISCOVERY_CACHE_TTL_SECONDS", "0")
	for _, want := range []string{"a:1", "b:2", "b:2"} {
		if h, _ := resolve(Payments, ""); h != want {
			t.Fatalf("got %q, want %q", h, want)
		}
	}
	if *consults != 3 {
		t.Fatalf("consults = %d", *consults)
	}
}

func TestCacheTTLDecimal(t *testing.T) {
	advance := fakeClock(t)
	_, consults := fakeDiscoverer(t, "a:1", "b:2")
	t.Setenv("DISCOVERY_CACHE_TTL_SECONDS", "0.5")
	resolve(Payments, "")
	advance(400 * time.Millisecond)
	resolve(Payments, "")
	if *consults != 1 {
		t.Fatalf("consults = %d", *consults)
	}
	advance(100 * time.Millisecond)
	if h, _ := resolve(Payments, ""); h != "b:2" {
		t.Fatalf("host = %q", h)
	}
}

func TestParseCacheTTL(t *testing.T) {
	for in, want := range map[string]time.Duration{"0": 0, "10": 10 * time.Second, "0.25": 250 * time.Millisecond, " 3 ": 3 * time.Second, "86400": 86400 * time.Second} {
		if got, err := ParseCacheTTL(in); err != nil || got != want {
			t.Errorf("%q: got %v, %v; want %v", in, got, err, want)
		}
	}
	for _, in := range []string{"", "abc", "-1", "NaN", "Inf", "-Inf", "86401", "1e99", "10s"} {
		if _, err := ParseCacheTTL(in); err == nil {
			t.Errorf("%q: expected an error", in)
		}
	}
}

func TestInvalidCacheTTLFallsBackToDefault(t *testing.T) {
	for _, v := range []string{"", "abc", "-1", "NaN", "Inf", "100000"} {
		t.Setenv("DISCOVERY_CACHE_TTL_SECONDS", v)
		if got := cacheTTL(); got != DefaultCacheTTL {
			t.Errorf("%q: ttl = %v", v, got)
		}
	}
	t.Setenv("DISCOVERY_CACHE_TTL_SECONDS", "2.5")
	if got := cacheTTL(); got != 2500*time.Millisecond {
		t.Errorf("ttl = %v", got)
	}
}

func TestStaleHostUsedWhenRefreshFails(t *testing.T) {
	advance := fakeClock(t)
	s, _ := fakeDiscoverer(t, "a:1")
	t.Setenv("DISCOVERY_CACHE_TTL_SECONDS", "5")
	if h, _ := resolve(Payments, ""); h != "a:1" {
		t.Fatalf("host = %q", h)
	}
	s.Close() // discoverer unreachable
	advance(6 * time.Second)
	if h, err := resolve(Payments, ""); err != nil || h != "a:1" {
		t.Fatalf("got %q, %v; want the stale a:1", h, err)
	}
	// the unreachable host itself is never reused when the refresh fails
	if h, err := resolve(Payments, "a:1"); err == nil {
		t.Fatalf("got %q, want an error", h)
	}
}

func TestNoHostAndConsultFailsIsAnError(t *testing.T) {
	fakeClock(t)
	s, _ := fakeDiscoverer(t, "a:1")
	s.Close()
	if h, err := resolve(Payments, ""); err == nil {
		t.Fatalf("got %q, want an error", h)
	}
}

func TestRediscoveryResetsTTL(t *testing.T) {
	advance := fakeClock(t)
	dead := httptest.NewServer(http.NotFoundHandler())
	deadHost := host(dead)
	dead.Close()
	good := target(t)
	_, consults := fakeDiscoverer(t, deadHost, host(good))
	t.Setenv("DISCOVERY_CACHE_TTL_SECONDS", "5")
	resp, err := Request("GET", Events, "/x", Options{})
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	advance(4 * time.Second)
	resp, _ = Request("GET", Events, "/x", Options{})
	resp.Body.Close()
	if *consults != 2 {
		t.Fatalf("consults = %d", *consults)
	}
}

func TestHostExpiresAndMovesToNextHost(t *testing.T) {
	advance := fakeClock(t)
	_, consults := fakeDiscoverer(t, "a:1", "b:2", "c:3")
	t.Setenv("DISCOVERY_CACHE_TTL_SECONDS", "5")
	get := func(want string, wantConsults int) {
		t.Helper()
		if h, err := Host(Payments); err != nil || h != want || *consults != wantConsults {
			t.Fatalf("got %q, %v after %d consults; want %q after %d", h, err, *consults, want, wantConsults)
		}
	}
	get("a:1", 1)
	advance(4 * time.Second)
	get("a:1", 1)
	advance(time.Second)
	get("b:2", 2)
	advance(6 * time.Second)
	get("c:3", 3)
}

func TestHostTTLZeroConsultsEveryTime(t *testing.T) {
	fakeClock(t)
	_, consults := fakeDiscoverer(t, "a:1", "b:2")
	t.Setenv("DISCOVERY_CACHE_TTL_SECONDS", "0")
	for _, want := range []string{"a:1", "b:2", "b:2"} {
		if h, _ := Host(Payments); h != want {
			t.Fatalf("got %q, want %q", h, want)
		}
	}
	if *consults != 3 {
		t.Fatalf("consults = %d", *consults)
	}
}

func TestHostStaleFallbackAndForget(t *testing.T) {
	advance := fakeClock(t)
	s, _ := fakeDiscoverer(t, "a:1")
	t.Setenv("DISCOVERY_CACHE_TTL_SECONDS", "5")
	if h, _ := Host(Payments); h != "a:1" {
		t.Fatalf("host = %q", h)
	}
	s.Close()
	advance(6 * time.Second)
	if h, err := Host(Payments); err != nil || h != "a:1" {
		t.Fatalf("got %q, %v; want the stale a:1", h, err)
	}
	// a forgotten host is never used as the fallback
	Forget(Payments, "a:1")
	if h, err := Host(Payments); err == nil {
		t.Fatalf("got %q, want an error", h)
	}
}

func TestHostNoInstanceIsAnError(t *testing.T) {
	fakeClock(t)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "none", http.StatusServiceUnavailable)
	}))
	t.Cleanup(s.Close)
	t.Setenv("SERVICE_DISCOVERER_URL", s.URL)
	Reset()
	t.Cleanup(Reset)
	if _, err := Host(Payments); !errors.Is(err, ErrNoInstance) {
		t.Fatalf("err = %v, want ErrNoInstance", err)
	}
}

func TestForgetOnlyDropsSameHost(t *testing.T) {
	fakeClock(t)
	_, consults := fakeDiscoverer(t, "a:1", "b:2")
	t.Setenv("DISCOVERY_CACHE_TTL_SECONDS", "60")
	Host(Payments)
	Forget(Payments, "other:9") // not the cached host: kept
	if h, _ := Host(Payments); h != "a:1" || *consults != 1 {
		t.Fatalf("got %q after %d consults", h, *consults)
	}
	Forget(Kind("nope"), "a:1") // unknown kind: no-op
	Forget(Payments, "a:1")     // Host consults again
	if h, _ := Host(Payments); h != "b:2" || *consults != 2 {
		t.Fatalf("got %q after %d consults", h, *consults)
	}
}
