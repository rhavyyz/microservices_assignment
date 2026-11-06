package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func rawSpecs(m map[Kind]string) map[Kind]json.RawMessage {
	out := map[Kind]json.RawMessage{}
	for k, v := range m {
		out[k] = json.RawMessage(v)
	}
	return out
}

func pubEp(kind Kind, method, path string, auth bool) Endpoint {
	e := ep(kind, method, path, 30)
	e.RequireAuth, e.RateLimitBy = auth, RateLimitIP
	return e
}

func buildDoc(t *testing.T, specs map[Kind]string, pub ...Endpoint) map[string]any {
	t.Helper()
	body, err := buildOpenAPI(rawSpecs(specs), pub)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	return doc
}

// at walks a decoded document by keys.
func at(t *testing.T, v any, keys ...string) any {
	t.Helper()
	for _, k := range keys {
		m, ok := v.(map[string]any)
		if !ok {
			t.Fatalf("no object before %q", k)
		}
		if v, ok = m[k]; !ok {
			return nil
		}
	}
	return v
}

const eventsSpec = `{
 "openapi":"3.0.2",
 "paths":{
  "/api/v1/events":{
   "parameters":[{"$ref":"#/components/parameters/Page"}],
   "get":{"operationId":"list","summary":"List","tags":["svc"],"security":[{"x":[]}],
          "x-gateway":{"isPublic":false,"maxPerMin":1},
          "responses":{"200":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/EventList"}}}}}},
   "post":{"operationId":"create","responses":{"201":{"description":"ok"}}}
  },
  "/internal/x":{"get":{"responses":{}}},
  "/only-private":{"get":{"responses":{}}}
 },
 "components":{
  "schemas":{
   "EventList":{"type":"array","items":{"$ref":"#/components/schemas/Event"}},
   "Event":{"type":"object","properties":{"parent":{"$ref":"#/components/schemas/Event"},"tag":{"$ref":"#/components/schemas/Tag"}}},
   "Tag":{"type":"string"},
   "Unused":{"type":"string"}
  },
  "parameters":{"Page":{"name":"page","in":"query","schema":{"type":"integer"}}},
  "securitySchemes":{"svc":{"type":"apiKey"}}
 }}`

const usersSpec = `{
 "openapi":"3.1.0",
 "paths":{"/users/{id}":{"get":{"operationId":"list","responses":{"200":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/Event"}}}}}}}},
 "components":{"schemas":{"Event":{"type":"integer","examples":[1]}}}}`

func TestBuildPrefixesPathsAndFiltersPublic(t *testing.T) {
	doc := buildDoc(t, map[Kind]string{Events: eventsSpec},
		pubEp(Events, "GET", "/api/v1/events", true),
		pubEp(Events, "POST", "/api/v1/events", false),
		pubEp(Events, "GET", "/not-in-spec", false),
		pubEp(User, "GET", "/api/v1/events", false)) // other kind: not in this spec
	paths := at(t, doc, "paths").(map[string]any)
	if len(paths) != 1 || paths["/events/api/v1/events"] == nil {
		t.Fatalf("paths: %v", paths)
	}
	if at(t, doc, "openapi") != "3.0.3" || at(t, doc, "info", "title") != "EventHub gateway" || at(t, doc, "info", "version") != "1.0.0" {
		t.Errorf("header: %v %v", doc["openapi"], doc["info"])
	}
	if srv := at(t, doc, "servers").([]any); len(srv) != 1 || srv[0].(map[string]any)["url"] != "/" {
		t.Errorf("servers: %v", srv)
	}
	if at(t, doc, "components", "securitySchemes", "bearerAuth", "scheme") != "bearer" ||
		at(t, doc, "components", "securitySchemes", "bearerAuth", "bearerFormat") != "JWT" ||
		at(t, doc, "components", "securitySchemes", "bearerAuth", "type") != "http" {
		t.Errorf("bearerAuth missing")
	}
	if at(t, doc, "components", "securitySchemes", "svc") != nil {
		t.Errorf("service security scheme leaked")
	}
}

