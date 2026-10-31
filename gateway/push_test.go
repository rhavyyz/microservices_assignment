package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestPushHandleDeliversFrame(t *testing.T) {
	h := NewHub()
	c := newClient("alice", 4)
	h.Register(c)
	pc := NewPushConsumer("kafka:9092", "t", h)
	pc.Handle([]byte(`{"id":"n1","user_id":"alice","message":"hi","redirect_url":null,"payload":{"a":1},"payload_type":"x","status":"DEFAULT","created_at":"2026-10-31T04:49:27.555Z"}`))
	if len(c.send) != 1 {
		t.Fatalf("queued frames: %d", len(c.send))
	}
	raw := <-c.send
	if strings.Contains(string(raw), "user_id") {
		t.Errorf("user_id leaked: %s", raw)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	want := `{"notification":{"created_at":"2026-10-31T04:49:27.555Z","id":"n1","message":"hi","payload":{"a":1},"payload_type":"x","redirect_url":null,"status":"DEFAULT"},"type":"notification"}`
	b, _ := json.Marshal(got) // maps marshal with sorted keys
	if string(b) != want {
		t.Errorf("frame:\n got %s\nwant %s", b, want)
	}
}

func TestPushHandleNullsAndAbsent(t *testing.T) {
	h := NewHub()
	c := newClient("alice", 4)
	h.Register(c)
	NewPushConsumer("kafka:9092", "t", h).Handle([]byte(`{"id":"n1","user_id":" alice ","message":"hi","status":"DEFAULT","created_at":"c"}`))
	raw := string(<-c.send)
	for _, f := range []string{`"redirect_url":null`, `"payload":null`, `"payload_type":null`} {
		if !strings.Contains(raw, f) {
			t.Errorf("%s missing in %s", f, raw)
		}
	}
}

func TestPushHandleSkipsInvalid(t *testing.T) {
	h := NewHub()
	c := newClient("alice", 4)
	h.Register(c)
	pc := NewPushConsumer("kafka:9092", "t", h)
	for _, v := range []string{`not json`, ``, `{"id":"n1","message":"m"}`, `{"id":"n1","user_id":"  ","message":"m"}`, `{"user_id":"alice","message":"m"}`} {
		pc.Handle([]byte(v))
	}
	if len(c.send) != 0 {
		t.Errorf("invalid records were delivered: %d", len(c.send))
	}
}

func TestLogEverySuppressesIdentical(t *testing.T) {
	now := time.Unix(0, 0)
	l := &logEvery{every: time.Minute, now: func() time.Time { return now }}
	l.Printf("boom")
	l.Printf("boom")
	l.Printf("boom")
	if l.suppressed != 2 {
		t.Errorf("suppressed = %d, want 2", l.suppressed)
	}
	now = now.Add(2 * time.Minute)
	l.Printf("boom")
	if l.suppressed != 0 {
		t.Errorf("suppressed after the interval = %d, want 0", l.suppressed)
	}
	l.Printf("other")
	l.Printf("boom")
	if l.suppressed != 0 {
		t.Error("a different line must be logged and reset the counter")
	}
}
