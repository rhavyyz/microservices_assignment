package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

// Admin API. NOTE: no authentication for now; do not expose /admin publicly as-is.
type admin struct {
	store Store
	eps   *Endpoints
}

func (a *admin) list(w http.ResponseWriter, r *http.Request) {
	list, err := a.store.List(r.Context(), Kind(r.URL.Query().Get("kind")))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []Endpoint{}
	}
	for i := range list {
		list[i] = list[i].withDefaults()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}

// put partially updates a registered endpoint: only the provided fields change, at least one is required.
// maxPerMin = 0 blocks every request to it.
func (a *admin) put(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Kind        Kind         `json:"kind"`
		Method      string       `json:"method"`
		Path        string       `json:"path"`
		MaxPerMin   *int         `json:"maxPerMin"`
		RateLimitBy *RateLimitBy `json:"rateLimitBy"`
		RequireAuth *bool        `json:"requireAuth"`
		IsPublic    *bool        `json:"isPublic"`
	}
	patch := EndpointPatch{}
	if err := json.NewDecoder(r.Body).Decode(&body); err == nil {
		patch = EndpointPatch{MaxPerMin: body.MaxPerMin, RateLimitBy: body.RateLimitBy, RequireAuth: body.RequireAuth, IsPublic: body.IsPublic}
	}
	if !body.Kind.valid() || body.Method == "" || !strings.HasPrefix(body.Path, "/") || patch.empty() ||
		(patch.MaxPerMin != nil && *patch.MaxPerMin < 0) || (patch.RateLimitBy != nil && !patch.RateLimitBy.valid()) {
		http.Error(w, "body must be {\"kind\", \"method\", \"path\"} plus at least one of \"maxPerMin\" (int >= 0), "+
			"\"rateLimitBy\" (user_or_ip|ip|global), \"requireAuth\" (bool), \"isPublic\" (bool)", http.StatusBadRequest)
		return
	}
	e, ok, err := a.store.Update(r.Context(), Endpoint{Kind: body.Kind, Method: strings.ToUpper(body.Method), Path: body.Path}, patch)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "endpoint not registered", http.StatusNotFound)
		return
	}
	if err := a.eps.Refresh(r.Context()); err != nil {
		log.Printf("cache refresh after PUT failed: %v", err)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(e.withDefaults())
}
