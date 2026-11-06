package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const traceHeader = "X-Trace-Id"

// traceIDRe is the platform rule for an accepted trace id.
var traceIDRe = regexp.MustCompile(`^[A-Za-z0-9._-]{8,64}$`)

type traceKey struct{}

// newTraceID returns 32 random hex characters.
func newTraceID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand does not fail on supported platforms
	}
	return hex.EncodeToString(b)
}

// withTraceID returns ctx carrying the trace id.
func withTraceID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, traceKey{}, id)
}

// traceIDFrom returns the trace id of ctx, or "-" when there is none.
func traceIDFrom(ctx context.Context) string {
	return dash(traceIDOf(ctx))
}

func traceIDOf(ctx context.Context) string {
	id, _ := ctx.Value(traceKey{}).(string)
	return id
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// statusWriter remembers the status code written by the handler.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// withTrace wraps next: it accepts a valid X-Trace-Id or generates one, sets it on the response header before the
// handler runs, makes it available through the request context and logs one access line per request (not /healthcheck).
func withTrace(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		id := r.Header.Get(traceHeader)
		if !traceIDRe.MatchString(id) {
			id = newTraceID()
		}
		r.Header.Set(traceHeader, id)
		w.Header().Set(traceHeader, id)
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r.WithContext(withTraceID(r.Context(), id)))
		if r.URL.Path == "/healthcheck" {
			return
		}
		if sw.status == 0 {
			sw.status = http.StatusOK
		}
		log.Printf("%s %s status=%d duration=%s user=%s trace_id=%s",
			r.Method, r.URL.Path, sw.status, time.Since(start), dash(strings.TrimSpace(r.Header.Get("X-User-Id"))), id)
	})
}

// parseTraceID extracts the optional trace_id of a Kafka record value without validating the rest of the message.
// It returns "" when the field is absent, not a string, not valid or the value is not a JSON object.
func parseTraceID(value []byte) string {
	var raw struct {
		TraceID any `json:"trace_id"`
	}
	if json.Unmarshal(value, &raw) != nil {
		return ""
	}
	return validTraceID(raw.TraceID)
}

func validTraceID(v any) string {
	s, ok := v.(string)
	if !ok || !traceIDRe.MatchString(s) {
		return ""
	}
	return s
}
