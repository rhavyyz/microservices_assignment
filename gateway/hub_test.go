package main

import (
	"testing"
	"time"
)

func closed(c *client) bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

func TestHubReplaceClosesOld(t *testing.T) {
	h := NewHub()
	a, b := newClient("alice", 4), newClient("alice", 4)
	h.Register(a)
	h.Register(b)
	if !closed(a) || a.code != closeReplaced || a.reason != reasonReplaced {
		t.Errorf("old connection: closed=%v code=%d reason=%q", closed(a), a.code, a.reason)
	}
	if closed(b) {
		t.Error("new connection must stay open")
	}
	if !h.Send("alice", []byte("x")) || len(b.send) != 1 || len(a.send) != 0 {
		t.Errorf("send must reach only the new connection (new=%d old=%d)", len(b.send), len(a.send))
	}
}

func TestHubUnregisterOnlyItself(t *testing.T) {
	h := NewHub()
	a, b := newClient("alice", 4), newClient("alice", 4)
	h.Register(a)
	h.Register(b)
	h.Unregister(a) // the replaced one cleaning up late
	if !h.Send("alice", []byte("x")) {
		t.Fatal("unregistering the replaced connection removed the new one")
	}
	h.Unregister(b)
	if h.Send("alice", []byte("x")) {
		t.Error("send after unregister must be dropped")
	}
}

func TestHubSendAbsentUser(t *testing.T) {
	if NewHub().Send("nobody", []byte("x")) {
		t.Error("send to an absent user must be a no-op")
	}
}

func TestHubSendFullQueueDropsConnection(t *testing.T) {
	h := NewHub()
	c := newClient("alice", 2)
	h.Register(c)
	h.Send("alice", []byte("1"))
	h.Send("alice", []byte("2"))
	done := make(chan bool)
	go func() { done <- h.Send("alice", []byte("3")) }()
	select {
	case ok := <-done:
		if ok {
			t.Error("send to a full queue must report the drop")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Send blocked on a full queue")
	}
	if !closed(c) || c.code != closeSlow {
		t.Errorf("slow connection: closed=%v code=%d", closed(c), c.code)
	}
	if h.Send("alice", []byte("4")) {
		t.Error("a dropped connection must be unregistered")
	}
}
