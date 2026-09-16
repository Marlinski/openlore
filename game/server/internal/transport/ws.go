package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"

	"nhooyr.io/websocket"
)

const (
	// pingInterval is how often we probe an idle connection.
	pingInterval = 20 * time.Second
	// pingTimeout is how long a peer has to answer before we treat the
	// connection as gone.
	pingTimeout = 10 * time.Second
)

// Transport is the per-connection send/receive abstraction.
// The World actor interacts with connections exclusively through this interface.
type Transport interface {
	// SessionID returns a unique identifier for this connection.
	SessionID() string
	// Send serialises msg as JSON and writes it to the client.
	Send(msg any) error
	// Done is closed when the underlying connection is gone.
	Done() <-chan struct{}
}

// Envelope carries a message from a WebSocket connection into the World
// goroutine. A nil Raw + nil Transport signals a disconnect.
type Envelope struct {
	ConnID    string    // unique per WS connection
	Transport Transport // nil on disconnect
	Raw       []byte    // nil on disconnect
}

// sessionCounter generates monotonically increasing session IDs.
var sessionCounter atomic.Uint64

// WebSocketTransport wraps a nhooyr.io/websocket connection.
type WebSocketTransport struct {
	id   string
	conn *websocket.Conn
	done chan struct{}
}

func NewWebSocketTransport(conn *websocket.Conn) *WebSocketTransport {
	id := fmt.Sprintf("s%d", sessionCounter.Add(1))
	return &WebSocketTransport{
		id:   id,
		conn: conn,
		done: make(chan struct{}),
	}
}

func (t *WebSocketTransport) SessionID() string { return t.id }

func (t *WebSocketTransport) Send(msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	return t.conn.Write(context.Background(), websocket.MessageText, data)
}

func (t *WebSocketTransport) Done() <-chan struct{} { return t.done }

// Close signals Done and closes the underlying connection.
func (t *WebSocketTransport) Close() {
	select {
	case <-t.done:
	default:
		close(t.done)
	}
	t.conn.Close(websocket.StatusNormalClosure, "")
}

// keepalive pings the peer until the connection goes away.
//
// Without this a client that vanishes without closing — a shut laptop, a
// killed tab, a dropped network — leaves a half-open socket whose Read never
// returns, so the avatar stays in the world forever. Ping failure closes the
// connection, which unblocks ReadLoop and lets the World remove the avatar.
func (t *WebSocketTransport) keepalive(ctx context.Context) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.done:
			return
		case <-ticker.C:
			pctx, cancel := context.WithTimeout(ctx, pingTimeout)
			err := t.conn.Ping(pctx)
			cancel()
			if err != nil {
				t.Close()
				return
			}
		}
	}
}

// ReadLoop reads raw JSON frames from the connection until it closes.
// Each frame is passed to onMessage. When the loop exits, onClose is called.
func (t *WebSocketTransport) ReadLoop(
	ctx context.Context,
	onMessage func(sessionID string, raw []byte),
	onClose func(sessionID string),
) {
	defer func() {
		t.Close()
		onClose(t.id)
	}()

	go t.keepalive(ctx)

	for {
		_, data, err := t.conn.Read(ctx)
		if err != nil {
			return
		}
		onMessage(t.id, data)
	}
}
