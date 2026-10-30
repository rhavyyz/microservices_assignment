package main

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"
)

const (
	healthPath    = "/healthcheck"
	healthRetries = 5
	probeTimeout  = 2 * time.Second
	retryDelay    = 200 * time.Millisecond
)

var (
	ErrUnknownKind = errors.New("unknown service kind")
	ErrNoInstance  = errors.New("no healthy instance available")
)

// kindEntry holds the hosts of one kind behind its own mutex.
type kindEntry struct {
	mu    sync.Mutex
	hosts map[string]struct{}
}

// Registry keeps the hosts of every kind in memory. The kinds map is filled
// once at construction and never changes, so it needs no lock of its own.
type Registry struct {
	kinds  map[Kind]*kindEntry
	client *http.Client
}

func NewRegistry() *Registry {
	r := &Registry{
		kinds:  make(map[Kind]*kindEntry, len(allKinds)),
		client: &http.Client{Timeout: probeTimeout},
	}
	for _, k := range allKinds {
		r.kinds[k] = &kindEntry{hosts: make(map[string]struct{})}
	}
	return r
}

func (r *Registry) Register(kind Kind, host string) error {
	e, ok := r.kinds[kind]
	if !ok {
		return ErrUnknownKind
	}
	e.mu.Lock()
	e.hosts[host] = struct{}{}
	e.mu.Unlock()
	return nil
}

// Consult probes every host of the kind in parallel and returns the first one
// that answers its health check. A host that fails all retries is removed.
func (r *Registry) Consult(ctx context.Context, kind Kind) (string, error) {
	e, ok := r.kinds[kind]
	if !ok {
		return "", ErrUnknownKind
	}

	e.mu.Lock()
	hosts := make([]string, 0, len(e.hosts))
	for h := range e.hosts {
		hosts = append(hosts, h)
	}
	e.mu.Unlock()

	if len(hosts) == 0 {
		return "", ErrNoInstance
	}

	type result struct {
		host string
		ok   bool
	}
	results := make(chan result, len(hosts))
	for _, h := range hosts {
		go func(h string) {
			// Probes are not tied to ctx: a down host must still finish its
			// retries and be removed even after another host already won.
			healthy := r.probe(h)
			if !healthy {
				e.mu.Lock()
				delete(e.hosts, h)
				e.mu.Unlock()
			}
			results <- result{h, healthy}
		}(h)
	}

	for range hosts {
		select {
		case res := <-results:
			if res.ok {
				return res.host, nil
			}
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	return "", ErrNoInstance
}

// probe calls the host's health endpoint, retrying up to healthRetries times.
func (r *Registry) probe(host string) bool {
	for i := 0; i < healthRetries; i++ {
		if i > 0 {
			time.Sleep(retryDelay)
		}
		resp, err := r.client.Get("http://" + host + healthPath)
		if err != nil {
			continue
		}
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return true
		}
	}
	return false
}
