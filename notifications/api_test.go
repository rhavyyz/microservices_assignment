package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

type fakeLister struct {
	items    []Notification
	hasMore  bool
	err      error
	calls    int
	user     string
	base     string
	statuses []Status
	limit    int
}

func (f *fakeLister) List(_ context.Context, userID, base string, statuses []Status, limit int) ([]Notification, bool, error) {
	f.calls++
	f.user, f.base, f.statuses, f.limit = userID, base, statuses, limit
	return f.items, f.hasMore, f.err
}

const testUUID = "6b1f3c52-8a4d-4e0b-9c71-2d5ea307f419"

func doList(l lister, query, user string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", "/list?"+query, nil)
	if user != "" {
		req.Header.Set("X-User-Id", user)
	}
	rec := httptest.NewRecorder()
	listHandler(l).ServeHTTP(rec, req)
	return rec
}

func TestListUnauthorized(t *testing.T) {
	for _, u := range []string{"", "   "} {
		f := &fakeLister{}
		if rec := doList(f, "", u); rec.Code != 401 || f.calls != 0 {
			t.Errorf("user %q: code=%d calls=%d", u, rec.Code, f.calls)
		}
	}
}

func TestListBadParams(t *testing.T) {
	for _, q := range []string{
		"limit=0", "limit=101", "limit=abc", "limit=-1", "limit=1.5",
		"status=BOGUS", "status=seen", "status=DEFAULT,NOPE", "status=DEFAULT&status=x",
		"base_notification_id=abc", "base_notification_id=6b1f3c52-8a4d-4e0b-9c71-2d5ea307f41", "base_notification_id=zb1f3c52-8a4d-4e0b-9c71-2d5ea307f419",
	} {
		f := &fakeLister{}
		if rec := doList(f, q, "u1"); rec.Code != 400 || f.calls != 0 {
			t.Errorf("%s: code=%d calls=%d", q, rec.Code, f.calls)
		}
	}
}

func TestListParsing(t *testing.T) {
	for _, tc := range []struct {
		query    string
		statuses []Status
		limit    int
		base     string
	}{
		{"", nil, 20, ""},
		{"limit=100", nil, 100, ""},
		{"limit=1&base_notification_id=" + testUUID, nil, 1, testUUID},
		{"base_notification_id=", nil, 20, ""},
		{"status=DEFAULT&status=SEEN", []Status{StatusDefault, StatusSeen}, 20, ""},
		{"status=DEFAULT,SEEN", []Status{StatusDefault, StatusSeen}, 20, ""},
		{"status=SEEN,DEFAULT&status=SEEN&status=RECEIVED,DEFAULT", []Status{StatusSeen, StatusDefault, StatusReceived}, 20, ""},
		{"status=", nil, 20, ""},
	} {
		f := &fakeLister{}
		if rec := doList(f, tc.query, "  u1 "); rec.Code != 200 {
			t.Fatalf("%s: code=%d %s", tc.query, rec.Code, rec.Body)
		}
		if f.user != "u1" || f.limit != tc.limit || f.base != tc.base || !reflect.DeepEqual(f.statuses, tc.statuses) {
			t.Errorf("%s: got user=%q limit=%d base=%q statuses=%v", tc.query, f.user, f.limit, f.base, f.statuses)
		}
	}
}

