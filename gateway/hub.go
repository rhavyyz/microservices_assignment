package main

import (
	"sync"
	"time"
)

const (
	hubQueueSize = 32 // pending frames per connection before it is dropped as too slow
	wsWriteWait  = 10 * time.Second
	wsPingEvery  = 30 * time.Second
	wsPongWait   = 70 * time.Second // read deadline, extended by every pong (and any other read)
	wsReadLimit  = 4 << 10

	closeReplaced  = 4000 // application close code: the user connected again, this connection is superseded
	closeSlow      = 4001 // application close code: the send queue overflowed
	reasonReplaced = "replaced by a newer connection"
	reasonSlow     = "send queue full"
)

// client is one registered websocket connection: a bounded queue of frames drained by a single writer goroutine.
// close is idempotent and the first call wins; code/reason are the close frame the writer sends (code 0 = none).
type client struct {
	userID string
	send   chan []byte
	done   chan struct{}
	once   sync.Once
	code   int
	reason string
}

func newClient(userID string, queue int) *client {
	return &client{userID: userID, send: make(chan []byte, queue), done: make(chan struct{})}
}

func (c *client) close(code int, reason string) {
	c.once.Do(func() {
		c.code, c.reason = code, reason
		close(c.done)
	})
}

// enqueue adds a frame without blocking; false means the queue is full.
func (c *client) enqueue(msg []byte) bool {
	select {
	case c.send <- msg:
		return true
	default:
		return false
	}
}

// Hub is the registry of the websocket connections of this gateway instance: at most one per user, the newest wins.
// The timing fields are the defaults above; tests override them.
type Hub struct {
	mu      sync.RWMutex
	clients map[string]*client

	queueSize int
	writeWait time.Duration
	pingEvery time.Duration
	pongWait  time.Duration
	readLimit int64
}

func NewHub() *Hub {
	return &Hub{
		clients:   make(map[string]*client),
		queueSize: hubQueueSize,
		writeWait: wsWriteWait,
		pingEvery: wsPingEvery,
		pongWait:  wsPongWait,
		readLimit: wsReadLimit,
	}
}

// Register makes c the connection of its user and closes the one it replaces, if any.
func (h *Hub) Register(c *client) {
	h.mu.Lock()
	old := h.clients[c.userID]
	h.clients[c.userID] = c
	h.mu.Unlock()
	if old != nil {
		old.close(closeReplaced, reasonReplaced)
	}
}

// Unregister removes c only if it is still the registered connection of its user: a connection that was replaced
// must not remove its successor.
func (h *Hub) Unregister(c *client) {
	h.mu.Lock()
	if h.clients[c.userID] == c {
		delete(h.clients, c.userID)
	}
	h.mu.Unlock()
}

// Send queues a frame for the user's connection. It never blocks: no connection here means the frame is dropped
// (best-effort, the client recovers through /notifications/list), and a connection whose queue is full is dropped
// instead of holding up the caller. It reports whether the frame was queued.
func (h *Hub) Send(userID string, msg []byte) bool {
	h.mu.RLock()
	c := h.clients[userID]
	h.mu.RUnlock()
	if c == nil {
		return false
	}
	if c.enqueue(msg) {
		return true
	}
	h.Unregister(c)
	c.close(closeSlow, reasonSlow)
	return false
}
