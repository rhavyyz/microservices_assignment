package main

import (
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
