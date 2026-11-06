package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

const swaggerUIVersion = "5.17.14"

// parseDocsEvery validates DOCS_REFRESH_EVERY: a positive Go duration.
func parseDocsEvery(s string) (time.Duration, error) {
	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("DOCS_REFRESH_EVERY must be a positive Go duration, e.g. 5m")
	}
	return d, nil
}

// componentSections are the OpenAPI 3.x component sections whose entries are renamed and copied.
var componentSections = map[string]bool{
	"schemas": true, "parameters": true, "responses": true, "requestBodies": true,
	"headers": true, "examples": true, "links": true, "callbacks": true,
}

// Docs keeps the raw OpenAPI document of each kind and serves one document that merges them, filtered by the
// current endpoint table.
type Docs struct {
	eps      *Endpoints
	minDelay time.Duration
	maxDelay time.Duration

	mu      sync.Mutex
	specs   map[Kind]json.RawMessage
	specGen uint64
	// memo of the last built document, valid for (specGen, table generation).
	built    []byte
	builtFor [2]uint64
	hasBuilt bool
}

func NewDocs(eps *Endpoints) *Docs {
	return &Docs{eps: eps, specs: map[Kind]json.RawMessage{}, minDelay: syncMinDelay, maxDelay: syncMaxDelay}
}

// fetch gets the raw spec of a kind through the discovery lib, like the Syncer does.
func (d *Docs) fetch(ctx context.Context, kind Kind) (json.RawMessage, error) {
	resp, err := request(ctx, http.MethodGet, kind, "/openapi.json")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("openapi.json: status %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil || probe == nil {
		return nil, fmt.Errorf("openapi.json: not a JSON object")
	}
	return raw, nil
}

// RefreshKind replaces the stored spec of the kind; on failure the previous copy is kept.
func (d *Docs) RefreshKind(ctx context.Context, kind Kind) error {
	raw, err := d.fetch(ctx, kind)
	if err != nil {
		return err
	}
	d.mu.Lock()
	d.specs[kind] = raw
	d.specGen++
	d.mu.Unlock()
	return nil
}

// Refresh refreshes the given kinds and returns the ones that failed.
func (d *Docs) Refresh(ctx context.Context, kinds []Kind) []Kind {
	var failed []Kind
	for _, k := range kinds {
		if err := d.RefreshKind(ctx, k); err != nil {
			log.Printf("docs %s failed: %v", k, err)
			failed = append(failed, k)
		}
	}
	return failed
}

// Run fetches every spec at startup (retrying failed kinds with growing backoff until each answered once), then
// refreshes all of them every `every`.
func (d *Docs) Run(ctx context.Context, every time.Duration) {
	pending := append([]Kind(nil), allKinds...)
	delay := d.minDelay
	for len(pending) > 0 {
		if pending = d.Refresh(ctx, pending); len(pending) == 0 {
			break
		}
		log.Printf("docs: retrying %v in %s", pending, delay)
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		if delay *= 2; delay > d.maxDelay {
			delay = d.maxDelay
		}
	}
	log.Printf("docs: all specs fetched")
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.Refresh(ctx, allKinds)
		}
	}
}

// Document returns the merged document for the current specs and endpoint table (memoised on both generations).
func (d *Docs) Document() ([]byte, error) {
	pub, tableGen := d.eps.PublicSnapshot()
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.hasBuilt && d.builtFor == [2]uint64{d.specGen, tableGen} {
		return d.built, nil
	}
	body, err := buildOpenAPI(d.specs, pub)
	if err != nil {
		return nil, err
	}
	d.built, d.builtFor, d.hasBuilt = body, [2]uint64{d.specGen, tableGen}, true
	return body, nil
}

