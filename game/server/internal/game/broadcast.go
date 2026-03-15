package game

import (
	"encoding/json"
	"log"
	"time"

	"github.com/offisims/game/internal/transport"
)

// gracePrefix is prepended to avatar IDs in synthetic disconnect envelopes
// so the Run loop can distinguish grace-timer expiry from real disconnects.
const gracePrefix = "grace:"

// ─── Exclusion types ─────────────────────────────────────────────

// exclusion is used by broadcastToRoom to skip certain recipients.
type exclusion struct {
	avatarID string // if set, exclude all connections of this avatar
	connID   string // if set, exclude only this specific connection
}

// excludeAvatar returns an exclusion that skips all connections of an avatar.
// Used when broadcasting a join/leave — the avatar itself already knows.
func excludeAvatar(avatarID string) *exclusion {
	return &exclusion{avatarID: avatarID}
}

// excludeConn returns an exclusion that skips a single connection.
// Used for position updates — other tabs of the same avatar still get the update.
func excludeConn(connID string) *exclusion {
	return &exclusion{connID: connID}
}

// ─── Connection tracking ─────────────────────────────────────────

// addConn registers a connection for an avatar. Bidirectional mapping.
func (w *World) addConn(connID, avatarID string) {
	w.connAvatars[connID] = avatarID
	conns, ok := w.avatarConns[avatarID]
	if !ok {
		conns = make(map[string]struct{})
		w.avatarConns[avatarID] = conns
	}
	conns[connID] = struct{}{}
}

// removeConn unregisters a single connection from an avatar.
func (w *World) removeConn(connID, avatarID string) {
	delete(w.connAvatars, connID)
	if conns, ok := w.avatarConns[avatarID]; ok {
		delete(conns, connID)
		if len(conns) == 0 {
			delete(w.avatarConns, avatarID)
		}
	}
}

// ─── Sending helpers ─────────────────────────────────────────────

// sendToConn sends a message to a single WebSocket connection.
func (w *World) sendToConn(connID string, msg any) {
	t, ok := w.transports[connID]
	if !ok {
		return
	}
	if err := t.Send(msg); err != nil {
		log.Printf("[World %s] send to %s failed: %v", w.Channel, connID, err)
	}
}

// sendToAvatar sends a message to ALL connections of an avatar (multi-tab).
func (w *World) sendToAvatar(avatarID string, msg any) {
	conns, ok := w.avatarConns[avatarID]
	if !ok {
		return
	}
	// Pre-marshal once for efficiency when there are multiple connections.
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("[World %s] marshal error for avatar %s: %v", w.Channel, avatarID, err)
		return
	}
	for connID := range conns {
		t, ok := w.transports[connID]
		if !ok {
			continue
		}
		// Send raw bytes via the transport's underlying Send.
		// Transport.Send expects any and marshals internally,
		// so we wrap the raw JSON to avoid double-marshalling.
		if err := t.Send(json.RawMessage(data)); err != nil {
			log.Printf("[World %s] send to %s (avatar %s) failed: %v",
				w.Channel, connID, avatarID, err)
		}
	}
}

// broadcastToRoom sends a message to all avatars in a room,
// optionally excluding one avatar or one connection.
func (w *World) broadcastToRoom(roomName string, msg any, exc *exclusion) {
	room, ok := w.rooms[roomName]
	if !ok {
		return
	}

	// Pre-marshal once for the whole room.
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("[World %s] marshal error for room broadcast: %v", w.Channel, err)
		return
	}
	raw := json.RawMessage(data)

	for avatarID := range room.AvatarIDs {
		// Avatar-level exclusion
		if exc != nil && exc.avatarID != "" && exc.avatarID == avatarID {
			continue
		}

		conns, ok := w.avatarConns[avatarID]
		if !ok {
			continue
		}
		for connID := range conns {
			// Connection-level exclusion
			if exc != nil && exc.connID != "" && exc.connID == connID {
				continue
			}
			t, ok := w.transports[connID]
			if !ok {
				continue
			}
			if err := t.Send(raw); err != nil {
				log.Printf("[World %s] broadcast to %s failed: %v", w.Channel, connID, err)
			}
		}
	}
}

// ─── Grace timer ─────────────────────────────────────────────────

// startGraceTimer starts a 30-second timer for a disconnected avatar.
// When it fires, a synthetic envelope is dispatched back into the Run loop.
func (w *World) startGraceTimer(avatarID string) {
	// Cancel any existing timer first
	if timer, ok := w.graceTimers[avatarID]; ok {
		timer.Stop()
	}

	w.graceTimers[avatarID] = time.AfterFunc(
		time.Duration(disconnectGraceMS)*time.Millisecond,
		func() {
			// Post a synthetic envelope. The connID carries the grace prefix
			// so handleEnvelope knows this is a timer expiry, not a real disconnect.
			w.Dispatch(transport.Envelope{
				ConnID:    gracePrefix + avatarID,
				Transport: nil,
				Raw:       nil,
			})
		},
	)
}

// handleGraceExpiry is called when a grace timer fires for an avatar.
// If the avatar still has no connections, it's removed from the world.
func (w *World) handleGraceExpiry(avatarID string) {
	delete(w.graceTimers, avatarID)

	// If reconnected in the meantime, do nothing
	if conns := w.avatarConns[avatarID]; len(conns) > 0 {
		return
	}

	avatar := w.avatars[avatarID]
	if avatar == nil {
		return
	}

	log.Printf("[World %s] %s (%s) grace period expired, removing",
		w.Channel, avatar.Name, avatarID)

	w.removeAvatar(avatarID)
}

// ─── Snapshot helpers ────────────────────────────────────────────

// getAvatarsInRoom returns snapshots of all avatars currently in a room.
func (w *World) getAvatarsInRoom(roomName string) []AvatarSnapshot {
	room, ok := w.rooms[roomName]
	if !ok {
		return nil
	}
	result := make([]AvatarSnapshot, 0, len(room.AvatarIDs))
	for avatarID := range room.AvatarIDs {
		if avatar, ok := w.avatars[avatarID]; ok {
			result = append(result, avatar.toSnapshot())
		}
	}
	return result
}
