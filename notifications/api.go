package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

const (
	defaultListLimit = 20
	maxListLimit     = 100
	maxUpdates       = 100
	maxUpdateBody    = 1 << 20 // 1 MiB
)

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// lister is what the list handler needs from the Store.
type lister interface {
	List(ctx context.Context, userID string, base string, statuses []Status, limit int) ([]Notification, bool, error)
}

// statusUpdater is what the update-state handler needs from the Store.
type statusUpdater interface {
	UpdateStatuses(ctx context.Context, userID string, updates []StatusUpdate) (updated int, notFound []string, err error)
}

// notificationJSON is an item of the list response (no user_id).
type notificationJSON struct {
	ID          string         `json:"id"`
	Message     string         `json:"message"`
	RedirectURL *string        `json:"redirect_url"`
	Payload     map[string]any `json:"payload"`
	PayloadType *string        `json:"payload_type"`
	Status      Status         `json:"status"`
	CreatedAt   string         `json:"created_at"` // RFC3339 with milliseconds, UTC
}

const createdAtFormat = "2006-01-02T15:04:05.000Z07:00"

// parseStatuses reads the repeatable, comma-separated status params into a deduplicated list (nil = all statuses).
func parseStatuses(values []string) ([]Status, bool) {
	var out []Status
	seen := map[Status]bool{}
	for _, v := range values {
		for _, part := range strings.Split(v, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			st := Status(part)
			valid := false
			for _, s := range Statuses {
				valid = valid || s == st
			}
			if !valid {
				return nil, false
			}
			if !seen[st] {
				seen[st] = true
				out = append(out, st)
			}
		}
	}
	return out, true
}

// listHandler serves GET /list. It is read-only: no status is changed.
func listHandler(l lister) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := strings.TrimSpace(r.Header.Get("X-User-Id"))
		if userID == "" {
			http.Error(w, "missing X-User-Id header", http.StatusUnauthorized)
			return
		}
		q := r.URL.Query()
		base := strings.TrimSpace(q.Get("base_notification_id"))
		if base != "" && !uuidRe.MatchString(base) {
			http.Error(w, "base_notification_id must be a UUID", http.StatusBadRequest)
			return
		}
		statuses, ok := parseStatuses(q["status"])
		if !ok {
			http.Error(w, "status must be one of DEFAULT, RECEIVED, SEEN", http.StatusBadRequest)
			return
		}
		limit := defaultListLimit
		if v := q.Get("limit"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 || n > maxListLimit {
				http.Error(w, "limit must be an integer between 1 and 100", http.StatusBadRequest)
				return
			}
			limit = n
		}

		items, hasMore, err := l.List(r.Context(), userID, base, statuses, limit)
		if errors.Is(err, ErrBaseNotFound) {
			http.Error(w, "base notification not found", http.StatusNotFound)
			return
		}
		if err != nil {
			log.Printf("list notifications: %v", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		resp := struct {
			Notifications []notificationJSON `json:"notifications"`
			Next          *string            `json:"next_base_notification_id"`
		}{Notifications: make([]notificationJSON, len(items))}
		for i, n := range items {
			resp.Notifications[i] = notificationJSON{
				ID: n.ID, Message: n.Message, RedirectURL: n.RedirectURL, Payload: n.Payload,
				PayloadType: n.PayloadType, Status: n.Status, CreatedAt: n.CreatedAt.UTC().Format(createdAtFormat),
			}
		}
		if hasMore && len(items) > 0 {
			resp.Next = &items[len(items)-1].ID
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}

// updateItem is an item of the update-state request body.
type updateItem struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

func validStatus(st Status) bool {
	for _, s := range Statuses {
		if s == st {
			return true
		}
	}
	return false
}

// validateUpdates checks the format of every item and returns the error per (trimmed) id plus the updates that
// have none, in request order. Per id the first problem wins: invalid id, invalid status, duplicate id.
func validateUpdates(items []updateItem) (map[string]string, []StatusUpdate) {
	count := map[string]int{}
	for _, it := range items {
		count[strings.TrimSpace(it.ID)]++
	}
	errs := map[string]string{}
	for _, it := range items {
		id := strings.TrimSpace(it.ID)
		switch {
		case !uuidRe.MatchString(id):
			errs[id] = "invalid id"
		case errs[id] == "" && !validStatus(Status(it.Status)):
			errs[id] = "invalid status"
		}
	}
	var ok []StatusUpdate
	for _, it := range items {
		id := strings.TrimSpace(it.ID)
		if errs[id] == "" && count[id] > 1 {
			errs[id] = "duplicate id"
		}
		if errs[id] == "" {
			ok = append(ok, StatusUpdate{ID: id, Status: Status(it.Status)})
		}
	}
	return errs, ok
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// updateStateResponse is the body of every JSON answer of update-state.
type updateStateResponse struct {
	Updated int               `json:"updated"`
	Errors  map[string]string `json:"errors"`
}

// updateStateHandler serves PUT /update-state: a batch of status changes on the user's own notifications, applied
// partially. The items with a format error are skipped, the store is asked to apply the well-formed ones and reports
// the ids that are not the user's (also skipped); the answer lists what was updated and why each other id was not.
// It is 200 when something was updated, 400 when nothing was and there are errors.
//
// Mongo is standalone (no transactions), so a notification can expire through the TTL index between the store's
// existence check and its write: then updated is lower than the number of owned items and that id is not reported.
func updateStateHandler(u statusUpdater) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := strings.TrimSpace(r.Header.Get("X-User-Id"))
		if userID == "" {
			http.Error(w, "missing X-User-Id header", http.StatusUnauthorized)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxUpdateBody))
		if err != nil {
			http.Error(w, "request body too large or unreadable", http.StatusBadRequest)
			return
		}
		var items []updateItem
		if err := json.Unmarshal(body, &items); err != nil {
			http.Error(w, "body must be a JSON array of {\"id\", \"status\"}", http.StatusBadRequest)
			return
		}
		if len(items) == 0 {
			http.Error(w, "at least one update is required", http.StatusBadRequest)
			return
		}
		if len(items) > maxUpdates {
			http.Error(w, "at most 100 updates per request", http.StatusBadRequest)
			return
		}

		errs, updates := validateUpdates(items)

		updated := 0
		if len(updates) > 0 {
			var notFound []string
			updated, notFound, err = u.UpdateStatuses(r.Context(), userID, updates)
			if err != nil {
				log.Printf("update notification statuses: %v", err)
				http.Error(w, "internal error", http.StatusInternalServerError)
				return
			}
			for _, id := range notFound {
				errs[id] = "notification not found"
			}
		}
		code := http.StatusOK
		if updated == 0 && len(errs) > 0 {
			code = http.StatusBadRequest
		}
		writeJSON(w, code, updateStateResponse{Updated: updated, Errors: errs})
	}
}