func TestListResponseShape(t *testing.T) {
	url, typ := "/x", "order"
	at := time.Date(2026, 1, 2, 3, 4, 5, 678000000, time.FixedZone("x", 3600))
	f := &fakeLister{hasMore: true, items: []Notification{
		{ID: "a", UserID: "u1", Message: "m1", RedirectURL: &url, Payload: map[string]any{"k": "v"}, PayloadType: &typ, Status: StatusSeen, CreatedAt: at},
		{ID: "b", UserID: "u1", Message: "m2", Status: StatusDefault, CreatedAt: at},
	}}
	rec := doList(f, "", "u1")
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type %q", ct)
	}
	if strings.Contains(rec.Body.String(), "user_id") {
		t.Errorf("user_id leaked: %s", rec.Body)
	}
	var got struct {
		Notifications []map[string]any `json:"notifications"`
		Next          *string          `json:"next_base_notification_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Next == nil || *got.Next != "b" || len(got.Notifications) != 2 {
		t.Fatalf("unexpected: %s", rec.Body)
	}
	a, b := got.Notifications[0], got.Notifications[1]
	if a["id"] != "a" || a["message"] != "m1" || a["redirect_url"] != "/x" || a["payload_type"] != "order" ||
		a["status"] != "SEEN" || a["created_at"] != "2026-01-02T02:04:05.678Z" || a["payload"].(map[string]any)["k"] != "v" {
		t.Errorf("item a: %v", a)
	}
	for _, k := range []string{"redirect_url", "payload", "payload_type"} {
		if v, ok := b[k]; !ok || v != nil {
			t.Errorf("item b %s: want null, got %v (present=%v)", k, v, ok)
		}
	}
}

func TestListEmptyAndLastPage(t *testing.T) {
	rec := doList(&fakeLister{}, "", "u1")
	if got := strings.TrimSpace(rec.Body.String()); got != `{"notifications":[],"next_base_notification_id":null}` {
		t.Errorf("empty: %s", got)
	}
	f := &fakeLister{items: []Notification{{ID: "a", Status: StatusDefault}}}
	if got := doList(f, "", "u1").Body.String(); !strings.Contains(got, `"next_base_notification_id":null`) {
		t.Errorf("last page: %s", got)
	}
}

func TestListErrors(t *testing.T) {
	rec := doList(&fakeLister{err: ErrBaseNotFound}, "base_notification_id="+testUUID, "u1")
	if rec.Code != 404 {
		t.Errorf("not found: %d", rec.Code)
	}
	rec = doList(&fakeLister{err: errors.New("mongo: secret host db:27017 down")}, "", "u1")
	if rec.Code != 500 || strings.Contains(rec.Body.String(), "secret") || strings.Contains(rec.Body.String(), "mongo") {
		t.Errorf("internal: %d %s", rec.Code, rec.Body)
	}
}

func TestListMuxRoute(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /list", listHandler(&fakeLister{}))
	req := httptest.NewRequest("POST", "/list", nil)
	req.Header.Set("X-User-Id", "u1")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d", rec.Code)
	}
}

type fakeUpdater struct {
	updated  int      // reported by UpdateStatuses
	notFound []string // reported by UpdateStatuses
	err      error
	calls    int
	user     string
	updates  []StatusUpdate
}

func (f *fakeUpdater) UpdateStatuses(_ context.Context, userID string, updates []StatusUpdate) (int, []string, error) {
	f.calls++
	f.user, f.updates = userID, updates
	return f.updated, f.notFound, f.err
}

const (
	uuidA = "6b1f3c52-8a4d-4e0b-9c71-2d5ea307f419"
	uuidB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	uuidC = "11111111-2222-4333-8444-555555555555"
)

func doUpdate(u statusUpdater, body, user string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("PUT", "/update-state", strings.NewReader(body))
	if user != "" {
		req.Header.Set("X-User-Id", user)
	}
	rec := httptest.NewRecorder()
	updateStateHandler(u).ServeHTTP(rec, req)
	return rec
}

// wantUpdate checks the JSON answer: status code, content type, and the decoded updated and errors.
func wantUpdate(t *testing.T, rec *httptest.ResponseRecorder, code, updated int, errs map[string]string) {
	t.Helper()
	if rec.Code != code || rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("code=%d (want %d) content-type=%q body=%s", rec.Code, code, rec.Header().Get("Content-Type"), rec.Body)
	}
	var got struct {
		Updated int               `json:"updated"`
		Errors  map[string]string `json:"errors"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("%v: %s", err, rec.Body)
	}
	if got.Updated != updated || got.Errors == nil || !reflect.DeepEqual(got.Errors, errs) {
		t.Errorf("got updated=%d errors=%v, want updated=%d errors=%v (%s)", got.Updated, got.Errors, updated, errs, rec.Body)
	}
}

func TestUpdateStateUnauthorized(t *testing.T) {
	for _, u := range []string{"", "   "} {
		f := &fakeUpdater{}
		if rec := doUpdate(f, `[{"id":"`+uuidA+`","status":"SEEN"}]`, u); rec.Code != 401 || f.calls != 0 {
			t.Errorf("user %q: code=%d", u, rec.Code)
		}
	}
}

