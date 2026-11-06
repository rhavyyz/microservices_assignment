package main

import (
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// captureAccess sets the instance prefix main would set and captures the log.
func captureAccess(t *testing.T) *syncBuffer {
	t.Helper()
	var buf syncBuffer
	log.SetOutput(&buf)
	log.SetPrefix("instance=gw-test:8080 ")
	t.Cleanup(func() { log.SetOutput(os.Stderr); log.SetPrefix("") })
	return &buf
}

// accessLine waits for the access line of `path` and returns it.
func accessLine(t *testing.T, buf *syncBuffer, path string) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, l := range strings.Split(buf.String(), "\n") {
			if strings.Contains(l, " "+path+" kind=") {
				return l
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no access line for %s: %q", path, buf.String())
	return ""
}

func TestAccessLogUpstreamAndInstance(t *testing.T) {
	buf := captureAccess(t)
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok") }))
	defer down.Close()
	fakeDiscoverer(t, map[string][]string{"payments": {hostOf(down)}})
	srv, _ := newGateway(t, newFakeStore(ep(Payments, "GET", "/x", 10), epWith(Payments, "GET", "/secure", 10, RateLimitUserOrIP, true)), NewDiscovery())

	resp, _ := get(t, "GET", srv.URL+"/payments/x", "", nil)
	for k := range resp.Header {
		if strings.Contains(strings.ToLower(k), "upstream") {
			t.Errorf("response header %s exposes the upstream", k)
		}
	}
	line := accessLine(t, buf, "/payments/x")
	t.Log(line)
	if !strings.Contains(line, "upstream="+hostOf(down)) {
		t.Errorf("line lacks upstream: %q", line)
	}
	if n := strings.Count(line, "instance="); n != 1 || !strings.HasPrefix(line, "instance=gw-test:8080 ") {
		t.Errorf("instance count %d: %q", n, line)
	}

	get(t, "GET", srv.URL+"/nope/x", "", nil)
	if l := accessLine(t, buf, "/nope/x"); !strings.Contains(l, "upstream=-") {
		t.Errorf("404 line: %q", l)
	}
	get(t, "GET", srv.URL+"/payments/secure", "", nil)
	if l := accessLine(t, buf, "/payments/secure"); !strings.Contains(l, "status=401") || !strings.Contains(l, "upstream=-") {
		t.Errorf("401 line: %q", l)
	}
	get(t, "GET", srv.URL+"/healthcheck", "", nil)
	time.Sleep(50 * time.Millisecond)
	for _, l := range strings.Split(buf.String(), "\n") {
		if strings.Contains(l, "/healthcheck") && !strings.Contains(l, "upstream=-") {
			t.Errorf("healthcheck line: %q", l)
		}
	}
}

func TestAccessLogUpstreamAfterRediscovery(t *testing.T) {
	buf := captureAccess(t)
	dead := httptest.NewServer(http.NotFoundHandler())
	deadHost := hostOf(dead)
	dead.Close() // dialing it is refused
	live := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok") }))
	defer live.Close()
	fakeDiscoverer(t, map[string][]string{"payments": {deadHost, hostOf(live)}})
	srv, _ := newGateway(t, newFakeStore(ep(Payments, "GET", "/x", 10)), NewDiscovery())

	resp, body := get(t, "GET", srv.URL+"/payments/x", "", nil)
	if resp.StatusCode != 200 || body != "ok" {
		t.Fatalf("status %d body %q", resp.StatusCode, body)
	}
	line := accessLine(t, buf, "/payments/x")
	if !strings.Contains(line, "upstream="+hostOf(live)) || strings.Contains(line, deadHost) {
		t.Errorf("line: %q", line)
	}
}