// ServeSpec serves GET /openapi.json.
func (d *Docs) ServeSpec(w http.ResponseWriter, _ *http.Request) {
	body, err := d.Document()
	if err != nil {
		log.Printf("docs: building the document failed: %v", err)
		http.Error(w, "openapi document unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(body)
}

var swaggerUIPage = template.Must(template.New("docs").Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EventHub gateway</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@{{.Version}}/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@{{.Version}}/swagger-ui-bundle.js"></script>
<script>
window.onload = function () {
  window.ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    persistAuthorization: true
  });
};
</script>
</body>
</html>
`))

// serveSwaggerUI serves GET /docs.
func serveSwaggerUI(w http.ResponseWriter, _ *http.Request) {
	var buf bytes.Buffer
	if err := swaggerUIPage.Execute(&buf, map[string]string{"Version": swaggerUIVersion}); err != nil {
		http.Error(w, "docs unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(buf.Bytes())
}

// ---- document builder ----

type anyMap = map[string]any

func decodeJSON(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber() // keep numbers as written
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// kindPrefix is the kind capitalised, restricted to the characters allowed in component names.
func kindPrefix(k Kind) string {
	s := sanitizeName(string(k))
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func sanitizeName(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			return r
		}
		return '_'
	}, s)
}

type compKey struct{ section, name string }

// kindMerger copies the operations of one kind into the document, renaming and collecting the components they reach.
type kindMerger struct {
	kind       Kind
	prefix     string
	components map[string]anyMap // the kind's own components, by section
	names      map[compKey]string
	taken      map[compKey]bool // new names in use, as compKey{section, newName}
	queue      []compKey
}

// newName returns the document-wide name of a component of this kind, queueing it for copying the first time.
func (m *kindMerger) newName(section, name string) string {
	k := compKey{section, name}
	if n, ok := m.names[k]; ok {
		return n
	}
	base := m.prefix + "_" + sanitizeName(name)
	n := base
	for i := 2; m.taken[compKey{section, n}]; i++ {
		n = fmt.Sprintf("%s_%d", base, i)
	}
	m.taken[compKey{section, n}] = true
	m.names[k] = n
	m.queue = append(m.queue, k)
	return n
}

func unescapePointer(s string) string {
	if u, err := url.PathUnescape(s); err == nil {
		s = u
	}
	return strings.NewReplacer("~1", "/", "~0", "~").Replace(s)
}

// rewriteRef maps "#/components/<section>/<name>[/rest]" to the renamed component; other refs are left as they are.
func (m *kindMerger) rewriteRef(ref string) string {
	const pfx = "#/components/"
	if !strings.HasPrefix(ref, pfx) {
		return ref
	}
	parts := strings.SplitN(strings.TrimPrefix(ref, pfx), "/", 3)
	if len(parts) < 2 || !componentSections[parts[0]] {
		return ref
	}
	section, name := parts[0], unescapePointer(parts[1])
	if _, ok := m.components[section][name]; !ok {
		log.Printf("docs %s: unresolvable ref %s left as is", m.kind, short(ref))
		return ref
	}
	out := pfx + section + "/" + m.newName(section, name)
	if len(parts) == 3 {
		out += "/" + parts[2]
	}
	return out
}

// rewrite returns a deep copy of v with every internal component ref renamed.
func (m *kindMerger) rewrite(v any) any {
	switch x := v.(type) {
	case anyMap:
		out := make(anyMap, len(x))
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys) // fixed visiting order: the names given to colliding components are deterministic
		for _, k := range keys {
			if ref, ok := x[k].(string); ok && k == "$ref" {
				out[k] = m.rewriteRef(ref)
				continue
			}
			out[k] = m.rewrite(x[k])
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = m.rewrite(e)
		}
		return out
	}
	return v
}

// drain copies the queued components (which may queue more) into out; cycles end because each is copied once.
func (m *kindMerger) drain(out map[string]anyMap) {
	for len(m.queue) > 0 {
		k := m.queue[0]
		m.queue = m.queue[1:]
		if out[k.section] == nil {
			out[k.section] = anyMap{}
		}
		out[k.section][m.names[k]] = m.rewrite(m.components[k.section][k.name])
	}
}

func asMap(v any) anyMap {
	m, _ := v.(anyMap)
	return m
}

// buildOpenAPI merges the raw specs into one document that lists only the public endpoints of the table.
func buildOpenAPI(specs map[Kind]json.RawMessage, pub []Endpoint) ([]byte, error) {
	table := make(map[[3]string]Endpoint, len(pub))
	for _, e := range pub {
		if e.IsPublic {
			table[[3]string{string(e.Kind), e.Method, e.Path}] = e
		}
	}
	kinds := make([]Kind, 0, len(specs))
	for k := range specs {
		kinds = append(kinds, k)
	}
	sort.Slice(kinds, func(i, j int) bool { return kinds[i] < kinds[j] })

	paths := anyMap{}
	components := map[string]anyMap{}
	usable := map[Kind]bool{}
	for _, kind := range kinds {
		v, err := decodeJSON(specs[kind])
		spec := asMap(v)
		if err != nil || spec == nil || asMap(spec["paths"]) == nil {
			log.Printf("docs %s: spec skipped: not a valid OpenAPI document", kind)
			continue
		}
		usable[kind] = true
		m := &kindMerger{kind: kind, prefix: kindPrefix(kind), components: map[string]anyMap{},
			names: map[compKey]string{}, taken: map[compKey]bool{}}
		for section, v := range asMap(spec["components"]) {
			if componentSections[section] {
				m.components[section] = asMap(v)
			}
		}
		specPaths := asMap(spec["paths"])
		pathKeys := make([]string, 0, len(specPaths))
		for p := range specPaths {
			pathKeys = append(pathKeys, p)
		}
		sort.Strings(pathKeys)
		for _, p := range pathKeys {
			item := asMap(specPaths[p])
			out := anyMap{}
			for key, v := range item {
				op := asMap(v)
				lk := strings.ToLower(key)
				if !openAPIMethods[lk] || op == nil {
					continue
				}
				e, ok := table[[3]string{string(kind), strings.ToUpper(key), p}]
				if !ok {
					continue
				}
				out[lk] = m.operation(op, e)
			}
			if len(out) == 0 {
				continue
			}
			for _, key := range []string{"summary", "description", "parameters"} {
				if v, ok := item[key]; ok {
					out[key] = m.rewrite(v)
				}
			}
			paths["/"+string(kind)+p] = out
		}
		m.drain(components)
	}

	components["securitySchemes"] = anyMap{"bearerAuth": anyMap{"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}}
	desc := "Endpoints currently public through the EventHub gateway. Private endpoints are never listed; the document follows the gateway's live endpoint table."
	var missing []string
	for _, k := range allKinds {
		if !usable[k] {
			missing = append(missing, string(k))
		}
	}
	if len(missing) > 0 {
		desc += " Spec currently unavailable for: " + strings.Join(missing, ", ") + "."
	}
	doc := anyMap{
		"openapi":    "3.0.3",
		"info":       anyMap{"title": "EventHub gateway", "version": "1.0.0", "description": desc},
		"servers":    []any{anyMap{"url": "/"}},
		"paths":      paths,
		"components": components,
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// operation copies a kept operation with the gateway's view of it: tag, security and x-gateway from the table.
func (m *kindMerger) operation(op anyMap, e Endpoint) anyMap {
	out := m.rewrite(op).(anyMap)
	delete(out, "servers")
	out["tags"] = []any{string(m.kind)}
	if id, ok := out["operationId"].(string); ok {
		out["operationId"] = string(m.kind) + "_" + id
	}
	if e.RequireAuth {
		out["security"] = []any{anyMap{"bearerAuth": []any{}}}
	} else {
		out["security"] = []any{}
	}
	out["x-gateway"] = anyMap{"isPublic": e.IsPublic, "requireAuth": e.RequireAuth, "maxPerMin": e.MaxPerMin, "rateLimitBy": e.withDefaults().RateLimitBy}
	return out
}
