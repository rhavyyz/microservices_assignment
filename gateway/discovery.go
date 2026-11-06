package main

import (
	"context"
	"net/http"

	"microservices/discovery"
)

var (
	ErrUnknownKind = discovery.ErrUnknownKind
	ErrNoInstance  = discovery.ErrNoInstance
)

// Discovery is the ctx-aware adapter the reverse proxy uses over the shared discovery lib, which caches
// one host per kind (DISCOVERY_CACHE_TTL_SECONDS) and reads SERVICE_DISCOVERER_URL. The proxy needs the
// host itself (httputil.ReverseProxy cannot go through discovery.Request).
type Discovery struct{}

// NewDiscovery returns a Discovery.
func NewDiscovery() *Discovery { return &Discovery{} }

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

// Host returns the lib's cached host of the kind, consulting the discoverer on a miss or an expired entry
// (the previous host is kept if that refresh fails). The lib takes no context: on cancellation this
// returns ctx.Err() at once and the lib call finishes in the background, bounded by the lib's HTTP timeout.
func (d *Discovery) Host(ctx context.Context, kind Kind) (string, error) {
	type result struct {
		host string
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		h, err := discovery.Host(discovery.Kind(kind))
		ch <- result{h, err}
	}()
	select {
	case r := <-ch:
		return r.host, r.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// Forget drops the cached host of the kind, but only if it is still the given (failed) one.
func (d *Discovery) Forget(kind Kind, host string) {
	discovery.Forget(discovery.Kind(kind), host)
}
