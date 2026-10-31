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
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}

// put updates maxPerMin of a registered endpoint. maxPerMin = 0 blocks every request to it.
func (a *admin) put(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Kind      Kind   `json:"kind"`
		Method    string `json:"method"`
		Path      string `json:"path"`
		MaxPerMin *int   `json:"maxPerMin"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !body.Kind.valid() || body.Method == "" ||
		!strings.HasPrefix(body.Path, "/") || body.MaxPerMin == nil || *body.MaxPerMin < 0 {
		http.Error(w, "body must be {\"kind\": string, \"method\": string, \"path\": string, \"maxPerMin\": int >= 0}", http.StatusBadRequest)
		return
	}
	e, ok, err := a.store.SetMax(r.Context(), Endpoint{Kind: body.Kind, Method: strings.ToUpper(body.Method), Path: body.Path, MaxPerMin: *body.MaxPerMin})
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
	json.NewEncoder(w).Encode(e)
}
