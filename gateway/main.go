package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"microservices/discovery"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// newMux wires the admin API, the healthcheck, the websocket entry point and the middleware pipeline (everything
// else), all wrapped in CORS so that error responses and preflights are covered too. /ws is not a proxied kind, so
// it skips the endpoint pipeline and is logged here.
func newMux(store Store, eps *Endpoints, hub *Hub, verifier *Verifier, pipeline http.Handler) http.Handler {
	a := &admin{store: store, eps: eps}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /admin/endpoints", a.list)
	mux.HandleFunc("PUT /admin/endpoints", a.put)
	mux.HandleFunc("GET /healthcheck", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.Handle("GET /ws", Chain(WebSocket(hub, verifier), Logging()))
	mux.Handle("/", pipeline)
	return Chain(mux, Cors())
}

func main() {
	defaultMax, err := strconv.Atoi(env("DEFAULT_MAX_PER_MIN", "60"))
	if err != nil || defaultMax < 0 {
		log.Fatal("DEFAULT_MAX_PER_MIN must be an integer >= 0")
	}
	pushParts, err := strconv.Atoi(env("NOTIFICATIONS_PUSH_PARTITIONS", "6"))
	if err != nil || pushParts < 1 {
		log.Fatal("NOTIFICATIONS_PUSH_PARTITIONS must be an integer >= 1")
	}
	proxies, err := ParseTrustedProxies(env("TRUSTED_PROXIES", ""))
	if err != nil {
		log.Fatalf("TRUSTED_PROXIES must be a comma-separated list of IPs/CIDRs: %v", err)
	}
	jwksEvery, err := time.ParseDuration(env("JWKS_REFRESH_EVERY", "10m"))
	if err != nil || jwksEvery <= 0 {
		log.Fatal("JWKS_REFRESH_EVERY must be a positive Go duration, e.g. 10m")
	}
	jwksCooldown, err := time.ParseDuration(env("JWKS_REFETCH_COOLDOWN", "30s"))
	if err != nil || jwksCooldown < 0 {
		log.Fatal("JWKS_REFETCH_COOLDOWN must be a non-negative Go duration, e.g. 30s")
	}
	// The discovery lib reads this variable for its host cache; validate it here to fail fast.
	if _, err := discovery.ParseCacheTTL(env("DISCOVERY_CACHE_TTL_SECONDS", "10")); err != nil {
		log.Fatal(err)
	}
	store, err := newMongoStore(env("MONGO_URI", "mongodb://gateway-db:27017"))
	if err != nil {
		log.Fatal(err)
	}
	disc := NewDiscovery()
	eps := NewEndpoints(store)
	limiter := NewLimiter(time.Now)
	jwksFetch := NewDiscoveryJWKS()
	if u := env("USERS_JWKS_URL", ""); u != "" {
		jwksFetch = NewURLJWKS(u, &http.Client{Timeout: 10 * time.Second})
	}
	keys := NewKeyCache(jwksFetch, jwksCooldown, time.Now)
	verifier := NewVerifier(keys, env("JWT_ISSUER", "eventhub-users"))

	ctx := context.Background()
	go eps.Run(ctx)
	go limiter.Run(ctx.Done())
	go NewSyncer(store, eps, defaultMax).Run(ctx) // never blocks the server start

	go keys.Run(ctx, jwksEvery) // never blocks the server start; the keys are also fetched lazily

	hub := NewHub()
	push := NewPushConsumer(env("KAFKA_BROKERS", "kafka:9092"), env("NOTIFICATIONS_PUSH_TOPIC", "notifications-push"), pushParts, hub)
	go push.Run(ctx) // never blocks the server start

	mux := newMux(store, eps, hub, verifier, NewPipeline(eps, verifier, limiter, proxies, NewProxy(disc)))
	port := env("PORT", "8080")
	log.Printf("gateway listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