func TestUpdateStateBadBody(t *testing.T) {
	var many []string
	for i := 0; i < 101; i++ {
		many = append(many, `{"id":"`+uuidA+`","status":"SEEN"}`)
	}
	for name, body := range map[string]string{
		"bad json":    `[{"id":`,
		"object":      `{"id":"` + uuidA + `","status":"SEEN"}`,
		"scalar":      `"x"`,
		"null":        `null`,
		"empty":       ``,
		"empty array": `[]`,
		"bad item":    `[1]`,
		"id number":   `[{"id":1,"status":"SEEN"}]`,
		"trailing":    `[] []`,
		"101 items":   "[" + strings.Join(many, ",") + "]",
	} {
		f := &fakeUpdater{}
		rec := doUpdate(f, body, "u1")
		if rec.Code != 400 || strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") || f.calls != 0 {
			t.Errorf("%s: code=%d ct=%q calls=%d", name, rec.Code, rec.Header().Get("Content-Type"), f.calls)
		}
	}
	rec := doUpdate(&fakeUpdater{}, "["+strings.Join(many, ",")+"]", "u1")
	if !strings.Contains(rec.Body.String(), "at most 100 updates per request") {
		t.Errorf("101 items body: %s", rec.Body)
	}
	if rec := doUpdate(&fakeUpdater{}, "["+strings.Repeat(" ", 1<<20)+"]", "u1"); rec.Code != 400 {
		t.Errorf("too large: %d", rec.Code)
	}
}

func TestUpdateStateItemErrors(t *testing.T) {
	for name, tc := range map[string]struct {
		body string
		want map[string]string
	}{
		"invalid id":        {`[{"id":"abc","status":"SEEN"}]`, map[string]string{"abc": "invalid id"}},
		"missing id":        {`[{"status":"SEEN"}]`, map[string]string{"": "invalid id"}},
		"blank id":          {`[{"id":"  ","status":"SEEN"}]`, map[string]string{"": "invalid id"}},
		"invalid status":    {`[{"id":"` + uuidA + `","status":"BOGUS"}]`, map[string]string{uuidA: "invalid status"}},
		"missing status":    {`[{"id":"` + uuidA + `"}]`, map[string]string{uuidA: "invalid status"}},
		"lowercase status":  {`[{"id":"` + uuidA + `","status":"seen"}]`, map[string]string{uuidA: "invalid status"}},
		"duplicate":         {`[{"id":"` + uuidA + `","status":"SEEN"},{"id":" ` + uuidA + `","status":"SEEN"}]`, map[string]string{uuidA: "duplicate id"}},
		"duplicate differs": {`[{"id":"` + uuidA + `","status":"SEEN"},{"id":"` + uuidA + `","status":"DEFAULT"}]`, map[string]string{uuidA: "duplicate id"}},
		"status over dup":   {`[{"id":"` + uuidA + `","status":"SEEN"},{"id":"` + uuidA + `","status":"x"}]`, map[string]string{uuidA: "invalid status"}},
		"id over dup":       {`[{"id":"x","status":"SEEN"},{"id":"x","status":"SEEN"}]`, map[string]string{"x": "invalid id"}},
		"combo": {
			`[{"id":"zz","status":"SEEN"},{"id":"` + uuidB + `","status":"nope"},{"id":"` + uuidC + `","status":"SEEN"},{"id":"` + uuidC + `","status":"SEEN"}]`,
			map[string]string{"zz": "invalid id", uuidB: "invalid status", uuidC: "duplicate id"},
		},
	} {
		f := &fakeUpdater{}
		t.Run(name, func(t *testing.T) {
			// Every item fails the format check: 400, nothing updated, the store is not called.
			wantUpdate(t, doUpdate(f, tc.body, "u1"), 400, 0, tc.want)
			if f.calls != 0 {
				t.Errorf("store called despite no valid item")
			}
		})
	}
}

func TestUpdateStateMixedBatch(t *testing.T) {
	// Two format-valid items reach the store; one of them is reported missing, the other is counted by the store.
	f := &fakeUpdater{updated: 1, notFound: []string{uuidB}}
	body := `[{"id":"` + uuidA + `","status":"SEEN"},{"id":"` + uuidB + `","status":"SEEN"},{"id":"bad","status":"SEEN"},{"id":"` + uuidC + `","status":"x"}]`
	wantUpdate(t, doUpdate(f, body, "u1"), 200, 1,
		map[string]string{uuidB: "notification not found", "bad": "invalid id", uuidC: "invalid status"})
	if want := []StatusUpdate{{uuidA, StatusSeen}, {uuidB, StatusSeen}}; f.calls != 1 || !reflect.DeepEqual(f.updates, want) {
		t.Errorf("calls=%d updates=%v", f.calls, f.updates)
	}
}

