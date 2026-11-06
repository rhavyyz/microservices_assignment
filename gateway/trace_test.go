package main

import (
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

const goodTrace = "client-trace.123"

func traceGateway(t *testing.T) (gw string, upstream func() []string) {
	t.Helper()
	var mu sync.Mutex
	var ids []string
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		ids = append(ids, r.Header.Values("X-Trace-Id")...)
		mu.Unlock()
		// A service echoes the id it accepted; the gateway must not duplicate it.
		w.Header().Set("X-Trace-Id", r.Header.Get("X-Trace-Id"))
		fmt.Fprint(w, "ok")
	}))
	t.Cleanup(down.Close)
	fakeDiscoverer(t, map[string][]string{"payments": {hostOf(down)}})
	srv, _ := newGateway(t, newFakeStore(
		ep(Payments, "GET", "/x", 10),
		ep(Payments, "GET", "/blocked", 0),
		epWith(Payments, "GET", "/secure", 10, RateLimitUserOrIP, true)), NewDiscovery())
	return srv.URL, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), ids...)
	}
}

func TestTraceIDValidClientIDKeptEndToEnd(t *testing.T) {
	var buf syncBuffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)
	gw, upstream := traceGateway(t)

	resp, _ := get(t, "GET", gw+"/payments/x", "", map[string]string{"X-Trace-Id": goodTrace})
	if v := resp.Header.Values("X-Trace-Id"); len(v) != 1 || v[0] != goodTrace {
		t.Errorf("response X-Trace-Id = %v", v)
	}
	if ids := upstream(); len(ids) != 1 || ids[0] != goodTrace {
		t.Errorf("upstream saw %v", ids)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(buf.String(), "trace_id="+goodTrace) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(buf.String(), "trace_id="+goodTrace) {
		t.Errorf("log: %q", buf.String())
	}
}

func TestTraceIDInvalidClientIDReplaced(t *testing.T) {
	var buf syncBuffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)
	gw, upstream := traceGateway(t)

	for _, tc := range []struct{ name, id string }{
		{"too short", "short"},
		{"too long", strings.Repeat("a", 65)},
		{"bad chars", "bad chars!<script>"},
		{"empty", ""},
	} {
		before := len(upstream())
		resp, _ := get(t, "GET", gw+"/payments/x", "", map[string]string{"X-Trace-Id": tc.id})
		got := resp.Header.Values("X-Trace-Id")
		if len(got) != 1 || !validTraceID.MatchString(got[0]) || (tc.id != "" && got[0] == tc.id) {
			t.Errorf("%s: response X-Trace-Id = %v", tc.name, got)
			continue
		}
		ids := upstream()[before:]
		if len(ids) != 1 || ids[0] != got[0] {
			t.Errorf("%s: upstream saw %v, response %v", tc.name, ids, got)
		}
		deadline := time.Now().Add(2 * time.Second)
		for !strings.Contains(buf.String(), "trace_id="+got[0]) && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if !strings.Contains(buf.String(), "trace_id="+got[0]) {
			t.Errorf("%s: log lacks %s: %q", tc.name, got[0], buf.String())
		}
		if tc.id != "" && strings.Contains(buf.String(), tc.id) {
			t.Errorf("%s: log reflects the raw id", tc.name)
		}
	}
}

