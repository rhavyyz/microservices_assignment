package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"
)

const (
	healthPath    = "/healthcheck"
	healthRetries = 5
	probeTimeout  = 2 * time.Second
	retryDelay    = 200 * time.Millisecond

	defaultRecheckInterval    = 5 * time.Second
	defaultRecheckMaxFailures = 12
)

var (
	ErrUnknownKind = errors.New("unknown service kind")
	ErrNoInstance  = errors.New("no healthy instance available")
)

// Config tunes the background recheck of hosts that failed a probe.
type Config struct {
	RecheckInterval    time.Duration // how often recovering hosts are probed
	RecheckMaxFailures int           // consecutive failed rechecks before a host is dropped
}

// kindEntry holds the hosts of one kind behind its own mutex. hosts are in
// rotation; recovering maps a host that failed a probe to its consecutive
// failed rechecks.
type kindEntry struct {
	mu         sync.Mutex
	hosts      map[string]struct{}
	recovering map[string]int
}

// Registry keeps the hosts of every kind in memory. The kinds map is filled
// once at construction and never changes, so it needs no lock of its own.
type Registry struct {
	kinds  map[Kind]*kindEntry
	client *http.Client
	cfg    Config
}

func NewRegistry() *Registry {
	return NewRegistryWithConfig(Config{defaultRecheckInterval, defaultRecheckMaxFailures})
}

func NewRegistryWithConfig(cfg Config) *Registry {
	r := &Registry{
		kinds:  make(map[Kind]*kindEntry, len(allKinds)),
		client: &http.Client{Timeout: probeTimeout},
		cfg:    cfg,
	}
	for _, k := range allKinds {
		r.kinds[k] = &kindEntry{hosts: make(map[string]struct{}), recovering: make(map[string]int)}
	}
	return r
}

func (r *Registry) Register(kind Kind, host string) error {
	e, ok := r.kinds[kind]
	if !ok {
		return ErrUnknownKind
	}
	e.mu.Lock()
	delete(e.recovering, host)
	e.hosts[host] = struct{}{}
	e.mu.Unlock()
	return nil
}

// Consult probes every host of the kind in parallel and returns the first one
// that answers its health check. A host that fails all retries moves to
// recovering, where the background recheck takes over.
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
			// retries and leave rotation even after another host already won.
			healthy := r.probe(h)
			if !healthy {
				e.markRecovering(kind, h)
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

// markRecovering moves an active host to recovering. A no-op if a concurrent
// consult already moved it, or it is no longer active.
func (e *kindEntry) markRecovering(kind Kind, host string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.hosts[host]; !ok {
		return
	}
	delete(e.hosts, host)
	e.recovering[host] = 0
	log.Printf("%s %s failed health check, recovering", kind, host)
}

// Run rechecks recovering hosts every RecheckInterval until ctx is done.
func (r *Registry) Run(ctx context.Context) {
	t := time.NewTicker(r.cfg.RecheckInterval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			r.recheckOnce()
		case <-ctx.Done():
			return
		}
	}
}

// recheckOnce probes every recovering host once, in parallel, and applies the
// results. A healthy host goes back to rotation; one that has now failed
// RecheckMaxFailures times in a row is dropped.
func (r *Registry) recheckOnce() {
	var wg sync.WaitGroup
	for kind, e := range r.kinds {
		e.mu.Lock()
		hosts := make([]string, 0, len(e.recovering))
		for h := range e.recovering {
			hosts = append(hosts, h)
		}
		e.mu.Unlock()

		for _, h := range hosts {
			wg.Add(1)
			go func(kind Kind, e *kindEntry, h string) {
				defer wg.Done()
				ok := r.probeOnce(h)
				r.applyRecheck(kind, e, h, ok)
			}(kind, e, h)
		}
	}
	wg.Wait()
}

// applyRecheck records one recheck result, ignoring hosts that are no longer
// recovering (e.g. re-registered while the probe was in flight).
func (r *Registry) applyRecheck(kind Kind, e *kindEntry, host string, ok bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	n, still := e.recovering[host]
	if !still {
		return
	}
	if ok {
		delete(e.recovering, host)
		e.hosts[host] = struct{}{}
		log.Printf("%s %s recovered after %d failed rechecks", kind, host, n)
		return
	}
	n++
	if n >= r.cfg.RecheckMaxFailures {
		delete(e.recovering, host)
		log.Printf("%s %s dropped after %d failed rechecks", kind, host, n)
		return
	}
	e.recovering[host] = n
}

// probe calls the host's health endpoint, retrying up to healthRetries times.
func (r *Registry) probe(host string) bool {
	for i := 0; i < healthRetries; i++ {
		if i > 0 {
			time.Sleep(retryDelay)
		}
		if r.probeOnce(host) {
			return true
		}
	}
	return false
}

// probeOnce makes a single health check request.
func (r *Registry) probeOnce(host string) bool {
	resp, err := r.client.Get("http://" + host + healthPath)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
