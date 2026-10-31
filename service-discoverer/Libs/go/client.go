package discovery

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	registerAttempts     = 10
	registerInitialDelay = time.Second
	registerMaxDelay     = 30 * time.Second
)

// sleep is time.Sleep, replaced in tests.
var sleep = time.Sleep

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
func Consult(kind Kind) (string, error) {
	resp, err := client.Get(discovererURL() + "/consult?kind=" + url.QueryEscape(string(kind)))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("consult %s failed: %d %s", kind, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out struct {
		Host string `json:"host"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.Host == "" {
		return "", fmt.Errorf("bad consult response: %s", raw)
	}
	return out.Host, nil
}

// resolve returns the cached host, calling Consult when there is none or when
// the cached one is `stale`.
func resolve(kind Kind, stale string) (string, error) {
	c, ok := caches[kind]
	if !ok {
		return "", fmt.Errorf("unknown service kind %q", kind)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.host != "" && c.host != stale {
		return c.host, nil
	}
	host, err := Consult(kind)
	if err != nil {
		return "", err
	}
	c.host = host
	return c.host, nil
}

// Request calls `path` (like "/charge") on an instance of `kind`. If the cached
// host is unreachable, the host is rediscovered and the call retried once.
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