func TestBuildPrivateEndpointsOmittedAndDroppedPaths(t *testing.T) {
	// Only a private-table endpoint (not passed in the public snapshot) and no public ones: no paths at all.
	doc := buildDoc(t, map[Kind]string{Events: eventsSpec})
	if p := at(t, doc, "paths").(map[string]any); len(p) != 0 {
		t.Errorf("paths: %v", p)
	}
	if c := at(t, doc, "components").(map[string]any); c["schemas"] != nil || c["parameters"] != nil {
		t.Errorf("unreachable components copied: %v", c)
	}
	// A private flag on a snapshot entry is ignored too.
	priv := private(pubEp(Events, "GET", "/api/v1/events", false))
	doc = buildDoc(t, map[Kind]string{Events: eventsSpec}, priv)
	if p := at(t, doc, "paths").(map[string]any); len(p) != 0 {
		t.Errorf("private listed: %v", p)
	}
}

func TestBuildSecurityOperationIDAndXGateway(t *testing.T) {
	doc := buildDoc(t, map[Kind]string{Events: eventsSpec},
		pubEp(Events, "GET", "/api/v1/events", true),
		pubEp(Events, "POST", "/api/v1/events", false))
	item := at(t, doc, "paths", "/events/api/v1/events")
	get, post := at(t, item, "get"), at(t, item, "post")
	if s := at(t, get, "security").([]any); len(s) != 1 || s[0].(map[string]any)["bearerAuth"] == nil {
		t.Errorf("get security: %v", s)
	}
	if s, ok := at(t, post, "security").([]any); !ok || len(s) != 0 {
		t.Errorf("post security: %v", at(t, post, "security"))
	}
	if at(t, get, "operationId") != "events_list" || at(t, post, "operationId") != "events_create" {
		t.Errorf("operationIds: %v %v", at(t, get, "operationId"), at(t, post, "operationId"))
	}
	if tags := at(t, get, "tags").([]any); len(tags) != 1 || tags[0] != "events" {
		t.Errorf("tags: %v", tags)
	}
	if at(t, get, "summary") != "List" {
		t.Errorf("summary dropped")
	}
	want := map[string]any{"isPublic": true, "requireAuth": true, "maxPerMin": float64(30), "rateLimitBy": "ip"}
	gw := at(t, get, "x-gateway").(map[string]any)
	if len(gw) != 4 {
		t.Errorf("x-gateway: %v", gw)
	}
	for k, v := range want {
		if gw[k] != v {
			t.Errorf("x-gateway.%s = %v, want %v", k, gw[k], v)
		}
	}
	// Endpoint without a stored rateLimitBy reads as the default.
	e := ep(Events, "POST", "/api/v1/events", 5)
	doc = buildDoc(t, map[Kind]string{Events: eventsSpec}, e)
	if at(t, doc, "paths", "/events/api/v1/events", "post", "x-gateway", "rateLimitBy") != "user_or_ip" {
		t.Errorf("default rateLimitBy missing")
	}
}

func TestBuildComponentsRenamedTransitivelyAndPerKind(t *testing.T) {
	doc := buildDoc(t, map[Kind]string{Events: eventsSpec, User: usersSpec},
		pubEp(Events, "GET", "/api/v1/events", false),
		pubEp(User, "GET", "/users/{id}", false))
	schemas := at(t, doc, "components", "schemas").(map[string]any)
	for _, n := range []string{"Events_EventList", "Events_Event", "Events_Tag", "User_Event"} {
		if schemas[n] == nil {
			t.Errorf("missing %s in %v", n, schemas)
		}
	}
	if len(schemas) != 4 {
		t.Errorf("extra components (Unused must not be copied): %v", schemas)
	}
	if at(t, schemas, "Events_EventList", "items", "$ref") != "#/components/schemas/Events_Event" ||
		at(t, schemas, "Events_Event", "properties", "tag", "$ref") != "#/components/schemas/Events_Tag" {
		t.Errorf("refs not rewritten transitively: %v", schemas)
	}
	// Cycle: Event -> Event survives.
	if at(t, schemas, "Events_Event", "properties", "parent", "$ref") != "#/components/schemas/Events_Event" {
		t.Errorf("cycle ref wrong")
	}
	if at(t, schemas, "User_Event", "type") != "integer" {
		t.Errorf("User_Event: %v", schemas["User_Event"])
	}
	if at(t, doc, "paths", "/user/users/{id}", "get", "responses", "200", "content", "application/json", "schema", "$ref") != "#/components/schemas/User_Event" {
		t.Errorf("user op ref not rewritten")
	}
	// Path-level parameters and their refs.
	item := at(t, doc, "paths", "/events/api/v1/events")
	params := at(t, item, "parameters").([]any)
	if len(params) != 1 || at(t, params[0], "$ref") != "#/components/parameters/Events_Page" {
		t.Errorf("path-level parameters: %v", params)
	}
	if at(t, doc, "components", "parameters", "Events_Page", "name") != "page" {
		t.Errorf("parameter component not copied")
	}
}

