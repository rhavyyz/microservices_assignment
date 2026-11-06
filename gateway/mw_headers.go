package main

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"regexp"
)

// validTraceID is the rule every service applies to an incoming X-Trace-Id.
var validTraceID = regexp.MustCompile(`^[A-Za-z0-9._-]{8,64}$`)

// TraceID is the outermost middleware: it keeps the client's X-Trace-Id only if it is valid (same rule as the
// services), otherwise generates one. The id goes on the request (so the proxy forwards the validated value and
// Logging sees it) and on the response before any later stage runs, so the gateway's own errors carry it too.
func TraceID() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := r.Header.Get("X-Trace-Id")
			if !validTraceID.MatchString(id) {
				id = newTraceID()
			}
			r.Header.Set("X-Trace-Id", id)
			w.Header().Set("X-Trace-Id", id)
			next.ServeHTTP(w, r)
		})
	}
}

// DefaultHeaders sets the headers every downstream call gets. Incoming X-Forwarded-* values are kept (trusted);
// otherwise they are set from the connection. The trace id is owned by TraceID.
func DefaultHeaders() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-Forwarded-For") == "" {
				ip, _, err := net.SplitHostPort(r.RemoteAddr)
				if err != nil {
					ip = r.RemoteAddr
				}
				r.Header.Set("X-Forwarded-For", ip)
			}
			if r.Header.Get("X-Forwarded-Host") == "" {
				r.Header.Set("X-Forwarded-Host", r.Host)
			}
			r.Header.Set("X-Gateway", "gateway")
			next.ServeHTTP(w, r)
		})
	}
}

func newTraceID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
