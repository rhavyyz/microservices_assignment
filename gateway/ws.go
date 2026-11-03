package main

import (
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

var connectedFrame = []byte(`{"type":"connected"}`)

// wsToken is the JWT of a websocket request: the Authorization bearer header, else the access_token query
// parameter (browsers cannot set headers on new WebSocket(...)). The header wins when both are present.
func wsToken(r *http.Request) (string, bool) {
	if tok, ok := bearer(r); ok {
		return tok, true
	}
	tok := strings.TrimSpace(r.URL.Query().Get("access_token"))
	return tok, tok != ""
}

// WebSocket serves GET /ws: it verifies the JWT (same rules as Auth), registers the connection in the hub under
// the verified sub, and the hub forwards that user's pushes to it.
// It is registered directly on the mux, outside the Resolve/Auth/RateLimit endpoint pipeline (it is not a proxied
// kind), so isPublic, requireAuth and rate limiting do not apply; there is no connection rate limit yet.
//
// Authentication happens before the upgrade, so failures are plain HTTP: 401 for a missing or invalid token, 503
// when no signing key is available. Client-sent X-User-Id / X-User-Roles are dropped; the identity is only ever the
// verified sub. The token in the query string can end up in proxy/access logs elsewhere (Logging only logs the
// path), so TLS and a short token lifetime matter.
func WebSocket(hub *Hub, v *Verifier) http.Handler {
	up := websocket.Upgrader{
		// Any origin is allowed, consistent with the "CORS fully permissive for now" decision (see Cors).
		CheckOrigin: func(*http.Request) bool { return true },
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Del("X-User-Id")
		r.Header.Del("X-User-Roles")
		tok, ok := wsToken(r)
		if !ok {
			unauthorized(w)
			return
		}
		id, err := v.Verify(r.Context(), tok)
		if err != nil {
			authFailed(w, err)
			return
		}
		r.Header.Set("X-User-Id", id.Sub) // for Logging
		if len(id.Roles) > 0 {
			r.Header.Set("X-User-Roles", strings.Join(id.Roles, ","))
		}
		ws, err := up.Upgrade(w, r, nil) // replies to the client itself on failure
		if err != nil {
			return
		}
		// The connection is verified only here: an open connection outlives the token's exp.
		c := newClient(id.Sub, hub.queueSize)
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
