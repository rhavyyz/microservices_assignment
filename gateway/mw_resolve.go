package main

import (
	"context"
	"net/http"
)

// Resolve matches the request to a registered public endpoint (404 if none or private) and stashes it in the request context.
func Resolve(eps *Endpoints) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			kind, rest := splitKind(r.URL.Path)
			if !kind.valid() {
				http.NotFound(w, r)
				return
			}
			ep, ok := eps.Match(kind, r.Method, rest)
			if !ok {
				http.NotFound(w, r)
				return
			}
			ctx := context.WithValue(r.Context(), routeKey{}, route{Endpoint: ep, Rest: rest})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
