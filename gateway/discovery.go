package main

import (
	"context"
	"net/http"
	"sync"
	"time"

	"microservices/discovery"
)

var (
	ErrUnknownKind = discovery.ErrUnknownKind
	ErrNoInstance  = discovery.ErrNoInstance
)

// cachedHost is a consulted host and when it was consulted.
type cachedHost struct {
	host string
	at   time.Time
}

// Discovery caches one host per kind for the reverse proxy, which needs the host itself
// (httputil.ReverseProxy cannot go through discovery.Request). A host is reused for ttl
// (DISCOVERY_CACHE_TTL_SECONDS, 0 = consult every time) so the discoverer's round robin
// moves the gateway across instances. The discoverer protocol is the shared discovery lib's;
// the lib reads SERVICE_DISCOVERER_URL.
type Discovery struct {
	mu    sync.Mutex
	hosts map[Kind]cachedHost
	ttl   time.Duration
	now   func() time.Time
}

// NewDiscovery returns a Discovery with the default cache TTL; main sets d.ttl from the env.
func NewDiscovery() *Discovery {
	return &Discovery{hosts: map[Kind]cachedHost{}, ttl: discovery.DefaultCacheTTL, now: time.Now}
}

// ParseCacheTTL parses DISCOVERY_CACHE_TTL_SECONDS (the lib reads the same variable for its own cache,
// so both stay consistent).
func ParseCacheTTL(s string) (time.Duration, error) {
	return discovery.ParseCacheTTL(s)
}

// Consult asks the discoverer for a healthy host every time, without touching the cache.
// The errors wrap ErrNoInstance (no healthy instance) or ErrUnknownKind (kind rejected by the discoverer).
// The lib takes no context: on cancellation this returns ctx.Err() at once and the lib call
// finishes in the background, bounded by the lib's own HTTP timeout.
func (d *Discovery) Consult(ctx context.Context, kind Kind) (string, error) {
	type result struct {
		host string
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		h, err := discovery.Consult(discovery.Kind(kind))
		ch <- result{h, err}
	}()
	select {
	case r := <-ch:
		return r.host, r.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// request is discovery.Request (cached host, one rediscovery on connection failure) that gives up
// when ctx is done. A response that arrives after that is closed.
func request(ctx context.Context, method string, kind Kind, path string) (*http.Response, error) {
	type result struct {
		resp *http.Response
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		resp, err := discovery.Request(method, discovery.Kind(kind), path, discovery.Options{})
		ch <- result{resp, err}
	}()
	select {
	case r := <-ch:
		return r.resp, r.err
	case <-ctx.Done():
		go func() {
			if r := <-ch; r.resp != nil {
				r.resp.Body.Close()
			}
		}()
		return nil, ctx.Err()
	}
}

// Host returns the cached host of the kind while it is younger than the TTL, consulting the
// discoverer on a miss or an expired entry. If refreshing an expired entry fails, the previous
// host is returned instead; the error is only returned when there is no host at all.
func (d *Discovery) Host(ctx context.Context, kind Kind) (string, error) {
	d.mu.Lock()
	e, ok := d.hosts[kind]
	d.mu.Unlock()
	if ok && d.ttl > 0 && d.now().Sub(e.at) < d.ttl {
		return e.host, nil
	}
	at := d.now()
	h, err := d.Consult(ctx, kind)
	if err != nil {
		if ok && ctx.Err() == nil {
			// Discoverer unreachable: better the last known host than failing the request.
			// A host that failed is dropped by Forget first, so it is never the one reused here.
			return e.host, nil
		}
		return "", err
	}
	d.mu.Lock()
	d.hosts[kind] = cachedHost{host: h, at: at}
	d.mu.Unlock()
	return h, nil
}

// Forget drops the cached host of the kind, but only if it is still the given (failed) one.
func (d *Discovery) Forget(kind Kind, host string) {
	d.mu.Lock()
	if d.hosts[kind].host == host {
		delete(d.hosts, kind)
	}
	d.mu.Unlock()
}
