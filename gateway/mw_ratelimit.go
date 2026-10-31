package main

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

const (
	rateWindow   = time.Minute
	cleanupEvery = time.Minute
)

type limitKey struct {
	id, method, path string // id is the mode-specific identity ("u:..", "ip:..", "global")
	kind             Kind
}

type window struct {
	start time.Time
	count int
}

// Limiter is a fixed one-minute window counter per (identity, kind, method, path template).
// Counters live in memory: they are per gateway instance, not shared across replicas.
type Limiter struct {
	now     func() time.Time
	mu      sync.Mutex
	windows map[limitKey]*window
}

func NewLimiter(now func() time.Time) *Limiter {
	return &Limiter{now: now, windows: map[limitKey]*window{}}
}

// Allow counts one request. When over max it returns false and how long until the window resets.
// max = 0 rejects everything.
func (l *Limiter) Allow(k limitKey, max int) (bool, time.Duration) {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	w := l.windows[k]
	if w == nil || !now.Before(w.start.Add(rateWindow)) {
		w = &window{start: now}
		l.windows[k] = w
	}
	if w.count >= max {
		return false, w.start.Add(rateWindow).Sub(now)
	}
	w.count++
	return true, 0
}

// Cleanup drops expired windows.
func (l *Limiter) Cleanup() {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, w := range l.windows {
		if !now.Before(w.start.Add(rateWindow)) {
			delete(l.windows, k)
		}
	}
}

// Run cleans up expired windows periodically until stop is closed.
func (l *Limiter) Run(stop <-chan struct{}) {
	t := time.NewTicker(cleanupEvery)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			l.Cleanup()
		}
	}
}

// rateLimitID is the identity part of the counter key for the endpoint's rateLimitBy mode.
func rateLimitID(mode RateLimitBy, r *http.Request, tp TrustedProxies) string {
	switch mode {
	case RateLimitGlobal:
		return "global"
	case RateLimitIP:
		return "ip:" + ClientIP(r, tp)
	default: // user_or_ip
		if u := r.Header.Get("X-User-Id"); u != "" {
			return "u:" + u
		}
		return "ip:" + ClientIP(r, tp)
	}
}

// RateLimit limits against the endpoint's maxPerMin, keyed according to its rateLimitBy.
// X-User-Id is trusted as-is. Authentication is Auth's job: a missing user never fails here.
func RateLimit(l *Limiter, tp TrustedProxies) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rt, _ := routeFrom(r.Context())
			ep := rt.Endpoint
			id := rateLimitID(ep.RateLimitBy, r, tp)
			ok, retry := l.Allow(limitKey{id: id, kind: ep.Kind, method: ep.Method, path: ep.Path}, ep.MaxPerMin)
			if !ok {
				secs := int((retry + time.Second - 1) / time.Second)
				if secs < 1 {
					secs = 1
				}
				w.Header().Set("Retry-After", strconv.Itoa(secs))
				http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
