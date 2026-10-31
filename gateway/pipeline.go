package main

import (
	"context"
	"net/http"
)

// Middleware wraps a handler. It can mutate the request (headers...) or reject it by not calling next.
type Middleware func(http.Handler) http.Handler

// Chain wraps h with the middlewares; the first one is the outermost.
func Chain(h http.Handler, mws ...Middleware) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// route is what Resolve stashes in the request context for the later stages.
type route struct {
	Endpoint Endpoint
	Rest     string // downstream path, without the /{kind} prefix
}

type routeKey struct{}

func routeFrom(ctx context.Context) (route, bool) {
	rt, ok := ctx.Value(routeKey{}).(route)
	return rt, ok
}

// NewPipeline builds the gateway handler: logging, resolve, auth, rate limit, default headers, then the proxy.
func NewPipeline(eps *Endpoints, rl *Limiter, tp TrustedProxies, proxy http.Handler) http.Handler {
	return Chain(proxy, Logging(), Resolve(eps), Auth(), RateLimit(rl, tp), DefaultHeaders())
}
