package discovery

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
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
