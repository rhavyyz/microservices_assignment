package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
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

func main() {
	s := &server{reg: NewRegistry()}
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
