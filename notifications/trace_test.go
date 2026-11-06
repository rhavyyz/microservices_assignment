package main

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
)

type fakeStoreAPI struct {
	fakeLister
	fakeUpdater
}

func (fakeStoreAPI) Ping(context.Context) error { return nil }

// captureLog redirects the standard logger for the duration of the test.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return &buf
}

func serve(h http.Handler, method, path, trace, user string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(`[{"id":"`+testUUID+`","status":"SEEN"}]`))
	if trace != "" {
		req.Header.Set("X-Trace-Id", trace)
	}
	if user != "" {
		req.Header.Set("X-User-Id", user)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestTraceValidEchoedAndLogged(t *testing.T) {
	buf := captureLog(t)
	h := withTrace(newMux(&fakeStoreAPI{}))
	rec := serve(h, "GET", "/list", "my-trace.id_01", "u1")
	if rec.Code != 200 || rec.Header().Get("X-Trace-Id") != "my-trace.id_01" {
		t.Fatalf("code=%d header=%q", rec.Code, rec.Header().Get("X-Trace-Id"))
	}
	if !strings.Contains(buf.String(), "GET /list status=200 ") || !strings.Contains(buf.String(), "user=u1 trace_id=my-trace.id_01") {
		t.Fatalf("access log: %q", buf.String())
	}
}

func TestTraceInvalidOrAbsentReplaced(t *testing.T) {
	h := withTrace(newMux(&fakeStoreAPI{}))
	for _, in := range []string{"", "short", "has space in it", "bad/chars/here", strings.Repeat("a", 65)} {
		got := serve(h, "GET", "/list", in, "u1").Header().Get("X-Trace-Id")
		if !traceIDRe.MatchString(got) || got == in {
			t.Errorf("in %q: got %q", in, got)
		}
	}
	a := serve(h, "GET", "/list", "", "u1").Header().Get("X-Trace-Id")
	b := serve(h, "GET", "/list", "", "u1").Header().Get("X-Trace-Id")
	if a == b {
		t.Error("generated ids must differ")
	}
}

func TestTraceOnErrorsAndOtherEndpoints(t *testing.T) {
	buf := captureLog(t)
	st := &fakeStoreAPI{}
	st.fakeLister.err = errors.New("boom")
	h := withTrace(newMux(st))
	const id = "trace-abc-123"
	for _, tc := range []struct {
		method, path, user string
		code               int
	}{
		{"GET", "/list", "", 401},
		{"PUT", "/update-state", "", 401},
		{"GET", "/list?limit=0", "u1", 400},
		{"GET", "/list", "u1", 500},
		{"GET", "/healthcheck", "", 200},
		{"GET", "/openapi.json", "", 200},
	} {
		rec := serve(h, tc.method, tc.path, id, tc.user)
		if rec.Code != tc.code || rec.Header().Get("X-Trace-Id") != id {
			t.Errorf("%s %s: code=%d header=%q", tc.method, tc.path, rec.Code, rec.Header().Get("X-Trace-Id"))
		}
	}
	logs := buf.String()
	if !strings.Contains(logs, "list notifications: boom trace_id="+id) {
		t.Errorf("handler error log lacks trace id: %q", logs)
	}
	if !strings.Contains(logs, "GET /list status=401 ") || !strings.Contains(logs, "user=- trace_id="+id) {
		t.Errorf("access log: %q", logs)
	}
	if strings.Contains(logs, "/healthcheck") {
		t.Errorf("healthcheck must not be access-logged: %q", logs)
	}
}

func TestTraceUpdateErrorLogged(t *testing.T) {
	buf := captureLog(t)
	st := &fakeStoreAPI{}
	st.fakeUpdater.err = errors.New("down")
	rec := serve(withTrace(newMux(st)), "PUT", "/update-state", "trace-upd-1234", "u1")
	if rec.Code != 500 || rec.Header().Get("X-Trace-Id") != "trace-upd-1234" {
		t.Fatalf("code=%d header=%q", rec.Code, rec.Header().Get("X-Trace-Id"))
	}
	if !strings.Contains(buf.String(), "update notification statuses: down trace_id=trace-upd-1234") {
		t.Fatalf("log: %q", buf.String())
	}
}

func TestOpenAPIDocumentsTraceHeader(t *testing.T) {
	for path, ops := range openAPI["paths"].(map[string]any) {
		for method, op := range ops.(map[string]any) {
			op := op.(map[string]any)
			found := false
			for _, p := range op["parameters"].([]any) {
				if m := p.(map[string]any); m["name"] == "X-Trace-Id" && m["required"] == false {
					found = true
				}
			}
			if !found {
				t.Errorf("%s %s: no optional X-Trace-Id parameter", method, path)
			}
			for code, resp := range op["responses"].(map[string]any) {
				if _, ok := resp.(map[string]any)["headers"].(map[string]any)["X-Trace-Id"]; !ok {
					t.Errorf("%s %s %s: no X-Trace-Id response header", method, path, code)
				}
			}
		}
	}
}

func TestParseTraceID(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{`{"user_id":"u","message":"m","trace_id":"abcdefgh-1"}`, "abcdefgh-1"},
		{`{"user_id":"u","message":"m","trace_id":"bad id"}`, ""},
		{`{"user_id":"u","message":"m","trace_id":"short"}`, ""},
		{`{"user_id":"u","message":"m","trace_id":null}`, ""},
		{`{"user_id":"u","message":"m","trace_id":12345678}`, ""},
		{`{"user_id":"u","message":"m"}`, ""},
	} {
		m, err := ParseMessage([]byte(tc.in))
		if err != nil || m.TraceID != tc.want {
			t.Errorf("%s: got %q, %v", tc.in, m.TraceID, err)
		}
		if got := parseTraceID([]byte(tc.in)); got != tc.want {
			t.Errorf("%s: parseTraceID %q", tc.in, got)
		}
	}
	if parseTraceID([]byte(`{`)) != "" || parseTraceID([]byte(`[1]`)) != "" {
		t.Error("unparseable values must give an empty trace id")
	}
}

