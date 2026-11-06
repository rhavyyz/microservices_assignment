package main

import (
	"context"
	"net/http"
	"sync"

	"microservices/discovery"
)

var (
	ErrUnknownKind = discovery.ErrUnknownKind
	ErrNoInstance  = discovery.ErrNoInstance
)

// Discovery caches one host per kind for the reverse proxy, which needs the host itself
// (httputil.ReverseProxy cannot go through discovery.Request). The discoverer protocol is
// the shared discovery lib's; the lib reads SERVICE_DISCOVERER_URL.
type Discovery struct {
	mu    sync.Mutex
	hosts map[Kind]string
}

func NewDiscovery() *Discovery {
	return &Discovery{hosts: map[Kind]string{}}
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

// Host returns the cached host of the kind, consulting the discoverer on a miss.
func (d *Discovery) Host(ctx context.Context, kind Kind) (string, error) {
	d.mu.Lock()
	h, ok := d.hosts[kind]
	d.mu.Unlock()
	if ok {
		return h, nil
	}
	h, err := d.Consult(ctx, kind)
	if err != nil {
		return "", err
	}
	d.mu.Lock()
	d.hosts[kind] = h
	d.mu.Unlock()
	return h, nil
}

// Forget drops the cached host of the kind, but only if it is still the given (failed) one.
func (d *Discovery) Forget(kind Kind, host string) {
	d.mu.Lock()
	if d.hosts[kind] == host {
		delete(d.hosts, kind)
	}
	d.mu.Unlock()
}
