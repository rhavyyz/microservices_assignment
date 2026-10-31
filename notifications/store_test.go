package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"reflect"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const testRetention = 30 * 24 * time.Hour

// newTestStore connects to TEST_MONGO_URI with a throwaway database, dropped on cleanup.
func newTestStore(t *testing.T) (*Store, context.Context) {
	uri := os.Getenv("TEST_MONGO_URI")
	if uri == "" {
		t.Skip("TEST_MONGO_URI not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	s, err := newStore(uri, fmt.Sprintf("notifications_test_%d", rand.Int63()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.db.Drop(context.Background()) })
	if err := s.EnsureSchema(ctx, testRetention); err != nil {
		t.Fatal(err)
	}
	return s, ctx
}

func TestStoreInsert(t *testing.T) {
	s, ctx := newTestStore(t)
	typ := "order"
	m := Message{UserID: "u", Message: "hi", Payload: map[string]any{"a": "b"}, PayloadType: &typ}
	before := time.Now().UTC().Add(-time.Second)
	ins, inserted, err := s.Insert(ctx, "id1", m)
	if err != nil || !inserted {
		t.Fatalf("inserted=%v err=%v", inserted, err)
	}
	var n Notification
	if err := s.coll().FindOne(ctx, bson.M{"_id": "id1"}).Decode(&n); err != nil {
		t.Fatal(err)
	}
	if n.Status != StatusDefault || n.CreatedAt.Before(before) || n.UserID != "u" || n.Payload["a"] != "b" {
		t.Fatalf("unexpected: %+v", n)
	}
	if ins.ID != "id1" || ins.Status != StatusDefault || !ins.CreatedAt.Truncate(time.Millisecond).Equal(n.CreatedAt) {
		t.Fatalf("returned doc %+v differs from stored %+v", ins, n)
	}
}

func TestStoreDuplicateIsNoop(t *testing.T) {
	s, ctx := newTestStore(t)
	if _, inserted, err := s.Insert(ctx, "id1", Message{UserID: "u", Message: "one"}); err != nil || !inserted {
		t.Fatalf("inserted=%v err=%v", inserted, err)
	}
	if _, inserted, err := s.Insert(ctx, "id1", Message{UserID: "u", Message: "two"}); err != nil || inserted {
		t.Fatalf("duplicate should succeed without inserting: inserted=%v err=%v", inserted, err)
	}
	n, err := s.coll().CountDocuments(ctx, bson.M{})
	if err != nil || n != 1 {
		t.Fatalf("count=%d err=%v", n, err)
	}
	var d Notification
	s.coll().FindOne(ctx, bson.M{"_id": "id1"}).Decode(&d)
	if d.Message != "one" {
		t.Fatalf("original overwritten: %+v", d)
	}
}

func TestStoreGet(t *testing.T) {
	s, ctx := newTestStore(t)
	if _, err := s.Get(ctx, "nope"); !errors.Is(err, mongo.ErrNoDocuments) {
		t.Fatalf("want ErrNoDocuments, got %v", err)
	}
	ins, _, err := s.Insert(ctx, "id1", Message{UserID: "u", Message: "one"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, "id1")
	if err != nil || got.Message != "one" || got.Status != StatusDefault || got.UserID != "u" ||
		!got.CreatedAt.Equal(ins.CreatedAt.Truncate(time.Millisecond)) {
		t.Fatalf("got %+v err=%v", got, err)
	}
}

func TestStoreOptionalFieldsNull(t *testing.T) {
	s, ctx := newTestStore(t)
	if _, _, err := s.Insert(ctx, "id1", Message{UserID: "u", Message: "m"}); err != nil {
		t.Fatal(err)
	}
	var raw bson.M
	if err := s.coll().FindOne(ctx, bson.M{"_id": "id1"}).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"redirect_url", "payload", "payload_type"} {
		v, ok := raw[k]
		if !ok || v != nil {
			t.Errorf("%s: want stored null, got %v (present=%v)", k, v, ok)
		}
	}
}

func TestStoreValidatorRejectsUnknownStatus(t *testing.T) {
	s, ctx := newTestStore(t)
	_, err := s.coll().InsertOne(ctx, bson.M{"_id": "x", "user_id": "u", "message": "m", "status": "BOGUS", "created_at": time.Now()})
	if err == nil {
		t.Fatal("expected validation error")
	}
}

func TestStoreIndexAndIdempotentSchema(t *testing.T) {
	s, ctx := newTestStore(t)
	if err := s.EnsureSchema(ctx, testRetention); err != nil { // second run: collMod + existing index
		t.Fatal(err)
	}
	cur, err := s.coll().Indexes().List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var idx []bson.M
	if err := cur.All(ctx, &idx); err != nil {
		t.Fatal(err)
	}
	for _, i := range idx {
		if i["name"] == userIndexName {
			return
		}
	}
	t.Fatalf("index not found: %v", idx)
}

func listIndexes(t *testing.T, s *Store, ctx context.Context) map[string]indexInfo {
	t.Helper()
	cur, err := s.coll().Indexes().List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var idx []indexInfo
	if err := cur.All(ctx, &idx); err != nil {
		t.Fatal(err)
	}
	m := map[string]indexInfo{}
	for _, i := range idx {
		m[i.Name] = i
	}
	return m
}

func wantTTL(t *testing.T, s *Store, ctx context.Context, seconds int64) {
	t.Helper()
	idx := listIndexes(t, s, ctx)
	i, ok := idx[ttlIndexName]
	if !ok || !i.onlyCreatedAt() || i.Expire == nil || *i.Expire != seconds {
		t.Fatalf("want TTL index on created_at with %ds, got %+v", seconds, idx)
	}
	if _, ok := idx["created_at_1"]; ok {
		t.Fatalf("plain created_at_1 should not exist: %+v", idx)
	}
	if _, ok := idx[userIndexName]; !ok {
		t.Fatalf("user index missing: %+v", idx)
	}
	if _, ok := idx[oldUserIndexName]; ok {
		t.Fatalf("old user index should be gone: %+v", idx)
	}
}

func TestStoreTTLIndex(t *testing.T) {
	s, ctx := newTestStore(t)
	wantTTL(t, s, ctx, 30*86400)
	if err := s.EnsureSchema(ctx, testRetention); err != nil { // no-op
		t.Fatal(err)
	}
	wantTTL(t, s, ctx, 30*86400)
}

func TestStoreTTLIndexRetentionChange(t *testing.T) {
	s, ctx := newTestStore(t)
	if err := s.EnsureSchema(ctx, 7*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	wantTTL(t, s, ctx, 7*86400)
	if err := s.EnsureSchema(ctx, 90*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	wantTTL(t, s, ctx, 90*86400)
}

func TestStoreTTLIndexReplacesPlainIndex(t *testing.T) {
	s, ctx := newTestStore(t)
	if err := s.coll().Indexes().DropOne(ctx, ttlIndexName); err != nil {
		t.Fatal(err)
	}
	if _, err := s.coll().Indexes().CreateOne(ctx, mongo.IndexModel{Keys: bson.D{{Key: "created_at", Value: 1}}}); err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureSchema(ctx, testRetention); err != nil {
		t.Fatal(err)
	}
	wantTTL(t, s, ctx, 30*86400)
}

// seed inserts a notification directly, with the given owner, creation time and status.
func seed(t *testing.T, s *Store, ctx context.Context, id, user string, at time.Time, st Status) {
	t.Helper()
	_, err := s.coll().InsertOne(ctx, Notification{ID: id, UserID: user, Message: "m-" + id, Status: st, CreatedAt: at})
	if err != nil {
		t.Fatal(err)
	}
}

func ids(items []Notification) []string {
	out := make([]string, len(items))
	for i, n := range items {
		out[i] = n.ID
	}
	return out
}

// walk follows the cursor with the given page size and returns the pages' ids.
func walk(t *testing.T, s *Store, ctx context.Context, user string, statuses []Status, limit int) []string {
	t.Helper()
	var all []string
	base := ""
	for page := 0; page < 100; page++ {
		items, more, err := s.List(ctx, user, base, statuses, limit)
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, ids(items)...)
		if !more {
			return all
		}
		base = items[len(items)-1].ID
	}
	t.Fatal("pagination did not end")
	return nil
}

var t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func TestStoreListOrderAndPages(t *testing.T) {
	s, ctx := newTestStore(t)
	// Ids deliberately not in time order.
	seed(t, s, ctx, "c", "u", t0.Add(1*time.Second), StatusDefault)
	seed(t, s, ctx, "a", "u", t0.Add(3*time.Second), StatusDefault)
	seed(t, s, ctx, "e", "u", t0.Add(2*time.Second), StatusDefault)
	seed(t, s, ctx, "b", "u", t0.Add(5*time.Second), StatusDefault)
	seed(t, s, ctx, "d", "u", t0.Add(4*time.Second), StatusDefault)
	seed(t, s, ctx, "z", "other", t0.Add(6*time.Second), StatusDefault)
	want := []string{"b", "d", "a", "e", "c"}

	items, more, err := s.List(ctx, "u", "", nil, 100)
	if err != nil || more || !reflect.DeepEqual(ids(items), want) {
		t.Fatalf("got %v more=%v err=%v", ids(items), more, err)
	}
	if got := walk(t, s, ctx, "u", nil, 2); !reflect.DeepEqual(got, want) {
		t.Fatalf("walk: %v", got)
	}
	// Boundaries: exactly limit docs is the last page; limit-1 has more.
	if _, more, _ := s.List(ctx, "u", "", nil, 5); more {
		t.Error("exactly-limit page should have no more")
	}
	if items, more, _ := s.List(ctx, "u", "", nil, 4); !more || len(items) != 4 {
		t.Errorf("limit 4: len=%d more=%v", len(items), more)
	}
	if items, more, err := s.List(ctx, "nobody", "", nil, 5); err != nil || more || items == nil || len(items) != 0 {
		t.Errorf("empty: %v %v %v", items, more, err)
	}
}

func TestStoreListTies(t *testing.T) {
	s, ctx := newTestStore(t)
	var want []string
	for _, id := range []string{"f3", "0a", "9c", "b1", "27", "e8"} {
		seed(t, s, ctx, id, "u", t0, StatusDefault)
	}
	seed(t, s, ctx, "old", "u", t0.Add(-time.Second), StatusDefault)
	seed(t, s, ctx, "new", "u", t0.Add(time.Second), StatusDefault)
	want = []string{"new", "f3", "e8", "b1", "9c", "27", "0a", "old"}
	for _, limit := range []int{1, 2, 3} {
		if got := walk(t, s, ctx, "u", nil, limit); !reflect.DeepEqual(got, want) {
			t.Fatalf("limit %d: %v", limit, got)
		}
	}
}

func TestStoreListNewerDoesNotShiftPages(t *testing.T) {
	s, ctx := newTestStore(t)
	for i, id := range []string{"a", "b", "c", "d"} {
		seed(t, s, ctx, id, "u", t0.Add(time.Duration(10-i)*time.Second), StatusDefault)
	}
	p1, more, err := s.List(ctx, "u", "", nil, 2)
	if err != nil || !more {
		t.Fatal(err, more)
	}
	seed(t, s, ctx, "newest", "u", t0.Add(time.Hour), StatusDefault)
	p2, more, err := s.List(ctx, "u", p1[1].ID, nil, 2)
	if err != nil || more || !reflect.DeepEqual(ids(p2), []string{"c", "d"}) {
		t.Fatalf("page 2: %v more=%v err=%v", ids(p2), more, err)
	}
}

func TestStoreListStatusFilter(t *testing.T) {
	s, ctx := newTestStore(t)
	seed(t, s, ctx, "1", "u", t0.Add(6*time.Second), StatusSeen)
	seed(t, s, ctx, "2", "u", t0.Add(5*time.Second), StatusDefault)
	seed(t, s, ctx, "3", "u", t0.Add(4*time.Second), StatusReceived)
	seed(t, s, ctx, "4", "u", t0.Add(3*time.Second), StatusDefault)
	seed(t, s, ctx, "5", "u", t0.Add(2*time.Second), StatusSeen)
	seed(t, s, ctx, "6", "u", t0.Add(1*time.Second), StatusDefault)

	if got := walk(t, s, ctx, "u", []Status{StatusDefault}, 2); !reflect.DeepEqual(got, []string{"2", "4", "6"}) {
		t.Errorf("DEFAULT: %v", got)
	}
	if got := walk(t, s, ctx, "u", []Status{StatusSeen, StatusReceived}, 1); !reflect.DeepEqual(got, []string{"1", "3", "5"}) {
		t.Errorf("SEEN+RECEIVED: %v", got)
	}
	// The base's own status does not have to match the filter.
	items, more, err := s.List(ctx, "u", "1", []Status{StatusDefault}, 10)
	if err != nil || more || !reflect.DeepEqual(ids(items), []string{"2", "4", "6"}) {
		t.Errorf("base outside filter: %v %v %v", ids(items), more, err)
	}
	// Listing never changes anything.
	if n, _ := s.coll().CountDocuments(ctx, bson.M{"status": StatusDefault}); n != 3 {
		t.Errorf("statuses changed: %d DEFAULT", n)
	}
}

func TestStoreListUserIsolationAndBase(t *testing.T) {
	s, ctx := newTestStore(t)
	seed(t, s, ctx, "mine", "u", t0, StatusDefault)
	seed(t, s, ctx, "theirs", "other", t0.Add(time.Second), StatusDefault)
	items, _, err := s.List(ctx, "u", "", nil, 10)
	if err != nil || !reflect.DeepEqual(ids(items), []string{"mine"}) {
		t.Fatalf("got %v %v", ids(items), err)
	}
	for _, base := range []string{"theirs", "unknown"} {
		if _, _, err := s.List(ctx, "u", base, nil, 10); !errors.Is(err, ErrBaseNotFound) {
			t.Errorf("base %q: want ErrBaseNotFound, got %v", base, err)
		}
	}
}

func TestStoreListDecodesNestedPayload(t *testing.T) {
	s, ctx := newTestStore(t)
	typ := "t"
	if _, _, err := s.Insert(ctx, "p", Message{UserID: "u", Message: "m", PayloadType: &typ, Payload: map[string]any{"a": map[string]any{"b": []any{1, "x"}}}}); err != nil {
		t.Fatal(err)
	}
	items, _, err := s.List(ctx, "u", "", nil, 10)
	if err != nil || len(items) != 1 {
		t.Fatal(items, err)
	}
	b, err := json.Marshal(items[0].Payload)
	if err != nil || string(b) != `{"a":{"b":[1,"x"]}}` {
		t.Fatalf("payload json: %s %v", b, err)
	}
}

func TestStoreUserIndexMigration(t *testing.T) {
	s, ctx := newTestStore(t)
	if err := s.coll().Indexes().DropOne(ctx, userIndexName); err != nil {
		t.Fatal(err)
	}
	_, err := s.coll().Indexes().CreateOne(ctx, mongo.IndexModel{Keys: bson.D{{Key: "user_id", Value: 1}, {Key: "created_at", Value: -1}}})
	if err != nil {
		t.Fatal(err)
	}
	for run := 0; run < 2; run++ { // the second run is a no-op
		if err := s.EnsureSchema(ctx, testRetention); err != nil {
			t.Fatal(err)
		}
		idx := listIndexes(t, s, ctx)
		if _, ok := idx[userIndexName]; !ok {
			t.Fatalf("run %d: new index missing: %+v", run, idx)
		}
		if _, ok := idx[oldUserIndexName]; ok {
			t.Fatalf("run %d: old index still there: %+v", run, idx)
		}
	}
	wantTTL(t, s, ctx, 30*86400)
}

func statusOf(t *testing.T, s *Store, ctx context.Context, id string) Notification {
	t.Helper()
	var n Notification
	if err := s.coll().FindOne(ctx, bson.M{"_id": id}).Decode(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestStoreUpdateStatuses(t *testing.T) {
	s, ctx := newTestStore(t)
	seed(t, s, ctx, "a", "u1", t0, StatusDefault)
	seed(t, s, ctx, "b", "u1", t0.Add(time.Hour), StatusSeen)
	seed(t, s, ctx, "c", "u1", t0.Add(2*time.Hour), StatusReceived)
	seed(t, s, ctx, "x", "u2", t0, StatusDefault)
	before := statusOf(t, s, ctx, "a")

	updated, missing, err := s.UpdateStatuses(ctx, "u1", []StatusUpdate{{"a", StatusSeen}, {"b", StatusDefault}, {"c", StatusReceived}})
	if err != nil || updated != 3 || len(missing) != 0 {
		t.Fatalf("updated=%d missing=%v err=%v", updated, missing, err)
	}
	for id, want := range map[string]Status{"a": StatusSeen, "b": StatusDefault, "c": StatusReceived, "x": StatusDefault} {
		if got := statusOf(t, s, ctx, id).Status; got != want {
			t.Errorf("%s: status %s, want %s", id, got, want)
		}
	}
	after := statusOf(t, s, ctx, "a")
	before.Status = StatusSeen
	if !reflect.DeepEqual(before, after) { // everything but status (incl. created_at) is untouched
		t.Errorf("other fields changed: %+v vs %+v", before, after)
	}
	if x := statusOf(t, s, ctx, "x"); x.UserID != "u2" || x.Message != "m-x" {
		t.Errorf("other user's doc touched: %+v", x)
	}
}

func TestStoreUpdateStatusesAppliesOnlyOwned(t *testing.T) {
	s, ctx := newTestStore(t)
	seed(t, s, ctx, "a", "u1", t0, StatusDefault)
	seed(t, s, ctx, "b", "u1", t0, StatusDefault)
	seed(t, s, ctx, "x", "u2", t0, StatusDefault)

	updated, missing, err := s.UpdateStatuses(ctx, "u1", []StatusUpdate{{"a", StatusSeen}, {"x", StatusSeen}, {"nope", StatusSeen}, {"b", StatusReceived}})
	if err != nil || updated != 2 || !reflect.DeepEqual(missing, []string{"x", "nope"}) {
		t.Fatalf("updated=%d missing=%v err=%v", updated, missing, err)
	}
	for id, want := range map[string]Status{"a": StatusSeen, "b": StatusReceived, "x": StatusDefault} {
		if got := statusOf(t, s, ctx, id).Status; got != want {
			t.Errorf("%s: status %s, want %s", id, got, want)
		}
	}
	if x := statusOf(t, s, ctx, "x"); x.UserID != "u2" || x.Message != "m-x" {
		t.Errorf("other user's doc touched: %+v", x)
	}
}

func TestStoreUpdateStatusesAllMissing(t *testing.T) {
	s, ctx := newTestStore(t)
	seed(t, s, ctx, "x", "u2", t0, StatusDefault)

	updated, missing, err := s.UpdateStatuses(ctx, "u1", []StatusUpdate{{"x", StatusSeen}, {"nope", StatusSeen}})
	if err != nil || updated != 0 || !reflect.DeepEqual(missing, []string{"x", "nope"}) {
		t.Fatalf("updated=%d missing=%v err=%v", updated, missing, err)
	}
	if got := statusOf(t, s, ctx, "x").Status; got != StatusDefault {
		t.Errorf("x changed to %s", got)
	}
}

func TestStoreUpdateStatusesSameStatus(t *testing.T) {
	s, ctx := newTestStore(t)
	seed(t, s, ctx, "a", "u1", t0, StatusSeen)
	updated, missing, err := s.UpdateStatuses(ctx, "u1", []StatusUpdate{{"a", StatusSeen}})
	if err != nil || updated != 1 || len(missing) != 0 || statusOf(t, s, ctx, "a").Status != StatusSeen {
		t.Fatalf("updated=%d missing=%v err=%v", updated, missing, err)
	}
}
