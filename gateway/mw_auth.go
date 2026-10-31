package main

import "net/http"

// Auth rejects with 401 the requests to endpoints with requireAuth when X-User-Id is missing or empty.
// It runs before the rate limiter so unauthenticated calls do not consume budget.
// NOTE: this is only a presence check for now; we cannot verify the identity behind the header yet.
func Auth() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rt, _ := routeFrom(r.Context())
			if rt.Endpoint.RequireAuth && r.Header.Get("X-User-Id") == "" {
				http.Error(w, "missing X-User-Id header", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
