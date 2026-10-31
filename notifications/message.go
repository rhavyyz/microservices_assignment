package main

import (
	"bytes"
	"crypto/sha1"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Status is the lifecycle state of a stored notification.
type Status string

const (
	StatusDefault  Status = "DEFAULT"
	StatusReceived Status = "RECEIVED"
	StatusSeen     Status = "SEEN"
)

// Statuses lists every valid Status; the Mongo validator is built from it.
var Statuses = []Status{StatusDefault, StatusReceived, StatusSeen}

// Message is a validated notification as produced to Kafka. Optional fields are nil when absent.
type Message struct {
	UserID      string
	Message     string
	RedirectURL *string
	Payload     map[string]any
	PayloadType *string
}

// ParseMessage decodes and validates a Kafka record value.
// Fields other than the known ones (id, status, seen, ...) are ignored.
func ParseMessage(value []byte) (Message, error) {
	var raw struct {
		UserID      string          `json:"user_id"`
		Message     string          `json:"message"`
		RedirectURL string          `json:"redirect_url"`
		Payload     json.RawMessage `json:"payload"`
		PayloadType string          `json:"payload_type"`
	}
	if err := json.Unmarshal(value, &raw); err != nil {
		return Message{}, fmt.Errorf("bad JSON: %w", err)
	}
	var m Message
	if m.UserID = strings.TrimSpace(raw.UserID); m.UserID == "" {
		return Message{}, errors.New("user_id is required")
	}
	if m.Message = strings.TrimSpace(raw.Message); m.Message == "" {
		return Message{}, errors.New("message is required")
	}
	if u := strings.TrimSpace(raw.RedirectURL); u != "" {
		m.RedirectURL = &u
	}
	if t := strings.TrimSpace(raw.PayloadType); t != "" {
		m.PayloadType = &t
	}
	if p := bytes.TrimSpace(raw.Payload); len(p) > 0 && !bytes.Equal(p, []byte("null")) {
		if p[0] != '{' {
			return Message{}, errors.New("payload must be a JSON object")
		}
		if err := json.Unmarshal(p, &m.Payload); err != nil {
			return Message{}, fmt.Errorf("bad payload: %w", err)
		}
	}
	if (m.Payload == nil) != (m.PayloadType == nil) {
		return Message{}, errors.New("payload and payload_type must be both present or both absent")
	}
	return m, nil
}

// namespace is the fixed UUIDv5 namespace of this service's notification ids.
var namespace = [16]byte{0x6b, 0x1f, 0x3c, 0x52, 0x8a, 0x4d, 0x4e, 0x0b, 0x9c, 0x71, 0x2d, 0x5e, 0xa3, 0x07, 0xf4, 0x19}

// uuidV5 returns the RFC 4122 version 5 UUID of name in the given namespace.
func uuidV5(ns [16]byte, name string) string {
	h := sha1.New()
	h.Write(ns[:])
	h.Write([]byte(name))
	b := h.Sum(nil)[:16]
	b[6] = b[6]&0x0f | 0x50
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// NotificationID derives the stable _id of a record, so a redelivery maps to the same document.
func NotificationID(topic string, partition int32, offset int64) string {
	return uuidV5(namespace, fmt.Sprintf("%s/%d/%d", topic, partition, offset))
}
