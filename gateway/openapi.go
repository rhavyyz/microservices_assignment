package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"
)

const (
	syncMinDelay = 5 * time.Second
	syncMaxDelay = 60 * time.Second
)

var openAPIMethods = map[string]bool{
	"get": true, "put": true, "post": true, "delete": true,
	"patch": true, "head": true, "options": true, "trace": true,
}

// parseOpenAPI returns the (method, path template) pairs of the spec's `paths`, as endpoints with no kind.
func parseOpenAPI(r io.Reader) ([]Endpoint, error) {
	var spec struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.NewDecoder(r).Decode(&spec); err != nil {
		return nil, err
	}
	if spec.Paths == nil {
		return nil, fmt.Errorf("spec has no paths")
	}
	var out []Endpoint
	for path, item := range spec.Paths {
		for m := range item {
			if openAPIMethods[strings.ToLower(m)] {
				out = append(out, Endpoint{Method: strings.ToUpper(m), Path: path})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return out[i].Method < out[j].Method
	})
	return out, nil
}

// Syncer registers the endpoints described by each service's /openapi.json.
type Syncer struct {
	disc       *Discovery
	store      Store
	eps        *Endpoints
	client     *http.Client
	defaultMax int
	minDelay   time.Duration
	maxDelay   time.Duration
	indexed    bool
}

func NewSyncer(disc *Discovery, store Store, eps *Endpoints, defaultMax int) *Syncer {
	return &Syncer{disc: disc, store: store, eps: eps, client: &http.Client{Timeout: 10 * time.Second},
		defaultMax: defaultMax, minDelay: syncMinDelay, maxDelay: syncMaxDelay}
}

func (s *Syncer) fetch(ctx context.Context, kind Kind) ([]Endpoint, error) {
	host, err := s.disc.Host(ctx, kind)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+host+"/openapi.json", nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		s.disc.Forget(kind, host)
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("openapi.json: status %d", resp.StatusCode)
	}
	return parseOpenAPI(resp.Body)
}

// SyncKind adds the spec's endpoints missing from the store (never touching an existing maxPerMin)
// and removes stored ones absent from the spec. If fetching or parsing fails nothing is changed.
func (s *Syncer) SyncKind(ctx context.Context, kind Kind) (added, removed int, err error) {
	spec, err := s.fetch(ctx, kind)
	if err != nil {
		return 0, 0, err
	}
	inSpec := make(map[[2]string]bool, len(spec))
	for _, e := range spec {
		inSpec[[2]string{e.Method, e.Path}] = true
		e.Kind, e.MaxPerMin = kind, s.defaultMax
		ok, err := s.store.InsertIfAbsent(ctx, e)
		if err != nil {
			return added, removed, err
		}
		if ok {
			added++
		}
	}
	stored, err := s.store.List(ctx, kind)
	if err != nil {
		return added, removed, err
	}
	var stale []Endpoint
	for _, e := range stored {
		if !inSpec[[2]string{e.Method, e.Path}] {
			stale = append(stale, e)
		}
	}
	if err := s.store.Delete(ctx, stale); err != nil {
		return added, removed, err
	}
	return added, len(stale), nil
}

// Run syncs every kind in the background, retrying failed kinds with growing backoff
// until each has synced once.
func (s *Syncer) Run(ctx context.Context) {
	pending := append([]Kind(nil), allKinds...)
	delay := s.minDelay
	for {
		if !s.indexed {
			if err := s.store.EnsureIndex(ctx); err != nil {
				log.Printf("sync: ensuring index failed: %v", err)
			} else {
				s.indexed = true
			}
		}
		var failed []Kind
		for _, k := range pending {
			if !s.indexed {
				failed = append(failed, k)
				continue
			}
			added, removed, err := s.SyncKind(ctx, k)
			if err != nil {
				log.Printf("sync %s failed: %v", k, err)
				failed = append(failed, k)
				continue
			}
			log.Printf("sync %s: %d endpoints added, %d removed", k, added, removed)
		}
		if err := s.eps.Refresh(ctx); err != nil {
			log.Printf("sync: cache refresh failed: %v", err)
		}
		if len(failed) == 0 {
			log.Printf("sync: all kinds synced")
			return
		}
		pending = failed
		log.Printf("sync: retrying %v in %s", failed, delay)
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		if delay *= 2; delay > s.maxDelay {
			delay = s.maxDelay
		}
	}
}
