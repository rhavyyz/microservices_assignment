package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	registerMinDelay  = time.Second
	registerMaxDelay  = 30 * time.Second
	kindNotifications = "notifications"
)

// selfHost is the host other services use to reach this instance: SERVICE_HOST, or "<hostname>:<PORT>".
func selfHost(port string) (string, error) {
	if h := os.Getenv("SERVICE_HOST"); h != "" {
		return h, nil
	}
	name, err := os.Hostname()
	if err != nil {
		return "", err
	}
	return name + ":" + port, nil
}

// registerOnce registers this instance with the service-discoverer.
func registerOnce(client *http.Client, baseURL string, payload []byte) error {
	resp, err := client.Post(strings.TrimRight(baseURL, "/")+"/register", "application/json", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	msg, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("register failed: %d %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}

// Register registers with the service-discoverer, retrying with backoff until it succeeds or ctx ends.
// Run it in the background: the service does not depend on it.
func Register(ctx context.Context, baseURL, host string) {
	payload, _ := json.Marshal(map[string]string{"kind": kindNotifications, "host": host})
	client := &http.Client{Timeout: 5 * time.Second}
	delay := registerMinDelay
	for {
		err := registerOnce(client, baseURL, payload)
		if err == nil {
			log.Printf("registered with the service-discoverer as %s", host)
			return
		}
		log.Printf("register: %v (retrying in %s)", err, delay)
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		if delay *= 2; delay > registerMaxDelay {
			delay = registerMaxDelay
		}
	}
}
