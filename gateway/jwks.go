package main

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"sync"
	"time"
)

var (
	ErrUnknownKid      = errors.New("unknown key id")
	ErrKeysUnavailable = errors.New("signing keys unavailable")
)

const maxJWKSBody = 1 << 20

// jwksFetcher returns the raw JWKS document from the trusted source.
type jwksFetcher func(ctx context.Context) ([]byte, error)

// KeyCache holds the RSA public keys (kid -> key) of the Users service, taken only from its JWKS endpoint.
// Keys are fetched lazily, refreshed periodically (Run) and refetched when a token carries an unknown kid,
// at most once per cooldown. Concurrent lookups share one fetch.
type KeyCache struct {
	fetch    jwksFetcher
	now      func() time.Time
	cooldown time.Duration

	mu   sync.RWMutex
	keys map[string]*rsa.PublicKey

	fetchMu sync.Mutex // serializes fetches; guards last
	last    time.Time  // end of the last fetch attempt, successful or not
}

func NewKeyCache(fetch jwksFetcher, cooldown time.Duration, now func() time.Time) *KeyCache {
	return &KeyCache{fetch: fetch, now: now, cooldown: cooldown, keys: map[string]*rsa.PublicKey{}}
}

// NewDiscoveryJWKS fetches the JWKS from a healthy Users instance obtained from the discoverer
// (it is not routed through the gateway), through the discovery lib, which caches the host and
// rediscovers it once when the connection fails.
func NewDiscoveryJWKS() jwksFetcher {
	return func(ctx context.Context) ([]byte, error) {
		resp, err := request(ctx, http.MethodGet, User, "/.well-known/jwks.json")
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		return readJWKS(resp)
	}
}

// NewURLJWKS fetches the JWKS from a fixed URL (USERS_JWKS_URL).
func NewURLJWKS(u string, client *http.Client) jwksFetcher {
	return func(ctx context.Context) ([]byte, error) { return getJWKS(ctx, client, u) }
}

func getJWKS(ctx context.Context, client *http.Client, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return readJWKS(resp)
}

func readJWKS(resp *http.Response) ([]byte, error) {
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jwks: unexpected status %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, maxJWKSBody))
}

type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// parseJWKS keeps only usable RSA signing keys that have a kid. It fails when none is usable.
func parseJWKS(data []byte) (map[string]*rsa.PublicKey, error) {
	var doc struct {
		Keys []jwk `json:"keys"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("jwks: %w", err)
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range doc.Keys {
		if k.Kty != "RSA" || k.Kid == "" || (k.Use != "" && k.Use != "sig") || (k.Alg != "" && k.Alg != "RS256") {
			continue
		}
		n, err1 := base64.RawURLEncoding.DecodeString(k.N)
		e, err2 := base64.RawURLEncoding.DecodeString(k.E)
		if err1 != nil || err2 != nil || len(n) == 0 || len(e) == 0 || len(e) > 4 {
			continue
		}
		exp := new(big.Int).SetBytes(e)
		if !exp.IsInt64() || exp.Int64() < 3 {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(exp.Int64())}
	}
	if len(keys) == 0 {
		return nil, errors.New("jwks: no usable RSA keys")
	}
	return keys, nil
}

func (c *KeyCache) lookup(kid string) (*rsa.PublicKey, bool, int) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	k, ok := c.keys[kid]
	return k, ok, len(c.keys)
}

// fetchLocked fetches and, on success, replaces the key set. On failure the old keys stay. Needs fetchMu.
func (c *KeyCache) fetchLocked(ctx context.Context) error {
	data, err := c.fetch(ctx)
	if err == nil {
		var keys map[string]*rsa.PublicKey
		if keys, err = parseJWKS(data); err == nil {
			c.mu.Lock()
			c.keys = keys
			c.mu.Unlock()
		}
	}
	c.last = c.now()
	return err
}

// Refresh fetches the JWKS now, regardless of the cooldown.
func (c *KeyCache) Refresh(ctx context.Context) error {
	c.fetchMu.Lock()
	defer c.fetchMu.Unlock()
	return c.fetchLocked(ctx)
}

// Key returns the key for kid. A miss triggers one shared refetch, unless one ran within the cooldown.
// ErrKeysUnavailable means there is no key at all to verify with; ErrUnknownKid means the kid is not trusted.
func (c *KeyCache) Key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	if k, ok, _ := c.lookup(kid); ok {
		return k, nil
	}
	c.fetchMu.Lock()
	defer c.fetchMu.Unlock()
	// Someone may have fetched while we waited for the lock.
	if k, ok, _ := c.lookup(kid); ok {
		return k, nil
	}
	if c.last.IsZero() || c.now().Sub(c.last) >= c.cooldown {
		if err := c.fetchLocked(ctx); err != nil {
			log.Printf("jwks fetch failed: %v", err)
		}
		if k, ok, _ := c.lookup(kid); ok {
			return k, nil
		}
	}
	if _, _, n := c.lookup(kid); n == 0 {
		return nil, ErrKeysUnavailable
	}
	return nil, ErrUnknownKid
}

// Run refreshes the keys every interval until ctx is done. It tries once right away; failures are only logged.
func (c *KeyCache) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := c.Refresh(ctx); err != nil {
			log.Printf("jwks refresh failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
