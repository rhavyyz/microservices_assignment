package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

const defaultRetentionDays = 30

// retentionFromEnv reads RETENTION_DAYS (a positive integer), falling back to the default.
func retentionFromEnv(getenv func(string) string) (time.Duration, error) {
	days := defaultRetentionDays
	if v := getenv("RETENTION_DAYS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return 0, fmt.Errorf("RETENTION_DAYS must be an integer >= 1, got %q", v)
		}
		days = n
	}
	return time.Duration(days) * 24 * time.Hour, nil
}

const defaultPartitions = 6

// partitionsFromEnv reads a partition count variable (a positive integer), falling back to the default.
func partitionsFromEnv(getenv func(string) string, key string) (int, error) {
	if v := getenv(key); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return 0, fmt.Errorf("%s must be an integer >= 1, got %q", key, v)
		}
		return n, nil
	}
	return defaultPartitions, nil
}

// updateStateSchema is the JSON body of the 200 and of the per-item 400 of PUT /update-state.
var updateStateSchema = map[string]any{
	"type":     "object",
	"required": []any{"updated", "errors"},
	"properties": map[string]any{
		"updated": map[string]any{"type": "integer", "description": "Notifications matched by the write"},
		"errors":  map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "string"}},
	},
}

// openAPI is the service's spec: the healthcheck, the notifications listing and the batch status update.
var openAPI = map[string]any{
	"openapi": "3.0.3",
	"info":    map[string]any{"title": "notifications", "version": "1.0.0"},
	"paths": map[string]any{
		"/healthcheck": map[string]any{
			"get": map[string]any{
				"summary": "200 when MongoDB is reachable, 503 otherwise",
				"responses": map[string]any{
					"200": map[string]any{"description": "Healthy"},
					"503": map[string]any{"description": "MongoDB unreachable"},
				},
			},
		},
		"/list": map[string]any{
			"get": map[string]any{
				"summary": "A user's notifications, newest first, cursor-paginated (read-only)",
				"parameters": []any{
					map[string]any{"name": "X-User-Id", "in": "header", "required": true, "schema": map[string]any{"type": "string"}},
					map[string]any{
						"name": "base_notification_id", "in": "query", "required": false,
						"description": "Return the notifications older than this one; absent = the most recent",
						"schema":      map[string]any{"type": "string", "format": "uuid"},
					},
					map[string]any{
						"name": "status", "in": "query", "required": false, "style": "form", "explode": true,
						"description": "Repeatable (or comma-separated); absent = all statuses",
						"schema": map[string]any{
							"type":  "array",
							"items": map[string]any{"type": "string", "enum": []any{"DEFAULT", "RECEIVED", "SEEN"}},
						},
					},
					map[string]any{
						"name": "limit", "in": "query", "required": false,
						"schema": map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
					},
				},
				"responses": map[string]any{
					"200": map[string]any{
						"description": "A page of notifications; next_base_notification_id is null on the last page",
						"content": map[string]any{"application/json": map[string]any{"schema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"notifications": map[string]any{"type": "array", "items": map[string]any{
									"type": "object",
									"properties": map[string]any{
										"id":           map[string]any{"type": "string"},
										"message":      map[string]any{"type": "string"},
										"redirect_url": map[string]any{"type": "string", "nullable": true},
										"payload":      map[string]any{"type": "object", "nullable": true},
										"payload_type": map[string]any{"type": "string", "nullable": true},
										"status":       map[string]any{"type": "string", "enum": []any{"DEFAULT", "RECEIVED", "SEEN"}},
										"created_at":   map[string]any{"type": "string", "format": "date-time"},
									},
								}},
								"next_base_notification_id": map[string]any{"type": "string", "nullable": true},
							},
						}}},
					},
					"400": map[string]any{"description": "Invalid base_notification_id, status or limit"},
					"401": map[string]any{"description": "Missing X-User-Id"},
					"404": map[string]any{"description": "base_notification_id not found for this user (or expired)"},
					"500": map[string]any{"description": "Internal error"},
				},
			},
		},
		"/update-state": map[string]any{
			"put": map[string]any{
				"summary": "Set the status of several of the user's notifications, applying the valid ones and skipping the others (any status to any status)",
				"parameters": []any{
					map[string]any{"name": "X-User-Id", "in": "header", "required": true, "schema": map[string]any{"type": "string"}},
				},
				"requestBody": map[string]any{
					"required":    true,
					"description": "1 to 100 items; an id that appears more than once is skipped",
					"content": map[string]any{"application/json": map[string]any{"schema": map[string]any{
						"type": "array", "minItems": 1, "maxItems": 100,
						"items": map[string]any{
							"type":     "object",
							"required": []any{"id", "status"},
							"properties": map[string]any{
								"id":     map[string]any{"type": "string", "format": "uuid"},
								"status": map[string]any{"type": "string", "enum": []any{"DEFAULT", "RECEIVED", "SEEN"}},
							},
						},
					}}},
				},
				"responses": map[string]any{
					"200": map[string]any{
						"description": "At least one notification was updated; items that failed are in errors (an empty object if none)",
						"content":     map[string]any{"application/json": map[string]any{"schema": updateStateSchema}},
					},
					"400": map[string]any{
						"description": "Malformed body, empty array or more than 100 items (plain text); or no item could be applied, in which case the JSON body has updated 0 and errors maps each id to its justification (\"invalid id\", \"invalid status\", \"duplicate id\", \"notification not found\")",
						"content":     map[string]any{"application/json": map[string]any{"schema": updateStateSchema}},
					},
					"401": map[string]any{"description": "Missing X-User-Id"},
					"500": map[string]any{"description": "Internal error"},
				},
			},
		},
	},
}

func newMux(store interface {
	Ping(ctx context.Context) error
	lister
	statusUpdater
}) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthcheck", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := store.Ping(ctx); err != nil {
			http.Error(w, "mongo unreachable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /list", listHandler(store))
	mux.HandleFunc("PUT /update-state", updateStateHandler(store))
	mux.HandleFunc("GET /openapi.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(openAPI)
	})
	return mux
}

func main() {
	store, err := newStore(env("MONGO_URI", "mongodb://notifications-db:27017"), "notifications")
	if err != nil {
		log.Fatal(err)
	}
	retention, err := retentionFromEnv(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	partitions, err := partitionsFromEnv(os.Getenv, "NOTIFICATIONS_PARTITIONS")
	if err != nil {
		log.Fatal(err)
	}
	pushPartitions, err := partitionsFromEnv(os.Getenv, "NOTIFICATIONS_PUSH_PARTITIONS")
	if err != nil {
		log.Fatal(err)
	}
	port := env("PORT", "8080")
	host, err := selfHost(port)
	if err != nil {
		log.Fatal(err)
	}

	ctx := context.Background()
	// Everything below runs in the background: the server boots even if Mongo, Kafka or the discoverer are late.
	go Register(ctx, env("SERVICE_DISCOVERER_URL", "http://service-discoverer:8080"), host)
	go func() {
		if !retry(ctx, "ensure mongo schema", func(ctx context.Context) error { return store.EnsureSchema(ctx, retention) }) {
			return
		}
		c := NewConsumer(env("KAFKA_BROKERS", "kafka:9092"), env("NOTIFICATIONS_TOPIC", "notifications"), partitions,
			env("NOTIFICATIONS_PUSH_TOPIC", "notifications-push"), pushPartitions, store)
		log.Fatal(c.Run(ctx))
	}()

	log.Printf("notifications listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, newMux(store)))
}
