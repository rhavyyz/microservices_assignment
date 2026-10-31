package main

import (
	"context"
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

// newMux wires the admin API, the healthcheck and the middleware pipeline (everything else),
// all wrapped in CORS so that error responses and preflights are covered too.
func newMux(store Store, eps *Endpoints, pipeline http.Handler) http.Handler {
	a := &admin{store: store, eps: eps}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /admin/endpoints", a.list)
	mux.HandleFunc("PUT /admin/endpoints", a.put)
	mux.HandleFunc("GET /healthcheck", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.Handle("/", pipeline)
	return Chain(mux, Cors())
}

func main() {
	defaultMax, err := strconv.Atoi(env("DEFAULT_MAX_PER_MIN", "60"))
	if err != nil || defaultMax < 0 {
		log.Fatal("DEFAULT_MAX_PER_MIN must be an integer >= 0")
	}
	store, err := newMongoStore(env("MONGO_URI", "mongodb://gateway-db:27017"))
	if err != nil {
		log.Fatal(err)
	}
	disc := NewDiscovery(env("SERVICE_DISCOVERER_URL", "http://service-discoverer:8080"))
	eps := NewEndpoints(store)
	limiter := NewLimiter(time.Now)

	ctx := context.Background()
	go eps.Run(ctx)
	go limiter.Run(ctx.Done())
	go NewSyncer(disc, store, eps, defaultMax).Run(ctx) // never blocks the server start

	mux := newMux(store, eps, NewPipeline(eps, limiter, NewProxy(disc)))
	port := env("PORT", "8080")
	log.Printf("gateway listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