func TestUpdateStateNotFound(t *testing.T) {
	// Some missing: the rest is counted through the store's updated, status 200.
	f := &fakeUpdater{updated: 1, notFound: []string{uuidB}}
	wantUpdate(t, doUpdate(f, `[{"id":"`+uuidA+`","status":"SEEN"},{"id":"`+uuidB+`","status":"SEEN"}]`, "u1"), 200, 1,
		map[string]string{uuidB: "notification not found"})

	// All missing: nothing applied, 400.
	f = &fakeUpdater{notFound: []string{uuidA, uuidB}}
	wantUpdate(t, doUpdate(f, `[{"id":"`+uuidA+`","status":"SEEN"},{"id":"`+uuidB+`","status":"SEEN"}]`, "u1"), 400, 0,
		map[string]string{uuidA: "notification not found", uuidB: "notification not found"})

	// Uppercase hex is passed as is (not lowercased).
	up := strings.ToUpper(uuidA)
	f = &fakeUpdater{notFound: []string{up}}
	wantUpdate(t, doUpdate(f, `[{"id":"`+up+`","status":"SEEN"}]`, "u1"), 400, 0, map[string]string{up: "notification not found"})
	if len(f.updates) != 1 || f.updates[0].ID != up {
		t.Errorf("updates=%v", f.updates)
	}
}

func TestUpdateStateDuplicatesSkipped(t *testing.T) {
	f := &fakeUpdater{updated: 1}
	body := `[{"id":"` + uuidA + `","status":"SEEN"},{"id":"` + uuidB + `","status":"RECEIVED"},{"id":"` + uuidA + `","status":"SEEN"}]`
	wantUpdate(t, doUpdate(f, body, "u1"), 200, 1, map[string]string{uuidA: "duplicate id"})
	if want := []StatusUpdate{{uuidB, StatusReceived}}; f.calls != 1 || !reflect.DeepEqual(f.updates, want) {
		t.Errorf("calls=%d updates=%v", f.calls, f.updates)
	}
}

func TestUpdateStateNoUpdatesNoErrors(t *testing.T) {
	// Only reachable through the TTL race: everything expired between the check and the write.
	f := &fakeUpdater{updated: 0}
	wantUpdate(t, doUpdate(f, `[{"id":"`+uuidA+`","status":"SEEN"}]`, "u1"), 200, 0, map[string]string{})
}

func TestUpdateStateSuccess(t *testing.T) {
	f := &fakeUpdater{updated: 3}
	rec := doUpdate(f, `[{"id":" `+uuidA+` ","status":"SEEN","extra":1},{"id":"`+uuidB+`","status":"DEFAULT"},{"id":"`+uuidC+`","status":"RECEIVED"}]`, "  u1 ")
	wantUpdate(t, rec, 200, 3, map[string]string{})
	if got := strings.TrimSpace(rec.Body.String()); got != `{"updated":3,"errors":{}}` {
		t.Errorf("body %s", got)
	}
	want := []StatusUpdate{{uuidA, StatusSeen}, {uuidB, StatusDefault}, {uuidC, StatusReceived}}
	if f.user != "u1" || f.calls != 1 || !reflect.DeepEqual(f.updates, want) {
		t.Errorf("user=%q calls=%d updates=%v", f.user, f.calls, f.updates)
	}
}

func TestUpdateStateStoreError(t *testing.T) {
	for _, body := range []string{`[{"id":"` + uuidA + `","status":"SEEN"}]`, `[{"id":"` + uuidA + `","status":"SEEN"},{"id":"x","status":"SEEN"}]`} {
		rec := doUpdate(&fakeUpdater{err: errors.New("mongo: secret host db:27017 down")}, body, "u1")
		if rec.Code != 500 || strings.Contains(rec.Body.String(), "secret") || strings.Contains(rec.Body.String(), "mongo") {
			t.Errorf("internal: %d %s", rec.Code, rec.Body)
		}
	}
}

func TestUpdateStateMuxRoute(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /update-state", updateStateHandler(&fakeUpdater{}))
	for _, m := range []string{"GET", "POST"} {
		req := httptest.NewRequest(m, "/update-state", nil)
		req.Header.Set("X-User-Id", "u1")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: %d", m, rec.Code)
		}
	}
}
