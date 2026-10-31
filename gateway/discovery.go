package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"
)

var (
	ErrUnknownKind = errors.New("unknown service kind")
	ErrNoInstance  = errors.New("no healthy instance available")
)

// Discovery is a small client for the service-discoverer, caching one host per kind.
type Discovery struct {
	url    string
	client *http.Client
	mu     sync.Mutex
	hosts  map[Kind]string
}

func NewDiscovery(baseURL string) *Discovery {
	return &Discovery{url: baseURL, client: &http.Client{Timeout: 15 * time.Second}, hosts: map[Kind]string{}}
}

// Consult asks the discoverer for a healthy host every time, without touching the cache.
func (d *Discovery) Consult(ctx context.Context, kind Kind) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.url+"/consult?kind="+url.QueryEscape(string(kind)), nil)
	if err != nil {
		return "", err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		var body struct {
			Host string `json:"host"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.Host == "" {
			return "", fmt.Errorf("bad consult response for %s", kind)
		}
		return body.Host, nil
	case http.StatusServiceUnavailable:
		return "", ErrNoInstance
	case http.StatusBadRequest:
		return "", ErrUnknownKind
	}
	return "", fmt.Errorf("consult %s: unexpected status %d", kind, resp.StatusCode)
}

// Host returns the cached host of the kind, consulting the discoverer on a miss.
func (d *Discovery) Host(ctx context.Context, kind Kind) (string, error) {
	d.mu.Lock()
	h, ok := d.hosts[kind]
	d.mu.Unlock()
	if ok {
		return h, nil
	}
	h, err := d.Consult(ctx, kind)
	if err != nil {
		return "", err
	}
	d.mu.Lock()
	d.hosts[kind] = h
	d.mu.Unlock()
	return h, nil
}

// Forget drops the cached host of the kind, but only if it is still the given (failed) one.
func (d *Discovery) Forget(kind Kind, host string) {
	d.mu.Lock()
	if d.hosts[kind] == host {
		delete(d.hosts, kind)
	}
	d.mu.Unlock()
}
