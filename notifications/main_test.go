package main

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRetentionFromEnv(t *testing.T) {
	day := 24 * time.Hour
	for _, tc := range []struct {
		in   string
		want time.Duration
		bad  bool
	}{
		{"", 30 * day, false},
		{"7", 7 * day, false},
		{"0", 0, true},
		{"-3", 0, true},
		{"abc", 0, true},
		{"1.5", 0, true},
	} {
		got, err := retentionFromEnv(func(string) string { return tc.in })
		if (err != nil) != tc.bad || got != tc.want {
			t.Errorf("RETENTION_DAYS=%q: got %v, %v", tc.in, got, err)
		}
	}
}

func TestPartitionsFromEnv(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int
		bad  bool
	}{
		{"", 6, false},
		{"12", 12, false},
		{"1", 1, false},
		{"0", 0, true},
		{"-2", 0, true},
		{"abc", 0, true},
		{"2.5", 0, true},
	} {
		got, err := partitionsFromEnv(func(string) string { return tc.in }, "NOTIFICATIONS_PARTITIONS")
		if (err != nil) != tc.bad || got != tc.want {
			t.Errorf("NOTIFICATIONS_PARTITIONS=%q: got %v, %v", tc.in, got, err)
		}
	}
}

func TestOpenAPIDeclaresGatewaySettings(t *testing.T) {
	want := map[string][2]bool{ // method path -> {isPublic, requireAuth}
		"get /healthcheck":  {false, false},
		"get /list":         {true, true},
		"put /update-state": {true, true},
		"get /openapi.json": {false, false},
	}
	rec := httptest.NewRecorder()
	newMux(nil).ServeHTTP(rec, httptest.NewRequest("GET", "/openapi.json", nil))
	var spec struct {
		Paths map[string]map[string]map[string]any `json:"paths"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &spec); err != nil {
		t.Fatal(err)
	}
	seen := 0
	for path, ops := range spec.Paths {
		for method, op := range ops {
			id := method + " " + path
			w, ok := want[id]
			if !ok {
				t.Errorf("%s: operation not in the expected table", id)
				continue
			}
			ext, ok := op["x-gateway"].(map[string]any)
			if !ok {
				t.Errorf("%s: missing x-gateway object", id)
				continue
			}
			pub, ok1 := ext["isPublic"].(bool)
			auth, ok2 := ext["requireAuth"].(bool)
			if !ok1 || !ok2 {
				t.Errorf("%s: isPublic and requireAuth must be booleans, got %v", id, ext)
				continue
			}
			if pub != w[0] || auth != w[1] {
				t.Errorf("%s: got isPublic=%v requireAuth=%v, want %v", id, pub, auth, w)
			}
			seen++
		}
	}
	if seen == 0 {
		t.Error("no operations found in the spec")
	}
}
