package discovery

import (
	"encoding/json"
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
	for _, c := range caches {
		c.host = ""
	}
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
