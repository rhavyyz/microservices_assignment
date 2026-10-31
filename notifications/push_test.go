package main

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

func TestPushRecord(t *testing.T) {
	url, typ := "/orders/1", "order"
	n := Notification{
		ID: "id1", UserID: "u1", Message: "hi", RedirectURL: &url, Payload: map[string]any{"a": "b"}, PayloadType: &typ,
		Status: StatusDefault, CreatedAt: time.Date(2026, 1, 2, 3, 4, 5, 678_000_000, time.UTC),
	}
	key, value, err := pushRecord(n)
	if err != nil || string(key) != "u1" {
		t.Fatalf("key=%q err=%v", key, err)
	}
	var got map[string]any
	if err := json.Unmarshal(value, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"id": "id1", "user_id": "u1", "message": "hi", "redirect_url": "/orders/1", "payload": map[string]any{"a": "b"},
		"payload_type": "order", "status": "DEFAULT", "created_at": "2026-01-02T03:04:05.678Z",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestPushRecordNulls(t *testing.T) {
	// A non-UTC created_at is still rendered in UTC.
	loc := time.FixedZone("x", 3600)
	_, value, err := pushRecord(Notification{ID: "i", UserID: "u", Message: "m", Status: StatusSeen, CreatedAt: time.Date(2026, 1, 2, 4, 0, 0, 0, loc)})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	json.Unmarshal(value, &got)
	for _, k := range []string{"redirect_url", "payload", "payload_type"} {
		if v, ok := got[k]; !ok || v != nil {
			t.Errorf("%s: want null, got %v (present=%v)", k, v, ok)
		}
	}
	if got["created_at"] != "2026-01-02T03:00:00.000Z" || got["status"] != "SEEN" {
		t.Errorf("unexpected: %v", got)
	}
}

type fakeStore struct {
	inserted bool
	insErr   error
	stored   Notification
	getErr   error
	inserts  int
}

func (f *fakeStore) Insert(_ context.Context, id string, m Message) (Notification, bool, error) {
	f.inserts++
	if f.insErr != nil {
		return Notification{}, false, f.insErr
	}
	if !f.inserted {
		return Notification{}, false, nil
	}
	return Notification{ID: id, UserID: m.UserID, Message: m.Message, Status: StatusDefault, CreatedAt: time.Now().UTC()}, true, nil
}

func (f *fakeStore) Get(context.Context, string) (Notification, error) { return f.stored, f.getErr }

type fakePub struct{ got []Notification }

func (p *fakePub) Publish(_ context.Context, n Notification) { p.got = append(p.got, n) }

func rec(value string) *kgo.Record {
	return &kgo.Record{Topic: "notifications", Partition: 2, Offset: 7, Value: []byte(value)}
}

const validRec = `{"user_id":"u1","message":"hi"}`

func TestHandlePublishesAfterInsert(t *testing.T) {
	pub := &fakePub{}
	c := &Consumer{store: &fakeStore{inserted: true}, pub: pub}
	if !c.handle(context.Background(), rec(validRec)) {
		t.Fatal("handle should be done")
	}
	if len(pub.got) != 1 || pub.got[0].ID != NotificationID("notifications", 2, 7) || pub.got[0].UserID != "u1" {
		t.Fatalf("published %+v", pub.got)
	}
}

func TestHandleDuplicatePublishesStoredDoc(t *testing.T) {
	stored := Notification{ID: "x", UserID: "u1", Message: "original", Status: StatusSeen, CreatedAt: time.Unix(1000, 0).UTC()}
	pub := &fakePub{}
	c := &Consumer{store: &fakeStore{stored: stored}, pub: pub}
	if !c.handle(context.Background(), rec(validRec)) {
		t.Fatal("handle should be done")
	}
	if len(pub.got) != 1 || !reflect.DeepEqual(pub.got[0], stored) {
		t.Fatalf("published %+v, want the stored doc", pub.got)
	}
}

func TestHandleDuplicateGetFailsSkipsPush(t *testing.T) {
	pub := &fakePub{}
	c := &Consumer{store: &fakeStore{getErr: mongo.ErrNoDocuments}, pub: pub}
	if !c.handle(context.Background(), rec(validRec)) {
		t.Fatal("record should still be committed")
	}
	if len(pub.got) != 0 {
		t.Fatalf("published %+v", pub.got)
	}
}

func TestHandleInvalidPublishesNothing(t *testing.T) {
	pub, st := &fakePub{}, &fakeStore{inserted: true}
	c := &Consumer{store: st, pub: pub}
	if !c.handle(context.Background(), rec(`{"user_id":"","message":"x"}`)) {
		t.Fatal("invalid record should be committed")
	}
	if len(pub.got) != 0 || st.inserts != 0 {
		t.Fatalf("published %+v, inserts %d", pub.got, st.inserts)
	}
}

func TestHandleStoreFailureDoesNotPublish(t *testing.T) {
	pub := &fakePub{}
	c := &Consumer{store: &fakeStore{insErr: errors.New("down")}, pub: pub}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if c.handle(ctx, rec(validRec)) {
		t.Fatal("handle must not report done when the insert keeps failing")
	}
	if len(pub.got) != 0 {
		t.Fatalf("published %+v", pub.got)
	}
}
