package main

import (
	"log"
	"net/http"
	"time"
)

// statusWriter records the status code. Unwrap keeps Flusher & co. reachable via http.ResponseController;
// Flush is explicit because ReverseProxy type-asserts http.Flusher.
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

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// Logging logs one line per request after the response: method, path, kind, status, duration, user, request id.
func Logging() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sw := &statusWriter{ResponseWriter: w}
			next.ServeHTTP(sw, r)
			if sw.status == 0 {
				sw.status = http.StatusOK
			}
			kind, _ := splitKind(r.URL.Path)
			// Later stages mutate r.Header in place, so the generated request id is visible here.
			log.Printf("%s %s kind=%s status=%d duration=%s user=%s request_id=%s",
				r.Method, r.URL.Path, kind, sw.status, time.Since(start), dash(r.Header.Get("X-User-Id")), dash(r.Header.Get("X-Request-Id")))
		})
	}
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
