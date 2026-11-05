package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
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

// declared holds the settings an operation declares in its `x-gateway` extension; nil means not declared (or ignored as invalid).
type declared struct {
	MaxPerMin   *int
	RateLimitBy *RateLimitBy
	RequireAuth *bool
	IsPublic    *bool
}

// specEndpoint is an operation of the spec: an endpoint with no kind, the settings it declares and the problems found in the declaration.
type specEndpoint struct {
	Endpoint
	decl     declared
	hasDecl  bool
	warnings []string
}

// apply returns the endpoint to insert: the declared settings, the defaults for the rest.
func (e specEndpoint) apply(kind Kind, defaultMax int) Endpoint {
	out := e.Endpoint
	out.Kind, out.MaxPerMin, out.RateLimitBy = kind, defaultMax, RateLimitUserOrIP
	if e.decl.MaxPerMin != nil {
		out.MaxPerMin = *e.decl.MaxPerMin
	}
	if e.decl.RateLimitBy != nil {
		out.RateLimitBy = *e.decl.RateLimitBy
	}
	if e.decl.RequireAuth != nil {
		out.RequireAuth = *e.decl.RequireAuth
	}
	if e.decl.IsPublic != nil {
		out.IsPublic = *e.decl.IsPublic
	}
	return out
}

// short cuts s so logging a malformed declaration cannot flood the log.
func short(s string) string {
	if len(s) > 40 {
		return s[:40] + "..."
	}
	return s
}

// parseGatewayExt reads an operation's `x-gateway` value. Each invalid key is ignored on its own and reported in warnings.
func parseGatewayExt(raw json.RawMessage) (d declared, warnings []string) {
	var ext map[string]json.RawMessage
	if err := json.Unmarshal(raw, &ext); err != nil || ext == nil {
		return d, []string{"x-gateway ignored: not a JSON object"}
	}
	bad := func(key, reason string) {
		warnings = append(warnings, fmt.Sprintf("x-gateway.%s ignored: %s (value %s)", key, reason, short(string(ext[key]))))
	}
	boolKey := func(key string) *bool {
		v, ok := ext[key]
		if !ok {
			return nil
		}
		var b bool
		if string(v) == "null" || json.Unmarshal(v, &b) != nil {
			bad(key, "not a boolean")
			return nil
		}
		return &b
	}
	d.IsPublic, d.RequireAuth = boolKey("isPublic"), boolKey("requireAuth")
	if v, ok := ext["maxPerMin"]; ok {
		if n, err := strconv.Atoi(string(v)); err != nil {
			bad("maxPerMin", "not an integer")
		} else if n < 0 {
			bad("maxPerMin", "negative")
		} else {
			d.MaxPerMin = &n
		}
	}
	if v, ok := ext["rateLimitBy"]; ok {
		var r RateLimitBy
		if json.Unmarshal(v, &r) != nil || !r.valid() {
			bad("rateLimitBy", "must be one of user_or_ip, ip, global")
		} else {
			d.RateLimitBy = &r
		}
	}
	var unknown []string
	for k := range ext {
		if k != "isPublic" && k != "requireAuth" && k != "maxPerMin" && k != "rateLimitBy" {
			unknown = append(unknown, short(k))
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		warnings = append(warnings, "x-gateway ignored unknown keys: "+strings.Join(unknown, ", "))
	}
	return d, warnings
}

// parseOpenAPI returns the operations of the spec's `paths` (method, path template and declared `x-gateway` settings).
// Keys of a path item that are not HTTP methods (parameters, summary, x-...) are ignored; a bad declaration never fails the parse.
func parseOpenAPI(r io.Reader) ([]specEndpoint, error) {
	var spec struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.NewDecoder(r).Decode(&spec); err != nil {
		return nil, err
	}
	if spec.Paths == nil {
		return nil, fmt.Errorf("spec has no paths")
	}
	var out []specEndpoint
	for path, item := range spec.Paths {
		for m, raw := range item {
			if !openAPIMethods[strings.ToLower(m)] {
				continue
			}
			e := specEndpoint{Endpoint: Endpoint{Method: strings.ToUpper(m), Path: path}}
			var op map[string]json.RawMessage
			if json.Unmarshal(raw, &op) == nil {
				if ext, ok := op["x-gateway"]; ok {
					e.hasDecl = true
					e.decl, e.warnings = parseGatewayExt(ext)
				}
			}
			out = append(out, e)
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

func (s *Syncer) fetch(ctx context.Context, kind Kind) ([]specEndpoint, error) {
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

// SyncKind adds the spec's endpoints missing from the store, with the settings each declares in `x-gateway` and the defaults for the rest
// (never touching existing maxPerMin, rateLimitBy, requireAuth or isPublic: the spec only seeds new endpoints)
// and removes stored ones absent from the spec. If fetching or parsing fails nothing is changed.
func (s *Syncer) SyncKind(ctx context.Context, kind Kind) (added, removed int, err error) {
	spec, err := s.fetch(ctx, kind)
	if err != nil {
		return 0, 0, err
	}
	inSpec := make(map[[2]string]bool, len(spec))
	declaring := 0
	for _, e := range spec {
		inSpec[[2]string{e.Method, e.Path}] = true
		for _, w := range e.warnings {
			log.Printf("sync %s: %s %s: %s", kind, e.Method, short(e.Path), w)
		}
		if e.hasDecl {
			declaring++
		}
		ok, err := s.store.InsertIfAbsent(ctx, e.apply(kind, s.defaultMax))
		if err != nil {
			return added, removed, err
		}
		if ok {
			added++
		}
	}
	log.Printf("sync %s: %d of %d endpoints declare x-gateway", kind, declaring, len(spec))
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
