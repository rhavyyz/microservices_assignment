package main

import (
	"bufio"
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
)

// upstreamHolder is the mutable slot Logging puts in the request context and the proxy fills with the host
// that served the request. The mutex keeps it race-free whichever goroutine writes.
type upstreamHolder struct {
	mu   sync.Mutex
	host string
}

func (h *upstreamHolder) set(host string) {
	h.mu.Lock()
	h.host = host
	h.mu.Unlock()
}

func (h *upstreamHolder) get() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.host
}

type upstreamKey struct{}

// recordUpstream notes host as the upstream of the request owning ctx; a no-op without a holder.
func recordUpstream(ctx context.Context, host string) {
	if h, ok := ctx.Value(upstreamKey{}).(*upstreamHolder); ok {
		h.set(host)
	}
}

// statusWriter records the status code. Unwrap keeps Flusher & co. reachable via http.ResponseController;
// Flush and Hijack are explicit because ReverseProxy type-asserts http.Flusher and the websocket upgrader
// type-asserts http.Hijacker.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	conn, rw, err := h.Hijack()
	if err == nil && w.status == 0 {
		w.status = http.StatusSwitchingProtocols // the handler writes the 101 itself, on the raw connection
	}
	return conn, rw, err
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// Logging logs one line per request after the response: method, path, kind, status, duration, user, trace id, upstream host ("-" when nothing was proxied).
// The instance id comes from the log prefix set in main.
func Logging() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sw := &statusWriter{ResponseWriter: w}
			up := &upstreamHolder{}
			next.ServeHTTP(sw, r.WithContext(context.WithValue(r.Context(), upstreamKey{}, up)))
			if sw.status == 0 {
				sw.status = http.StatusOK
			}
			kind, _ := splitKind(r.URL.Path)
			// Later stages mutate r.Header in place, so the generated trace id is visible here.
			log.Printf("%s %s kind=%s status=%d duration=%s user=%s trace_id=%s upstream=%s",
				r.Method, r.URL.Path, kind, sw.status, time.Since(start), dash(r.Header.Get("X-User-Id")), dash(r.Header.Get("X-Trace-Id")), dash(up.get()))
		})
	}
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