func TestBuildRefEdgeCases(t *testing.T) {
	spec := `{"paths":{"/a":{"get":{"responses":{"200":{"content":{"x":{"schema":{"allOf":[
	  {"$ref":"https://example.com/s.json"},
	  {"$ref":"#/components/schemas/Missing"},
	  {"$ref":"#/components/schemas/a~1b%20c/properties/p"},
	  {"$ref":"#/definitions/Old"}]}}}}}}}},
	 "components":{"schemas":{"a/b c":{"type":"object","properties":{"p":{"type":"string"}}},"a_b_c":{"type":"string"}}}}`
	doc := buildDoc(t, map[Kind]string{Events: spec}, pubEp(Events, "GET", "/a", false))
	all := at(t, doc, "paths", "/events/a", "get", "responses", "200", "content", "x", "schema", "allOf").([]any)
	got := []any{at(t, all[0], "$ref"), at(t, all[1], "$ref"), at(t, all[2], "$ref"), at(t, all[3], "$ref")}
	want := []any{"https://example.com/s.json", "#/components/schemas/Missing", "#/components/schemas/Events_a_b_c/properties/p", "#/definitions/Old"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("ref %d = %v, want %v", i, got[i], want[i])
		}
	}
	if at(t, doc, "components", "schemas", "Events_a_b_c", "type") != "object" {
		t.Errorf("sanitised component missing")
	}
}

func TestBuildSanitisedNameCollision(t *testing.T) {
	spec := `{"paths":{"/a":{"get":{"responses":{"200":{"content":{"x":{"schema":{"allOf":[
	  {"$ref":"#/components/schemas/a b"},{"$ref":"#/components/schemas/a_b"}]}}}}}}}},
	 "components":{"schemas":{"a b":{"type":"string"},"a_b":{"type":"integer"}}}}`
	doc := buildDoc(t, map[Kind]string{Events: spec}, pubEp(Events, "GET", "/a", false))
	schemas := at(t, doc, "components", "schemas").(map[string]any)
	if len(schemas) != 2 {
		t.Errorf("colliding sanitised names merged: %v", schemas)
	}
}

func TestBuildMissingAndMalformedSpecsSkipped(t *testing.T) {
	specs := map[Kind]string{
		Events:       eventsSpec,
		User:         `{not json`,
		Payments:     `[1,2]`,
		Reports:      `{"paths":"nope"}`,
		Certificates: `null`,
	}
	doc := buildDoc(t, specs,
		pubEp(Events, "GET", "/api/v1/events", false),
		pubEp(User, "GET", "/users/{id}", false))
	paths := at(t, doc, "paths").(map[string]any)
	if len(paths) != 1 || paths["/events/api/v1/events"] == nil {
		t.Errorf("paths: %v", paths)
	}
	desc := at(t, doc, "info", "description").(string)
	if !strings.Contains(desc, "unavailable for: certificates, subscription, payments, user, notifications, reports.") || strings.Contains(desc, "events,") {
		t.Errorf("description: %q", desc)
	}
	if !strings.Contains(desc, "Private endpoints are never listed") {
		t.Errorf("description: %q", desc)
	}
}

func TestBuildAllKindsAvailableOmitsUnavailableSentence(t *testing.T) {
	specs := map[Kind]string{}
	for _, k := range allKinds {
		specs[k] = `{"paths":{}}`
	}
	doc := buildDoc(t, specs)
	if d := at(t, doc, "info", "description").(string); strings.Contains(d, "unavailable") {
		t.Errorf("description: %q", d)
	}
}

func TestBuildDeterministic(t *testing.T) {
	specs := rawSpecs(map[Kind]string{Events: eventsSpec, User: usersSpec})
	a := []Endpoint{pubEp(Events, "GET", "/api/v1/events", true), pubEp(User, "GET", "/users/{id}", false), pubEp(Events, "POST", "/api/v1/events", false)}
	b := []Endpoint{a[2], a[0], a[1]}
	first, err := buildOpenAPI(specs, a)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		got, _ := buildOpenAPI(specs, b)
		if !bytes.Equal(first, got) {
			t.Fatalf("output differs on run %d", i)
		}
	}
}

