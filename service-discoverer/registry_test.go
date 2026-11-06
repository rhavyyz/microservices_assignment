package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func hostOf(s *httptest.Server) string { return strings.TrimPrefix(s.URL, "http://") }

func healthy(t *testing.T) *httptest.Server {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != healthPath {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func TestRegisterUnknownKind(t *testing.T) {
	r := NewRegistry()
	if err := r.Register("gateway", "x:1"); err != ErrUnknownKind {
		t.Fatalf("got %v", err)
	}
}

func deadHost() string {
	s := httptest.NewServer(http.NotFoundHandler())
	h := hostOf(s)
	s.Close()
	return h
}

// toggled returns a server whose health check answers 200 while up is true.
func toggled(t *testing.T, up *atomic.Bool) *httptest.Server {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !up.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func state(r *Registry, kind Kind, host string) (active bool, fails int, recovering bool) {
	e := r.kinds[kind]
	e.mu.Lock()
	defer e.mu.Unlock()
	_, active = e.hosts[host]
	fails, recovering = e.recovering[host]
	return
}

func TestConsultMovesFailingHostToRecovering(t *testing.T) {
	r := NewRegistry()
	good := healthy(t)
	dead := deadHost()
	r.Register(Payments, dead)
	r.Register(Payments, hostOf(good))

	// Whichever slot the first consult starts at, the dead host is probed
	// within two consults and the healthy one is always returned.
	for i := 0; i < 2; i++ {
		got, err := r.Consult(context.Background(), Payments)
		if err != nil || got != hostOf(good) {
			t.Fatalf("got %q, %v", got, err)
		}
	}
	if a, n, rec := state(r, Payments, dead); a || !rec || n != 0 {
		t.Fatalf("dead: active=%v fails=%d recovering=%v", a, n, rec)
	}
	for i := 0; i < 3; i++ {
		if got, err := r.Consult(context.Background(), Payments); err != nil || got != hostOf(good) {
			t.Fatalf("got %q, %v", got, err)
		}
	}
}

// registerHealthy registers n healthy servers of the kind and returns their
// hosts in sorted (rotation) order.
func registerHealthy(t *testing.T, r *Registry, kind Kind, n int) []string {
	hosts := make([]string, n)
	for i := range hosts {
		hosts[i] = hostOf(healthy(t))
		r.Register(kind, hosts[i])
	}
	sort.Strings(hosts)
	return hosts
}

func consultN(t *testing.T, r *Registry, kind Kind, n int) []string {
	got := make([]string, n)
	for i := range got {
		h, err := r.Consult(context.Background(), kind)
		if err != nil {
			t.Fatalf("consult %d: %v", i, err)
		}
		got[i] = h
	}
	return got
}

func expectSeq(t *testing.T, got, want []string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestConsultRotatesEvenly(t *testing.T) {
	r := NewRegistry()
	hosts := registerHealthy(t, r, Payments, 3)
	got := consultN(t, r, Payments, 9)
	var want []string
	for i := 0; i < 3; i++ {
		want = append(want, hosts...)
	}
	expectSeq(t, got, want)
}

func TestConsultSkipsUnhealthyAndContinuesAfterReturned(t *testing.T) {
	r := NewRegistry()
	var up atomic.Bool
	flaky := hostOf(toggled(t, &up))
	r.Register(Payments, flaky)
	others := registerHealthy(t, r, Payments, 3)
	all := append([]string{flaky}, others...)
	sort.Strings(all)

	// Park the cursor so the next consult starts exactly at the flaky host.
	idx := sort.SearchStrings(all, flaky)
	e := r.kinds[Payments]
	e.mu.Lock()
	e.cursor = uint64(idx)
	e.mu.Unlock()

	got := consultN(t, r, Payments, 3)
	if a, n, rec := state(r, Payments, flaky); a || !rec || n != 0 {
		t.Fatalf("flaky: active=%v fails=%d recovering=%v", a, n, rec)
	}
	// The failed host falls through to the next one, and the rotation then
	// continues after it: no host is returned twice in a row.
	rest := append([]string(nil), all...)
	rest = append(rest[:idx], rest[idx+1:]...)
	var want []string
	for i := 0; i < 3; i++ {
		want = append(want, rest[(idx+i)%3])
	}
	expectSeq(t, got, want)
}

func TestConsultFallthroughSetsCursorAfterReturned(t *testing.T) {
	r := NewRegistry()
	good := registerHealthy(t, r, Payments, 3)
	dead := deadHost()
	r.Register(Payments, dead)
	all := append([]string{dead}, good...)
	sort.Strings(all)
	idx := sort.SearchStrings(all, dead)
	e := r.kinds[Payments]
	e.mu.Lock()
	e.cursor = uint64(idx)
	e.mu.Unlock()

	got, err := r.Consult(context.Background(), Payments)
	if err != nil {
		t.Fatal(err)
	}
	// Dead host is removed, so the returned host is the one now at idx.
	if got != good[idx%3] {
		t.Fatalf("got %q, want %q", got, good[idx%3])
	}
	e.mu.Lock()
	cur := e.cursor
	e.mu.Unlock()
	want := uint64(sort.SearchStrings(good, got) + 1)
	if cur != want {
		t.Fatalf("cursor %d, want %d", cur, want)
	}
}

func TestConsultRecoveredHostRejoinsRotation(t *testing.T) {
	r := NewRegistry()
	var up atomic.Bool
	flaky := hostOf(toggled(t, &up))
	r.Register(Payments, flaky)
	good := hostOf(healthy(t))
	r.Register(Payments, good)

	for i := 0; i < 2; i++ {
		if got, err := r.Consult(context.Background(), Payments); err != nil || got != good {
			t.Fatalf("got %q, %v", got, err)
		}
	}
	up.Store(true)
	r.recheckOnce()
	if a, _, rec := state(r, Payments, flaky); !a || rec {
		t.Fatalf("active=%v recovering=%v", a, rec)
	}
	seen := map[string]int{}
	for _, h := range consultN(t, r, Payments, 4) {
		seen[h]++
	}
	if seen[flaky] != 2 || seen[good] != 2 {
		t.Fatalf("distribution %v", seen)
	}
}

func TestConsultSingleHost(t *testing.T) {
	r := NewRegistry()
	h := registerHealthy(t, r, User, 1)[0]
	for _, got := range consultN(t, r, User, 4) {
		if got != h {
			t.Fatalf("got %q, want %q", got, h)
		}
	}
}

func TestConsultNoHosts(t *testing.T) {
	r := NewRegistry()
	if _, err := r.Consult(context.Background(), User); err != ErrNoInstance {
		t.Fatalf("got %v", err)
	}
}

func TestConsultUnknownKind(t *testing.T) {
	r := NewRegistry()
	if _, err := r.Consult(context.Background(), "gateway"); err != ErrUnknownKind {
		t.Fatalf("got %v", err)
	}
}

func TestConsultContextCancelled(t *testing.T) {
	r := NewRegistry()
	registerHealthy(t, r, User, 2)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.Consult(ctx, User); err != context.Canceled {
		t.Fatalf("got %v", err)
	}
}

func TestConsultContextCancelledBetweenProbes(t *testing.T) {
	r := NewRegistry()
	ctx, cancel := context.WithCancel(context.Background())
	var calls atomic.Int32
	// The first probed host cancels ctx and fails; the next must not be probed.
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		cancel()
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(s.Close)
	r.Register(User, hostOf(s))
	other := healthy(t)
	r.Register(User, hostOf(other))
	hosts := []string{hostOf(s), hostOf(other)}
	sort.Strings(hosts)
	e := r.kinds[User]
	e.mu.Lock()
	e.cursor = uint64(sort.SearchStrings(hosts, hostOf(s)))
	e.mu.Unlock()

	if _, err := r.Consult(ctx, User); err != context.Canceled {
		t.Fatalf("got %v", err)
	}
}

func TestConsultCursorSurvivesHostSetChanges(t *testing.T) {
	r := NewRegistry()
	hosts := registerHealthy(t, r, Payments, 4)
	consultN(t, r, Payments, 3) // cursor now past the middle of the list

	// Shrink to one host: the cursor is far past the host count.
	e := r.kinds[Payments]
	e.mu.Lock()
	for _, h := range hosts[1:] {
		delete(e.hosts, h)
	}
	e.mu.Unlock()
	for _, got := range consultN(t, r, Payments, 3) {
		if got != hosts[0] {
			t.Fatalf("got %q, want %q", got, hosts[0])
		}
	}

	// Grow again: every host is served evenly.
	for _, h := range hosts[1:] {
		r.Register(Payments, h)
	}
	seen := map[string]int{}
	for _, h := range consultN(t, r, Payments, 8) {
		seen[h]++
	}
	for _, h := range hosts {
		if seen[h] != 2 {
			t.Fatalf("distribution %v", seen)
		}
	}
}

func TestConcurrentConsultDistributesEvenly(t *testing.T) {
	r := NewRegistry()
	hosts := registerHealthy(t, r, Payments, 3)
	var mu sync.Mutex
	seen := map[string]int{}
	var wg sync.WaitGroup
	for i := 0; i < 300; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h, err := r.Consult(context.Background(), Payments)
			if err != nil {
				t.Error(err)
				return
			}
			mu.Lock()
			seen[h]++
			mu.Unlock()
		}()
	}
	wg.Wait()
	for _, h := range hosts {
		if seen[h] != 100 {
			t.Fatalf("distribution %v", seen)
		}
	}
}

func TestConsultOnlyDeadHostIsKeptRecovering(t *testing.T) {
	r := NewRegistry()
	dead := deadHost()
	r.Register(Payments, dead)
	if _, err := r.Consult(context.Background(), Payments); err != ErrNoInstance {
		t.Fatalf("got %v", err)
	}
	if a, n, rec := state(r, Payments, dead); a || !rec || n != 0 {
		t.Fatalf("active=%v fails=%d recovering=%v", a, n, rec)
	}
	if _, err := r.Consult(context.Background(), Payments); err != ErrNoInstance {
		t.Fatalf("recovering host returned: %v", err)
	}
}

func TestRecoveringHostIsPromotedByRecheck(t *testing.T) {
	r := NewRegistry()
	var up atomic.Bool
	s := toggled(t, &up)
	h := hostOf(s)
	r.Register(Payments, h)
	if _, err := r.Consult(context.Background(), Payments); err != ErrNoInstance {
		t.Fatalf("got %v", err)
	}

	r.recheckOnce() // still down: stays recovering
	if a, n, rec := state(r, Payments, h); a || !rec || n != 1 {
		t.Fatalf("active=%v fails=%d recovering=%v", a, n, rec)
	}

	up.Store(true)
	r.recheckOnce()
	if a, _, rec := state(r, Payments, h); !a || rec {
		t.Fatalf("active=%v recovering=%v", a, rec)
	}
	if got, err := r.Consult(context.Background(), Payments); err != nil || got != h {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestRecheckDropsAfterExactlyMaxFailures(t *testing.T) {
	r := NewRegistryWithConfig(Config{time.Second, 3})
	var up atomic.Bool
	h := hostOf(toggled(t, &up))
	r.Register(User, h)
	r.Consult(context.Background(), User)

	r.recheckOnce()
	r.recheckOnce()
	if _, n, rec := state(r, User, h); !rec || n != 2 {
		t.Fatalf("fails=%d recovering=%v, want 2 true", n, rec)
	}
	// A success in between leaves recovering instead of counting on.
	up.Store(true)
	r.recheckOnce()
	if a, _, rec := state(r, User, h); !a || rec {
		t.Fatalf("active=%v recovering=%v", a, rec)
	}
	up.Store(false)
	r.recheckOnce() // nothing recovering: no-op
	r.Consult(context.Background(), User)
	r.recheckOnce()
	r.recheckOnce()
	if _, n, rec := state(r, User, h); !rec || n != 2 {
		t.Fatalf("counter not reset: fails=%d recovering=%v", n, rec)
	}
	r.recheckOnce()
	if a, _, rec := state(r, User, h); a || rec {
		t.Fatalf("not dropped: active=%v recovering=%v", a, rec)
	}
}

func TestRegisterReactivatesRecovering(t *testing.T) {
	r := NewRegistry()
	h := deadHost()
	r.Register(User, h)
	r.Consult(context.Background(), User)
	r.recheckOnce()
	if _, n, _ := state(r, User, h); n != 1 {
		t.Fatalf("fails=%d", n)
	}
	r.Register(User, h)
	if a, n, rec := state(r, User, h); !a || rec || n != 0 {
		t.Fatalf("active=%v fails=%d recovering=%v", a, n, rec)
	}
	r.Register(User, h) // idempotent
	if a, _, rec := state(r, User, h); !a || rec {
		t.Fatalf("active=%v recovering=%v", a, rec)
	}
}

func TestReRegisterDuringRecheckIgnoresStaleResult(t *testing.T) {
	r := NewRegistryWithConfig(Config{time.Second, 1})
	inProbe := make(chan struct{})
	release := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(inProbe)
		<-release
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer s.Close()
	h := hostOf(s)
	e := r.kinds[User]
	e.mu.Lock()
	e.recovering[h] = 0
	e.mu.Unlock()

	done := make(chan struct{})
	go func() { r.recheckOnce(); close(done) }()
	<-inProbe
	r.Register(User, h)
	close(release)
	<-done
	// With max failures 1 a stale failure would have dropped the host.
	if a, _, rec := state(r, User, h); !a || rec {
		t.Fatalf("active=%v recovering=%v", a, rec)
	}
}

func TestConfigFromEnv(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	cfg, err := configFromEnv(env(nil))
	if err != nil || cfg.RecheckInterval != 5*time.Second || cfg.RecheckMaxFailures != 12 {
		t.Fatalf("defaults: %+v, %v", cfg, err)
	}
	cfg, err = configFromEnv(env(map[string]string{"RECHECK_INTERVAL": "1s", "RECHECK_MAX_FAILURES": "5"}))
	if err != nil || cfg.RecheckInterval != time.Second || cfg.RecheckMaxFailures != 5 {
		t.Fatalf("custom: %+v, %v", cfg, err)
	}
	for _, m := range []map[string]string{
		{"RECHECK_INTERVAL": "abc"}, {"RECHECK_INTERVAL": "0s"}, {"RECHECK_INTERVAL": "-1s"}, {"RECHECK_INTERVAL": "5"},
		{"RECHECK_MAX_FAILURES": "0"}, {"RECHECK_MAX_FAILURES": "x"}, {"RECHECK_MAX_FAILURES": "-2"},
	} {
		if _, err := configFromEnv(env(m)); err == nil {
			t.Errorf("%v: expected error", m)
		}
	}
}

func TestConcurrentRegisterConsult(t *testing.T) {
	r := NewRegistry()
	good := healthy(t)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func() { defer wg.Done(); r.Register(User, hostOf(good)) }()
		go func() { defer wg.Done(); r.Consult(context.Background(), User) }()
	}
	for i := 0; i < 20; i++ {
		wg.Add(2)
		go func() { defer wg.Done(); r.Register(User, deadHost()) }()
		go func() { defer wg.Done(); r.recheckOnce() }()
	}
	wg.Wait()
}
