package main

import (
	"context"
	"net/http"
	"net/http/httptest"
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

	got, err := r.Consult(context.Background(), Payments)
	if err != nil || got != hostOf(good) {
		t.Fatalf("got %q, %v", got, err)
	}
	// The dead host's probe outlives the winner; wait for it to be moved.
	for i := 0; i < 100; i++ {
		if _, _, rec := state(r, Payments, dead); rec {
			break
		}
		time.Sleep(50 * time.Millisecond)
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
