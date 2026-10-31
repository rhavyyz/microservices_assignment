package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"
)

type server struct{ reg *Registry }

func (s *server) register(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Kind Kind   `json:"kind"`
		Host string `json:"host"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Host == "" {
		http.Error(w, "body must be {\"kind\": string, \"host\": string}", http.StatusBadRequest)
		return
	}
	if err := s.reg.Register(body.Kind, body.Host); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) consult(w http.ResponseWriter, r *http.Request) {
	host, err := s.reg.Consult(r.Context(), Kind(r.URL.Query().Get("kind")))
	switch {
	case errors.Is(err, ErrUnknownKind):
		http.Error(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, ErrNoInstance):
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
	case err != nil:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	default:
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"host": host})
	}
}

// configFromEnv reads RECHECK_INTERVAL and RECHECK_MAX_FAILURES, falling back to defaults.
func configFromEnv(getenv func(string) string) (Config, error) {
	cfg := Config{defaultRecheckInterval, defaultRecheckMaxFailures}
	if v := getenv("RECHECK_INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return cfg, fmt.Errorf("RECHECK_INTERVAL must be a positive duration like 5s, got %q", v)
		}
		cfg.RecheckInterval = d
	}
	if v := getenv("RECHECK_MAX_FAILURES"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return cfg, fmt.Errorf("RECHECK_MAX_FAILURES must be an integer >= 1, got %q", v)
		}
		cfg.RecheckMaxFailures = n
	}
	return cfg, nil
}

func main() {
	cfg, err := configFromEnv(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	reg := NewRegistryWithConfig(cfg)
	go reg.Run(context.Background())
	s := &server{reg: reg}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /register", s.register)
	mux.HandleFunc("GET /consult", s.consult)
	mux.HandleFunc("GET /healthcheck", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("service-discoverer listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
