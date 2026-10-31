package main

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
)

// DefaultHeaders sets the headers every downstream call gets. Incoming X-Request-Id and
// X-Forwarded-* values are kept (trusted); otherwise they are set from the connection.
func DefaultHeaders() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-Request-Id") == "" {
				r.Header.Set("X-Request-Id", newRequestID())
			}
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
			w.Header().Set("X-Request-Id", r.Header.Get("X-Request-Id"))
			next.ServeHTTP(w, r)
		})
	}
}

func newRequestID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
