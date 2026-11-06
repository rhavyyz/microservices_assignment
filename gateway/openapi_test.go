package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// parseOne parses a spec with a single GET /x operation and returns it.
func parseOne(t *testing.T, op string) specEndpoint {
	got, err := parseOpenAPI(strings.NewReader(`{"paths":{"/x":{"get":` + op + `}}}`))
	if err != nil || len(got) != 1 {
		t.Fatalf("parse: %v %+v", err, got)
	}
	return got[0]
}

// resolved is the endpoint SyncKind would insert, with a default max of 60.
func resolved(e specEndpoint) Endpoint { return e.apply(Events, 60) }

func TestParseDeclarationFull(t *testing.T) {
	e := parseOne(t, `{"x-gateway":{"isPublic":true,"requireAuth":true,"maxPerMin":120,"rateLimitBy":"ip"}}`)
	want := Endpoint{Kind: Events, Method: "GET", Path: "/x", MaxPerMin: 120, RateLimitBy: RateLimitIP, RequireAuth: true, IsPublic: true}
	if got := resolved(e); got != want || !e.hasDecl || len(e.warnings) != 0 {
		t.Errorf("got %+v hasDecl=%v warnings=%v", got, e.hasDecl, e.warnings)
	}
}

func TestParseDeclarationPartial(t *testing.T) {
	e := parseOne(t, `{"x-gateway":{"isPublic":true}}`)
	want := Endpoint{Kind: Events, Method: "GET", Path: "/x", MaxPerMin: 60, RateLimitBy: RateLimitUserOrIP, IsPublic: true}
	if got := resolved(e); got != want || len(e.warnings) != 0 {
		t.Errorf("got %+v warnings=%v", got, e.warnings)
	}
}

func TestParseNoDeclarationIsPrivateDefaults(t *testing.T) {
	for _, op := range []string{`{}`, `{"summary":"x"}`, `null`, `"junk"`} {
		e := parseOne(t, op)
		want := Endpoint{Kind: Events, Method: "GET", Path: "/x", MaxPerMin: 60, RateLimitBy: RateLimitUserOrIP}
		if got := resolved(e); got != want || e.hasDecl || len(e.warnings) != 0 {
			t.Errorf("%s: got %+v hasDecl=%v warnings=%v", op, got, e.hasDecl, e.warnings)
		}
	}
}

func TestParseInvalidKeysIgnoredIndividually(t *testing.T) {
	for _, c := range []struct{ decl, key string }{
		{`"isPublic":"yes"`, "isPublic"},
		{`"isPublic":null`, "isPublic"},
		{`"requireAuth":1`, "requireAuth"},
		{`"maxPerMin":-1`, "maxPerMin"},
		{`"maxPerMin":"10"`, "maxPerMin"},
		{`"maxPerMin":1.5`, "maxPerMin"},
		{`"maxPerMin":99999999999999999999999`, "maxPerMin"},
		{`"rateLimitBy":"everyone"`, "rateLimitBy"},
		{`"rateLimitBy":5`, "rateLimitBy"},
	} {
		// The other keys are valid and must survive the bad one.
		others := map[string]string{"isPublic": `true`, "requireAuth": `true`, "maxPerMin": `5`, "rateLimitBy": `"global"`}
		delete(others, c.key)
		decl := c.decl
		for k, v := range others {
			decl += `,"` + k + `":` + v
		}
		e := parseOne(t, `{"x-gateway":{`+decl+`}}`)
		if len(e.warnings) != 1 || !strings.HasPrefix(e.warnings[0], "x-gateway."+c.key+" ignored: ") {
			t.Errorf("%s: warnings %v", c.decl, e.warnings)
		}
	}
	// Bad key alone: that key takes the default, the others are kept.
	e := parseOne(t, `{"x-gateway":{"maxPerMin":-3,"isPublic":true,"rateLimitBy":"nope","requireAuth":true}}`)
	want := Endpoint{Kind: Events, Method: "GET", Path: "/x", MaxPerMin: 60, RateLimitBy: RateLimitUserOrIP, RequireAuth: true, IsPublic: true}
	if got := resolved(e); got != want || len(e.warnings) != 2 {
		t.Errorf("got %+v warnings=%v", got, e.warnings)
	}
}

func TestParseNonObjectDeclaration(t *testing.T) {
	for _, d := range []string{`true`, `"public"`, `[1]`, `null`, `5`} {
		e := parseOne(t, `{"x-gateway":`+d+`}`)
		want := Endpoint{Kind: Events, Method: "GET", Path: "/x", MaxPerMin: 60, RateLimitBy: RateLimitUserOrIP}
		if got := resolved(e); got != want || len(e.warnings) != 1 || e.warnings[0] != "x-gateway ignored: not a JSON object" {
			t.Errorf("%s: got %+v warnings=%v", d, got, e.warnings)
		}
	}
}

func TestParseUnknownKeysWarnOnce(t *testing.T) {
	e := parseOne(t, `{"x-gateway":{"isPublic":true,"foo":1,"bar":2}}`)
	if got := resolved(e); !got.IsPublic {
		t.Errorf("known key lost: %+v", got)
	}
	if len(e.warnings) != 1 || e.warnings[0] != "x-gateway ignored unknown keys: bar, foo" {
		t.Errorf("warnings %v", e.warnings)
	}
}

func TestParseMaxPerMinZeroAccepted(t *testing.T) {
	e := parseOne(t, `{"x-gateway":{"maxPerMin":0}}`)
	if got := resolved(e); got.MaxPerMin != 0 || len(e.warnings) != 0 {
		t.Errorf("got %+v warnings=%v", got, e.warnings)
	}
}