func TestBuildOpenAPI31StyleInput(t *testing.T) {
	spec := `{"openapi":"3.1.0","info":{"title":"x"},"paths":{"/a":{"get":{"responses":{"200":{"description":"ok","content":{"application/json":{"schema":{"type":["string","null"],"$ref":"#/components/schemas/S","description":"sibling"}}}}}}}},
	 "components":{"schemas":{"S":{"type":"object","properties":{"n":{"type":"integer","exclusiveMinimum":0}}}}}}`
	doc := buildDoc(t, map[Kind]string{Events: spec}, pubEp(Events, "GET", "/a", false))
	s := at(t, doc, "paths", "/events/a", "get", "responses", "200", "content", "application/json", "schema")
	if at(t, s, "$ref") != "#/components/schemas/Events_S" || at(t, s, "description") != "sibling" {
		t.Errorf("3.1 schema: %v", s)
	}
	if at(t, doc, "components", "schemas", "Events_S", "properties", "n", "exclusiveMinimum") != float64(0) {
		t.Errorf("schema content changed")
	}
	if at(t, doc, "openapi") != "3.0.3" {
		t.Errorf("openapi version")
	}
}

// ---- Docs component ----

// specServer serves the given body at /openapi.json; the body and status can change between calls.
type specServer struct {
	mu     sync.Mutex
	body   string
	status int
	hits   int
	srv    *httptest.Server
}

func newSpecServer(t *testing.T, body string) *specServer {
	s := &specServer{body: body, status: 200}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.hits++
		w.WriteHeader(s.status)
		fmt.Fprint(w, s.body)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *specServer) set(status int, body string) {
	s.mu.Lock()
	s.status, s.body = status, body
	s.mu.Unlock()
}

func TestDocsRefreshKeepsPreviousCopyOnFailure(t *testing.T) {
	svc := newSpecServer(t, eventsSpec)
	fakeDiscoverer(t, map[string][]string{"events": {hostOf(svc.srv)}})
	store := newFakeStore(ep(Events, "GET", "/api/v1/events", 1))
	eps := NewEndpoints(store)
	eps.Refresh(context.Background())
	d := NewDocs(eps)
	if err := d.RefreshKind(context.Background(), Events); err != nil {
		t.Fatal(err)
	}
	first, _ := d.Document()
	for _, bad := range []struct {
		status int
		body   string
	}{{500, "boom"}, {200, "{not json"}, {200, "[]"}} {
		svc.set(bad.status, bad.body)
		if err := d.RefreshKind(context.Background(), Events); err == nil {
			t.Errorf("%d %q: expected an error", bad.status, bad.body)
		}
		if got, _ := d.Document(); !bytes.Equal(first, got) {
			t.Errorf("%d %q: previous copy lost", bad.status, bad.body)
		}
	}
	if !strings.Contains(string(first), "/events/api/v1/events") {
		t.Errorf("document: %s", first)
	}
	// A kind that never answered is absent, not an error.
	if failed := d.Refresh(context.Background(), []Kind{Events, User}); len(failed) != 2 {
		t.Errorf("failed: %v", failed)
	}
}

func TestDocsRunRetriesUntilEveryKindAnswers(t *testing.T) {
	svc := newSpecServer(t, `{"paths":{}}`)
	svc.set(503, "")
	fakeDiscoverer(t, map[string][]string{})
	d := NewDocs(NewEndpoints(newFakeStore()))
	d.minDelay, d.maxDelay = time.Millisecond, 2*time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { d.Run(ctx, time.Hour); close(done) }()
	time.Sleep(20 * time.Millisecond) // kinds fail (no discoverer instance): Run keeps retrying
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop on cancel")
	}
}