func TestHandleLogsTraceID(t *testing.T) {
	for _, tc := range []struct{ name, value, want string }{
		{"valid", `{"user_id":"u1","message":"hi","trace_id":"kafka-trace-1"}`, "trace_id=kafka-trace-1"},
		{"invalid", `{"user_id":"u1","message":"hi","trace_id":"no good"}`, "trace_id=-"},
		{"missing", validRec, "trace_id=-"},
		{"skipped with id", `{"user_id":"","message":"x","trace_id":"kafka-trace-2"}`, "skipping invalid message notifications/2/7: user_id is required trace_id=kafka-trace-2"},
		{"skipped without id", `{"user_id":"","message":"x"}`, "user_id is required trace_id=-"},
		{"skipped bad json", `{`, "trace_id=-"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			buf := captureLog(t)
			c := &Consumer{store: &fakeStore{getErr: mongo.ErrNoDocuments}, pub: &fakePub{}}
			if !c.handle(context.Background(), rec(tc.value)) {
				t.Fatal("handle should be done")
			}
			if !strings.Contains(buf.String(), tc.want) {
				t.Fatalf("log %q lacks %q", buf.String(), tc.want)
			}
		})
	}
}

func TestHandleStoreErrorLogsTraceID(t *testing.T) {
	buf := captureLog(t)
	c := &Consumer{store: &fakeStore{insErr: errors.New("down")}, pub: &fakePub{}}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	c.handle(ctx, rec(`{"user_id":"u1","message":"hi","trace_id":"kafka-trace-3"}`))
	if !strings.Contains(buf.String(), "trace_id=kafka-trace-3: down") {
		t.Fatalf("log: %q", buf.String())
	}
}

func TestAccessLogInstanceOnce(t *testing.T) {
	buf := captureLog(t)
	log.SetPrefix("instance=notif-test:8080 ")
	t.Cleanup(func() { log.SetPrefix("") })
	serve(withTrace(newMux(&fakeStoreAPI{})), "GET", "/list", "my-trace.id_01", "u1")
	line := strings.TrimSpace(buf.String())
	t.Log(line)
	if strings.Count(line, "instance=") != 1 || !strings.HasPrefix(line, "instance=notif-test:8080 ") {
		t.Errorf("access log: %q", line)
	}
}
