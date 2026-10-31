package main

import (
	"reflect"
	"testing"
)

func TestParseMinimal(t *testing.T) {
	m, err := ParseMessage([]byte(`{"user_id":" u1 ","message":"hi"}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.UserID != "u1" || m.Message != "hi" || m.RedirectURL != nil || m.Payload != nil || m.PayloadType != nil {
		t.Fatalf("unexpected: %+v", m)
	}
}

func TestParseAllFields(t *testing.T) {
	m, err := ParseMessage([]byte(`{"user_id":"u","message":"m","redirect_url":"/x?y=1","payload":{"a":1,"b":{"c":true}},"payload_type":"order"}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.RedirectURL == nil || *m.RedirectURL != "/x?y=1" || m.PayloadType == nil || *m.PayloadType != "order" {
		t.Fatalf("unexpected: %+v", m)
	}
	if !reflect.DeepEqual(m.Payload, map[string]any{"a": float64(1), "b": map[string]any{"c": true}}) {
		t.Fatalf("payload: %v", m.Payload)
	}
}

func TestParseInvalid(t *testing.T) {
	cases := map[string]string{
		"bad json":              `{`,
		"not an object":         `[1]`,
		"missing user_id":       `{"message":"m"}`,
		"blank user_id":         `{"user_id":"  ","message":"m"}`,
		"missing message":       `{"user_id":"u"}`,
		"blank message":         `{"user_id":"u","message":"\t"}`,
		"payload without type":  `{"user_id":"u","message":"m","payload":{}}`,
		"type without payload":  `{"user_id":"u","message":"m","payload_type":"t"}`,
		"null payload w/ type":  `{"user_id":"u","message":"m","payload":null,"payload_type":"t"}`,
		"array payload":         `{"user_id":"u","message":"m","payload":[1],"payload_type":"t"}`,
		"scalar payload":        `{"user_id":"u","message":"m","payload":"s","payload_type":"t"}`,
		"number payload":        `{"user_id":"u","message":"m","payload":3,"payload_type":"t"}`,
		"blank type w/ payload": `{"user_id":"u","message":"m","payload":{},"payload_type":" "}`,
		"wrong field type":      `{"user_id":1,"message":"m"}`,
	}
	for name, in := range cases {
		if _, err := ParseMessage([]byte(in)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestParseAbsentForms(t *testing.T) {
	m, err := ParseMessage([]byte(`{"user_id":"u","message":"m","redirect_url":"  ","payload":null,"payload_type":""}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.RedirectURL != nil || m.Payload != nil || m.PayloadType != nil {
		t.Fatalf("expected all optional absent: %+v", m)
	}
}

func TestParseIgnoresIdStatusSeen(t *testing.T) {
	a, err := ParseMessage([]byte(`{"user_id":"u","message":"m"}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := ParseMessage([]byte(`{"user_id":"u","message":"m","id":"x","status":"SEEN","seen":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("extra fields changed result: %+v vs %+v", a, b)
	}
}

func TestUUIDv5KnownVector(t *testing.T) {
	// RFC 4122 DNS namespace, name "www.example.com" (well-known vector).
	dns := [16]byte{0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8}
	if got, want := uuidV5(dns, "www.example.com"), "2ed6657d-e927-568b-95e1-2665a8aea6a2"; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestNotificationID(t *testing.T) {
	a := NotificationID("notifications", 0, 5)
	if a != NotificationID("notifications", 0, 5) {
		t.Fatal("not stable")
	}
	if a == NotificationID("notifications", 0, 6) || a == NotificationID("notifications", 1, 5) || a == NotificationID("other", 0, 5) {
		t.Fatal("collision across offset/partition/topic")
	}
}
