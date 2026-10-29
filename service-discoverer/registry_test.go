package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
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

func TestConsultReturnsHealthyAndRemovesDead(t *testing.T) {
	r := NewRegistry()
	good := healthy(t)
	dead := httptest.NewServer(http.NotFoundHandler())
	deadHost := hostOf(dead)
	dead.Close()

	r.Register(Payments, deadHost)
	r.Register(Payments, hostOf(good))

	got, err := r.Consult(context.Background(), Payments)
	if err != nil || got != hostOf(good) {
		t.Fatalf("got %q, %v", got, err)
	}

	// Consult with only the dead host left: must fail and remove it.
	e := r.kinds[Payments]
	e.mu.Lock()
	delete(e.hosts, hostOf(good))
	e.mu.Unlock()
	if _, err := r.Consult(context.Background(), Payments); err != ErrNoInstance {
		t.Fatalf("got %v", err)
	}
	e.mu.Lock()
	n := len(e.hosts)
	e.mu.Unlock()
	if n != 0 {
		t.Fatalf("dead host not removed, %d left", n)
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
	wg.Wait()
}
