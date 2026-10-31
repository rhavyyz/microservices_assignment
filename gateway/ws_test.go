package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// wsGateway serves the real mux (Cors + Logging + /ws) with a hub tuned for fast tests.
func wsGateway(t *testing.T, tune ...func(*Hub)) (*httptest.Server, *Hub) {
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
	srv := httptest.NewServer(newMux(store, eps, hub, NewPipeline(eps, NewLimiter(time.Now), nil, NewProxy(NewDiscovery("http://127.0.0.1:1")))))
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

func user(id string) http.Header { return http.Header{"X-User-Id": {id}} }

func TestWSRequiresIdentity(t *testing.T) {
	srv, _ := wsGateway(t)
	for _, q := range []string{"", "?user_id=", "?user_id=%20%20"} {
		_, resp, err := dialWS(t, srv, q, http.Header{"X-User-Id": {"  "}})
		if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("query %q: err=%v resp=%v, want 401", q, err, resp)
		}
	}
}

func TestWSIdentitySources(t *testing.T) {
	srv, hub := wsGateway(t)
	push := func(id string) bool { return hub.Send(id, []byte(`{"to":"`+id+`"}`)) }

	h := connect(t, srv, "", user(" alice "))
	if !push("alice") || readFrame(t, h) != `{"to":"alice"}` {
		t.Error("header identity (trimmed) did not receive")
	}
	q := connect(t, srv, "?user_id=bob", nil)
	if !push("bob") || readFrame(t, q) != `{"to":"bob"}` {
		t.Error("query identity did not receive")
	}
	both := connect(t, srv, "?user_id=mallory", user("carol"))
	if push("mallory") {
		t.Error("query must not win over the header")
	}
	if !push("carol") || readFrame(t, both) != `{"to":"carol"}` {
		t.Error("header must win over the query")
	}
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
