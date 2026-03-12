// Package game implements the authoritative game state and logic.
//
// The World actor goroutine owns all mutable state (avatars, rooms, sessions).
// All mutations flow through the dispatch channel as Envelope messages.
// No mutexes inside the World — all access is serialized.

package game

import (
	"fmt"
	"sync/atomic"
)

// Avatar represents a player in the game world.
// Owned exclusively by the World goroutine — no concurrent access.
type Avatar struct {
	ID          string
	Token       string // persistent reconnection token (UUID)
	Name        string
	CharacterID string
	Room        string
	X           float64
	Y           float64
	Direction   string // "down", "up", "left", "right"
	Moving      bool
	Family      string // "idle", "walk", etc.
	LastUpdate  int64  // unix millis
}

var nextAvatarID atomic.Uint64

// newAvatar creates a new avatar with a unique ID.
func newAvatar(token, name, characterID, room string, x, y float64) *Avatar {
	id := fmt.Sprintf("avatar-%d", nextAvatarID.Add(1))
	return &Avatar{
		ID:          id,
		Token:       token,
		Name:        name,
		CharacterID: characterID,
		Room:        room,
		X:           x,
		Y:           y,
		Direction:   "down",
		Moving:      false,
		Family:      "idle",
		LastUpdate:  nowMillis(),
	}
}

// toSnapshot returns a JSON-serializable snapshot for sending to clients.
func (a *Avatar) toSnapshot() AvatarSnapshot {
	return AvatarSnapshot{
		ID:          a.ID,
		Name:        a.Name,
		CharacterID: a.CharacterID,
		Room:        a.Room,
		X:           a.X,
		Y:           a.Y,
		Direction:   a.Direction,
		Moving:      a.Moving,
		Family:      a.Family,
	}
}
