package main

import "net/http"

// Cors is fully permissive CORS for everything the gateway serves. It wraps the whole mux (see newMux), so
// proxied routes, /admin/*, /healthcheck and the 404/401/429/503 rejections all carry the headers, and
// preflights are answered here before resolve, rate limiting or the downstream are involved.
//
// Any origin is allowed by reflecting the request's Origin (credentials are allowed, so "*" would not work).
// Requests without an Origin header (same-origin, curl, service-to-service) get no CORS headers at all.
// Preflights are not logged: they never reach the Logging stage of the pipeline.
func Cors() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			origin := r.Header.Get("Origin")
			if origin != "" {
				h.Set("Access-Control-Allow-Origin", origin)
				h.Set("Access-Control-Allow-Credentials", "true")
				h.Add("Vary", "Origin")
			}
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD")
				if reqHeaders := r.Header.Get("Access-Control-Request-Headers"); reqHeaders != "" {
					h.Set("Access-Control-Allow-Headers", reqHeaders)
					h.Add("Vary", "Access-Control-Request-Headers")
				}
				h.Set("Access-Control-Max-Age", "86400")
				w.WriteHeader(http.StatusNoContent)
				return
			}
			if origin != "" {
				h.Set("Access-Control-Expose-Headers", "X-Request-Id")
			}
			next.ServeHTTP(w, r)
		})
	}
}