func TestDocsReflectsTableChangesAndMemoises(t *testing.T) {
	svc := newSpecServer(t, eventsSpec)
	fakeDiscoverer(t, map[string][]string{"events": {hostOf(svc.srv)}})
	store := newFakeStore(private(ep(Events, "GET", "/api/v1/events", 1)))
	eps := NewEndpoints(store)
	eps.Refresh(context.Background())
	d := NewDocs(eps)
	d.RefreshKind(context.Background(), Events)
	body, _ := d.Document()
	if strings.Contains(string(body), "/events/api/v1/events") {
		t.Fatal("private endpoint listed")
	}
	again, _ := d.Document()
	if &body[0] != &again[0] {
		t.Errorf("document rebuilt without a change")
	}
	// Admin makes it public through the real handler.
	gw := newMuxFor(t, store, eps, d)
	resp, out := get(t, "PUT", gw.URL+"/admin/endpoints", `{"kind":"events","method":"GET","path":"/api/v1/events","isPublic":true,"requireAuth":true}`, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("PUT: %d %s", resp.StatusCode, out)
	}
	resp, out = get(t, "GET", gw.URL+"/openapi.json", "", nil)
	if !strings.Contains(out, `"/events/api/v1/events"`) || !strings.Contains(out, `"bearerAuth": []`) {
		t.Errorf("public change not reflected: %d %s", resp.StatusCode, out)
	}
	get(t, "PUT", gw.URL+"/admin/endpoints", `{"kind":"events","method":"GET","path":"/api/v1/events","isPublic":false}`, nil)
	_, out = get(t, "GET", gw.URL+"/openapi.json", "", nil)
	if strings.Contains(out, `"/events/api/v1/events"`) {
		t.Errorf("private change not reflected: %s", out)
	}
}

func newMuxFor(t *testing.T, store Store, eps *Endpoints, d *Docs) *httptest.Server {
	t.Helper()
	v := testVerifier(t)
	srv := httptest.NewServer(newMux(store, eps, NewHub(), v, d, NewPipeline(eps, v, NewLimiter(time.Now), nil, NewProxy(NewDiscovery()))))
	t.Cleanup(srv.Close)
	return srv
}

func TestOpenAPIEndpointHTTP(t *testing.T) {
	store := newFakeStore(ep(Events, "GET", "/api/v1/events", 1))
	gw, eps := newGateway(t, store, NewDiscovery())
	_ = eps
	resp, body := get(t, "GET", gw.URL+"/openapi.json", "", map[string]string{"Origin": "http://x.test"})
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/json" || resp.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("%d %v", resp.StatusCode, resp.Header)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") == "" {
		t.Errorf("CORS wrapper missing")
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(body), &doc); err != nil {
		t.Fatal(err)
	}
	if doc["openapi"] != "3.0.3" || doc["paths"] == nil || doc["components"] == nil || doc["info"] == nil {
		t.Errorf("structure: %s", body)
	}
}

func TestDocsPageHTTP(t *testing.T) {
	gw, _ := newGateway(t, newFakeStore(), NewDiscovery())
	resp, body := get(t, "GET", gw.URL+"/docs", "", nil) // no Authorization
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") || resp.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("%d %v", resp.StatusCode, resp.Header)
	}
	for _, want := range []string{
		"https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css",
		"https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js",
		"url: '/openapi.json'", "persistAuthorization: true", "<title>EventHub gateway</title>",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("page lacks %q", want)
		}
	}
}

func TestOpenAPIConcurrentRequestsAndRefreshes(t *testing.T) {
	svc := newSpecServer(t, eventsSpec)
	fakeDiscoverer(t, map[string][]string{"events": {hostOf(svc.srv)}})
	store := newFakeStore(ep(Events, "GET", "/api/v1/events", 1))
	eps := NewEndpoints(store)
	eps.Refresh(context.Background())
	d := NewDocs(eps)
	var wg sync.WaitGroup
	var bad atomic.Int32
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 30; j++ {
				d.RefreshKind(context.Background(), Events)
				eps.Refresh(context.Background())
				if b, err := d.Document(); err != nil || !json.Valid(b) {
					bad.Add(1)
				}
			}
		}()
	}
	wg.Wait()
	if bad.Load() != 0 {
		t.Errorf("%d bad documents", bad.Load())
	}
}

func TestParseDocsEvery(t *testing.T) {
	for in, want := range map[string]time.Duration{"5m": 5 * time.Minute, "30s": 30 * time.Second, "1h30m": 90 * time.Minute} {
		if got, err := parseDocsEvery(in); err != nil || got != want {
			t.Errorf("%s: %v %v", in, got, err)
		}
	}
	for _, in := range []string{"", "abc", "0", "0s", "-5m", "5"} {
		if _, err := parseDocsEvery(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
}
