package main

import (
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

var connectedFrame = []byte(`{"type":"connected"}`)

// wsUserID is the identity of a websocket request: the trimmed X-User-Id header, else the trimmed user_id query
// parameter (browsers cannot set headers on new WebSocket(...)). The header wins when both are present.
func wsUserID(r *http.Request) string {
	if id := strings.TrimSpace(r.Header.Get("X-User-Id")); id != "" {
		return id
	}
	return strings.TrimSpace(r.URL.Query().Get("user_id"))
}

// WebSocket serves GET /ws: it registers the connection in the hub, which forwards the user's pushes to it.
// It is registered directly on the mux, outside the Resolve/Auth/RateLimit endpoint pipeline (it is not a proxied
// kind), so isPublic, requireAuth and rate limiting do not apply; there is no connection rate limit yet.
//
// NOTE: like X-User-Id everywhere else, the identity is NOT verified: whoever connects can claim any user id. The
// user_id query fallback is a placeholder until real authentication exists; nothing in the URL is a secret.
func WebSocket(hub *Hub) http.Handler {
	up := websocket.Upgrader{
		// Any origin is allowed, consistent with the "CORS fully permissive for now" decision (see Cors).
		CheckOrigin: func(*http.Request) bool { return true },
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID := wsUserID(r)
		if userID == "" {
			http.Error(w, "missing X-User-Id header or user_id query parameter", http.StatusUnauthorized)
			return
		}
		ws, err := up.Upgrade(w, r, nil) // replies to the client itself on failure
		if err != nil {
			return
		}
		c := newClient(userID, hub.queueSize)
		c.enqueue(connectedFrame) // first in the queue, so it precedes any push
		hub.Register(c)
		go hub.writeLoop(ws, c)
		hub.readLoop(ws, c)
	})
}

// writeLoop is the only writer of ws: it drains the queue, pings, and sends the close frame when c is closed.
func (h *Hub) writeLoop(ws *websocket.Conn, c *client) {
	ping := time.NewTicker(h.pingEvery)
	defer ping.Stop()
	defer ws.Close()
	for {
		select {
		case msg := <-c.send:
			ws.SetWriteDeadline(time.Now().Add(h.writeWait))
			if err := ws.WriteMessage(websocket.TextMessage, msg); err != nil {
				h.drop(c)
				return
			}
		case <-ping.C:
			ws.SetWriteDeadline(time.Now().Add(h.writeWait))
			if err := ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				h.drop(c)
				return
			}
		case <-c.done:
			if c.code != 0 {
				ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(c.code, c.reason), time.Now().Add(h.writeWait))
			}
			h.Unregister(c)
			return
		}
	}
}

// readLoop discards what the client sends; it only serves the control frames and the read deadline. It returns
// (and cleans up) when the connection fails or closes.
func (h *Hub) readLoop(ws *websocket.Conn, c *client) {
	ws.SetReadLimit(h.readLimit)
	ws.SetReadDeadline(time.Now().Add(h.pongWait))
	ws.SetPongHandler(func(string) error { return ws.SetReadDeadline(time.Now().Add(h.pongWait)) })
	for {
		if _, _, err := ws.ReadMessage(); err != nil {
			break
		}
		ws.SetReadDeadline(time.Now().Add(h.pongWait))
	}
	h.drop(c)
}

// drop unregisters c and stops its writer without a close frame (the connection is already gone or failing).
func (h *Hub) drop(c *client) {
	h.Unregister(c)
	c.close(0, "")
}