func TestTraceIDOnGatewayProducedResponses(t *testing.T) {
	gw, _ := traceGateway(t)
	fakeDiscoverer(t, nil) // no instance of payments any more: 503 (the first call may be served from the cache otherwise)
	srv503, _ := newGateway(t, newFakeStore(ep(Payments, "GET", "/x", 10)), NewDiscovery())

	for _, tc := range []struct {
		name, url string
		status    int
		hdr       map[string]string
	}{
		{"404 unknown route", gw + "/nope/x", 404, nil},
		{"401 no token", gw + "/payments/secure", 401, nil},
		{"429 rate limited", gw + "/payments/blocked", 429, nil},
		{"503 no instance", srv503.URL + "/payments/x", 503, nil},
		{"healthcheck", gw + "/healthcheck", 200, nil},
		{"admin", gw + "/admin/endpoints", 200, nil},
		{"openapi", gw + "/openapi.json", 200, nil},
		{"docs", gw + "/docs", 200, nil},
	} {
		// Without a client id: a generated one.
		resp, _ := get(t, "GET", tc.url, "", tc.hdr)
		if resp.StatusCode != tc.status {
			t.Errorf("%s: status %d, want %d", tc.name, resp.StatusCode, tc.status)
		}
		if v := resp.Header.Values("X-Trace-Id"); len(v) != 1 || !validTraceID.MatchString(v[0]) {
			t.Errorf("%s: generated X-Trace-Id = %v", tc.name, v)
		}
		// With a valid client id: that one.
		resp, _ = get(t, "GET", tc.url, "", map[string]string{"X-Trace-Id": goodTrace})
		if v := resp.Header.Values("X-Trace-Id"); len(v) != 1 || v[0] != goodTrace {
			t.Errorf("%s: X-Trace-Id = %v, want the client's", tc.name, v)
		}
	}
}

func TestTraceIDLoggedOnGatewayErrors(t *testing.T) {
	var buf syncBuffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)
	gw, _ := traceGateway(t)
	get(t, "GET", gw+"/nope/x", "", map[string]string{"X-Trace-Id": goodTrace})
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(buf.String(), "status=404") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(buf.String(), "status=404") || !strings.Contains(buf.String(), "trace_id="+goodTrace) || strings.Contains(buf.String(), "trace_id=-") {
		t.Errorf("log: %q", buf.String())
	}
}

func TestTraceIDWebSocketRejection(t *testing.T) {
	srv, _ := wsGateway(t)
	for _, id := range []string{goodTrace, "bad!"} {
		_, resp, err := dialWS(t, srv, "", http.Header{"X-Trace-Id": {id}})
		if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("err=%v resp=%v, want 401", err, resp)
		}
		got := resp.Header.Get("X-Trace-Id")
		if !validTraceID.MatchString(got) || (id == goodTrace && got != id) || (id != goodTrace && got == id) {
			t.Errorf("sent %q, response X-Trace-Id = %q", id, got)
		}
	}
}

func TestTraceIDPreflightExposesHeader(t *testing.T) {
	gw, _ := traceGateway(t)
	resp, _ := get(t, "OPTIONS", gw+"/payments/x", "", map[string]string{
		"Origin": "https://ui.example", "Access-Control-Request-Method": "GET"})
	if resp.StatusCode != 204 || resp.Header.Get("Access-Control-Allow-Origin") != "https://ui.example" {
		t.Errorf("preflight: %d %v", resp.StatusCode, resp.Header)
	}
	resp, _ = get(t, "GET", gw+"/nope/x", "", map[string]string{"Origin": "https://ui.example"})
	if resp.Header.Get("Access-Control-Expose-Headers") != "X-Trace-Id" || resp.Header.Get("X-Trace-Id") == "" {
		t.Errorf("expose=%q trace=%q", resp.Header.Get("Access-Control-Expose-Headers"), resp.Header.Get("X-Trace-Id"))
	}
}

func TestTraceIDKeptOnRediscoveryRetry(t *testing.T) {
	var got string
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("X-Trace-Id")
	}))
	defer down.Close()
	dead := httptest.NewServer(http.NotFoundHandler())
	deadHost := hostOf(dead)
	dead.Close()
	fakeDiscoverer(t, map[string][]string{"payments": {deadHost, hostOf(down)}})
	gw, _ := newGateway(t, newFakeStore(ep(Payments, "GET", "/x", 10)), NewDiscovery())
	resp, _ := get(t, "GET", gw.URL+"/payments/x", "", map[string]string{"X-Trace-Id": goodTrace})
	if resp.StatusCode != 200 || got != goodTrace {
		t.Errorf("status=%d upstream trace=%q", resp.StatusCode, got)
	}
}