func TestParseWarningsTruncateValues(t *testing.T) {
	e := parseOne(t, `{"x-gateway":{"isPublic":"`+strings.Repeat("a", 5000)+`"}}`)
	if len(e.warnings) != 1 || len(e.warnings[0]) > 150 {
		t.Errorf("warning not truncated: %d bytes", len(e.warnings[0]))
	}
}

func TestParsePathItemKeysStillIgnored(t *testing.T) {
	spec := `{"paths":{"/a":{"parameters":[{"name":"id"}],"summary":"s","x-foo":{"x-gateway":{"isPublic":true}},"$ref":"#/x",
		"get":{"x-gateway":{"isPublic":true}},"post":{}}}}`
	got, err := parseOpenAPI(strings.NewReader(spec))
	if err != nil || len(got) != 2 {
		t.Fatalf("%v %+v", err, got)
	}
	if got[0].Method != "GET" || !resolved(got[0]).IsPublic || got[1].Method != "POST" || resolved(got[1]).IsPublic {
		t.Errorf("unexpected %+v", got)
	}
}

func TestSyncInsertsDeclaredValues(t *testing.T) {
	svc := openAPIServer(t, `{"paths":{
		"/pub":{"get":{"x-gateway":{"isPublic":true,"requireAuth":true,"maxPerMin":5,"rateLimitBy":"global"}}},
		"/bad":{"get":{"x-gateway":{"isPublic":"yes","maxPerMin":-1}}},
		"/none":{"get":{}}}}`, 200)
	fakeDiscoverer(t, map[string][]string{"events": {hostOf(svc)}})
	store := newFakeStore()
	s := NewSyncer(store, NewEndpoints(store), 60)
	if added, _, err := s.SyncKind(context.Background(), Events); err != nil || added != 3 {
		t.Fatalf("added=%d err=%v", added, err)
	}
	list, _ := store.List(context.Background(), Events) // sorted by path: /bad, /none, /pub
	pub := Endpoint{Kind: Events, Method: "GET", Path: "/pub", MaxPerMin: 5, RateLimitBy: RateLimitGlobal, RequireAuth: true, IsPublic: true}
	def := Endpoint{Kind: Events, Method: "GET", MaxPerMin: 60, RateLimitBy: RateLimitUserOrIP}
	bad, none := def, def
	bad.Path, none.Path = "/bad", "/none"
	if list[0] != bad || list[1] != none || list[2] != pub {
		t.Errorf("unexpected store: %+v", list)
	}
}

func TestSyncDoesNotOverwriteAdminEditedEndpoint(t *testing.T) {
	svc := openAPIServer(t, `{"paths":{"/a":{"get":{"x-gateway":{"isPublic":true,"requireAuth":false,"maxPerMin":999,"rateLimitBy":"ip"}}}}}`, 200)
	fakeDiscoverer(t, map[string][]string{"events": {hostOf(svc)}})
	stored := epWith(Events, "GET", "/a", 7, RateLimitGlobal, true)
	stored.IsPublic = false // admin made it private
	store := newFakeStore(stored)
	s := NewSyncer(store, NewEndpoints(store), 60)
	if added, removed, err := s.SyncKind(context.Background(), Events); err != nil || added != 0 || removed != 0 {
		t.Fatalf("added=%d removed=%d err=%v", added, removed, err)
	}
	if list, _ := store.List(context.Background(), Events); list[0] != stored {
		t.Errorf("declaration overwrote the stored endpoint: %+v", list[0])
	}
}

func TestSyncWithBadDeclarationsStillSucceeds(t *testing.T) {
	svc := openAPIServer(t, `{"paths":{"/a":{"get":{"x-gateway":"oops"}},"/b":{"get":{"x-gateway":{"maxPerMin":"x","zzz":1}}}}}`, 200)
	fakeDiscoverer(t, map[string][]string{"events": {hostOf(svc)}})
	store := newFakeStore(ep(Events, "GET", "/gone", 1))
	s := NewSyncer(store, NewEndpoints(store), 60)
	if added, removed, err := s.SyncKind(context.Background(), Events); err != nil || added != 2 || removed != 1 {
		t.Errorf("added=%d removed=%d err=%v", added, removed, err)
	}
}

// A declaration with isPublic:true makes the endpoint reachable through the gateway right after the sync, with no admin PUT.
func TestDeclaredPublicEndpointIsReachable(t *testing.T) {
	svc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/openapi.json" {
			fmt.Fprint(w, `{"paths":{"/open":{"get":{"x-gateway":{"isPublic":true}}},"/closed":{"get":{}}}}`)
			return
		}
		fmt.Fprint(w, "down:"+r.URL.Path)
	}))
	defer svc.Close()
	fakeDiscoverer(t, map[string][]string{"events": {hostOf(svc)}})
	store := newFakeStore()
	gw, eps := newGateway(t, store, NewDiscovery())
	s := NewSyncer(store, eps, 60)
	if _, _, err := s.SyncKind(context.Background(), Events); err != nil {
		t.Fatal(err)
	}
	if err := eps.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	h := authHdr("u1")
	if resp, body := get(t, "GET", gw.URL+"/events/open", "", h); resp.StatusCode != 200 || body != "down:/open" {
		t.Errorf("open: %d %q", resp.StatusCode, body)
	}
	if resp, _ := get(t, "GET", gw.URL+"/events/closed", "", h); resp.StatusCode != 404 {
		t.Errorf("closed: %d", resp.StatusCode)
	}
}
