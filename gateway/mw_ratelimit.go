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
	user, method, path string
	kind               Kind
}

type window struct {
	start time.Time
	count int
}

// Limiter is a fixed one-minute window counter per (user, kind, method, path template).
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

// RateLimit limits per user (X-User-Id header, trusted as-is; missing -> 401) against the endpoint's maxPerMin.
func RateLimit(l *Limiter) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := r.Header.Get("X-User-Id")
			if user == "" {
				http.Error(w, "missing X-User-Id header", http.StatusUnauthorized)
				return
			}
			rt, _ := routeFrom(r.Context())
			ep := rt.Endpoint
			ok, retry := l.Allow(limitKey{user: user, kind: ep.Kind, method: ep.Method, path: ep.Path}, ep.MaxPerMin)
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
