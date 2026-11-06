package discovery

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	registerAttempts     = 10
	registerInitialDelay = time.Second
	registerMaxDelay     = 30 * time.Second
)

var (
	// ErrNoInstance is wrapped by the error of Consult (and Request) when the discoverer has no healthy instance of the kind (503).
	ErrNoInstance = errors.New("no healthy instance available")
	// ErrUnknownKind is wrapped by the error of Consult (and Request) when the discoverer does not know the kind (400).
	ErrUnknownKind = errors.New("unknown service kind")
)

// sleep is time.Sleep, replaced in tests.
var sleep = time.Sleep

// now is time.Now, replaced in tests.
var now = time.Now

const (
	// DefaultCacheTTL is how long a consulted host is reused when DISCOVERY_CACHE_TTL_SECONDS is unset or invalid.
	DefaultCacheTTL = 10 * time.Second
	maxCacheTTL     = 86400 * time.Second
)

// ParseCacheTTL parses a DISCOVERY_CACHE_TTL_SECONDS value: a number of seconds (decimals accepted),
// 0 meaning no caching. Negative, non-numeric, NaN, infinite and absurd (> 86400) values are errors.
func ParseCacheTTL(s string) (time.Duration, error) {
	secs, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || math.IsNaN(secs) || math.IsInf(secs, 0) || secs < 0 || secs > maxCacheTTL.Seconds() {
		return 0, fmt.Errorf("DISCOVERY_CACHE_TTL_SECONDS must be a number of seconds between 0 and 86400, got %q", s)
	}
	return time.Duration(secs * float64(time.Second)), nil
}

// cacheTTL reads DISCOVERY_CACHE_TTL_SECONDS (default 10, invalid falls back to the default).
func cacheTTL() time.Duration {
	v := os.Getenv("DISCOVERY_CACHE_TTL_SECONDS")
	if v == "" {
		return DefaultCacheTTL
	}
	ttl, err := ParseCacheTTL(v)
	if err != nil {
		return DefaultCacheTTL
	}
	return ttl
}

var client = &http.Client{Timeout: 5 * time.Second}

// Options holds the optional headers and JSON body of a Request.
type Options struct {
	Headers map[string]string
	Body    any // marshalled to JSON when not nil
}

func discovererURL() string {
	if u := os.Getenv("SERVICE_DISCOVERER_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	return "http://service-discoverer:8080"
}

// Register registers this instance with the service-discoverer. Call it once
// at startup, passing only the instance's own kind. The host sent is
// SERVICE_HOST, or "<hostname>:<PORT or 8080>". It retries up to 10 times with
// a delay doubling from 1s up to 30s (about 2.5 minutes in all), so it blocks
// meanwhile: call it from a goroutine if the service must not wait.
func Register(kind Kind) error {
	host := os.Getenv("SERVICE_HOST")
	if host == "" {
		name, err := os.Hostname()
		if err != nil {
			return err
		}
		port := os.Getenv("PORT")
		if port == "" {
			port = "8080"
		}
		host = name + ":" + port
	}
	payload, _ := json.Marshal(map[string]string{"kind": string(kind), "host": host})

	var last error
	delay := registerInitialDelay
	for i := 0; i < registerAttempts; i++ {
		if i > 0 {
			sleep(delay)
			delay = min(delay*2, registerMaxDelay)
		}
		resp, err := client.Post(discovererURL()+"/register", "application/json", bytes.NewReader(payload))
		if err != nil {
			last = err
			continue
		}
		msg, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return nil
		}
		last = fmt.Errorf("register failed: %d %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return fmt.Errorf("could not register with the service-discoverer: %w", last)
}

type kindCache struct {
	mu   sync.Mutex
	host string
	at   time.Time // when host was consulted
}

// One cache per kind for this process. The kinds are fixed, so the map never changes.
var caches = func() map[Kind]*kindCache {
	m := make(map[Kind]*kindCache, len(allKinds))
	for _, k := range allKinds {
		m[k] = &kindCache{}
	}
	return m
}()

// Consult asks the service-discoverer for a healthy host of `kind`. No caching.
// The discoverer balances round robin, so consecutive calls may return different instances.
// A 503 answer wraps ErrNoInstance and a 400 one wraps ErrUnknownKind (use errors.Is).
func Consult(kind Kind) (string, error) {
	resp, err := client.Get(discovererURL() + "/consult?kind=" + url.QueryEscape(string(kind)))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		err := fmt.Errorf("consult %s failed: %d %s", kind, resp.StatusCode, strings.TrimSpace(string(raw)))
		switch resp.StatusCode {
		case http.StatusServiceUnavailable:
			err = fmt.Errorf("%w (%w)", err, ErrNoInstance)
		case http.StatusBadRequest:
			err = fmt.Errorf("%w (%w)", err, ErrUnknownKind)
		}
		return "", err
	}
	var out struct {
		Host string `json:"host"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.Host == "" {
		return "", fmt.Errorf("bad consult response: %s", raw)
	}
	return out.Host, nil
}

// Reset forgets every cached host, so the next Request consults the discoverer again. Meant for tests.
func Reset() {
	for _, c := range caches {
		c.mu.Lock()
		c.host = ""
		c.at = time.Time{}
		c.mu.Unlock()
	}
}

// resolve returns the cached host while it is younger than the cache TTL (DISCOVERY_CACHE_TTL_SECONDS),
// calling Consult when there is none, when it expired, or when the cached one is `stale` (unreachable).
func resolve(kind Kind, stale string) (string, error) {
	c, ok := caches[kind]
	if !ok {
		return "", fmt.Errorf("unknown service kind %q", kind)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	ttl := cacheTTL()
	if c.host != "" && c.host != stale && ttl > 0 && now().Sub(c.at) < ttl {
		return c.host, nil
	}
	consultedAt := now()
	host, err := Consult(kind)
	if err != nil {
		// The refresh of an expired entry failed (discoverer down): keep using the previous host rather
		// than failing. Never the `stale` one, which is known to be unreachable.
		if c.host != "" && c.host != stale {
			return c.host, nil
		}
		return "", err
	}
	c.host, c.at = host, consultedAt
	return c.host, nil
}

// Request calls `path` (like "/charge") on an instance of `kind`. The host is cached per kind for
// DISCOVERY_CACHE_TTL_SECONDS (default 10, 0 = consult every time), so calls spread over the instances
// as the discoverer rotates them. If the host is unreachable, the host is rediscovered and the call retried once.
// HTTP error statuses are returned as responses, not errors. The caller closes
// the response body.
func Request(method string, kind Kind, path string, opts Options) (*http.Response, error) {
	var body []byte
	if opts.Body != nil {
		var err error
		if body, err = json.Marshal(opts.Body); err != nil {
			return nil, err
		}
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	do := func(host string) (*http.Response, error) {
		req, err := http.NewRequest(strings.ToUpper(method), "http://"+host+path, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		for k, v := range opts.Headers {
			req.Header.Set(k, v)
		}
		if body != nil && req.Header.Get("Content-Type") == "" {
			req.Header.Set("Content-Type", "application/json")
		}
		return client.Do(req)
	}

	host, err := resolve(kind, "")
	if err != nil {
		return nil, err
	}
	resp, err := do(host)
	if err == nil {
		return resp, nil
	}
	// Transport error (refused, timeout, DNS): the instance is unreachable.
	if host, err = resolve(kind, host); err != nil {
		return nil, err
	}
	return do(host)
}
