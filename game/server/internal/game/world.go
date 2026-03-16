// World is the authoritative game state for one running instance.
//
// It owns everything needed to run a game: rooms, avatars, transports,
// the dispatch channel, and lifecycle. The Store manages multiple Worlds.
//
// All mutable game state is owned by a single goroutine (Run) that reads
// from the dispatch channel. No mutexes inside the World — access is serialized.
//
// Multiple concurrent connections per avatar are allowed (multi-tab).
// When all connections disconnect, the avatar is removed immediately.

package game

import (
	"encoding/json"
	"log"
	"sync/atomic"
	"time"

	"github.com/offisims/game/internal/transport"
	pack "github.com/offisims/shared/pack"
)

// ChannelMeta is the public-facing metadata returned by the API.
// Each channel maps 1:1 with an IRC channel; the Channel field is the
// canonical name (e.g. "#lobby").
type ChannelMeta struct {
	Channel string `json:"channel"`
	PackID  string `json:"packId"`
	Players int    `json:"players"`
	Created string `json:"created"`
}

// World is one running game instance backed by a pack.
// Each World corresponds to one IRC channel.
type World struct {
	// ── Identity & lifecycle ─────────────────────────────────
	Channel string // IRC channel name, e.g. "#lobby"
	PackID  string
	Pack    *pack.Pack
	Created time.Time

	dispatch chan transport.Envelope
	stopped  atomic.Bool
	players_ atomic.Int32 // player count, safe for concurrent reads from HTTP

	// ── Game state (owned by the Run goroutine) ──────────────
	rooms        map[string]*Room
	avatars      map[string]*Avatar
	tokenAvatars map[string]string              // token → avatar ID
	avatarConns  map[string]map[string]struct{} // avatar ID → set of connIDs
	connAvatars  map[string]string              // connID → avatar ID
	transports   map[string]transport.Transport // connID → transport

	players *PlayerStore

	defaultRoom string
}

// NewWorld creates a World for the given channel, loads game data from the
// pack, and returns it ready to be started with Run.
// defaultRoom is the room new avatars spawn in; pass "" to use the first room in the pack.
func NewWorld(channel, packID string, p *pack.Pack, players *PlayerStore, defaultRoom string) *World {
	w := &World{
		Channel: channel,
		PackID:  packID,
		Pack:    p,
		Created: time.Now(),

		dispatch: make(chan transport.Envelope, 256),

		rooms:        make(map[string]*Room),
		avatars:      make(map[string]*Avatar),
		tokenAvatars: make(map[string]string),
		avatarConns:  make(map[string]map[string]struct{}),
		connAvatars:  make(map[string]string),
		transports:   make(map[string]transport.Transport),

		players:     players,
		defaultRoom: defaultRoom,
	}

	// Load rooms from pack
	w.loadRooms(p)

	return w
}

// Meta returns a JSON-friendly snapshot of the world.
// Safe to call from any goroutine.
func (w *World) Meta() ChannelMeta {
	return ChannelMeta{
		Channel: w.Channel,
		PackID:  w.PackID,
		Players: int(w.players_.Load()),
		Created: w.Created.Format(time.RFC3339),
	}
}

// Dispatch sends an envelope into the world's dispatch channel.
// Safe to call from any goroutine (the WS handler goroutine, typically).
func (w *World) Dispatch(env transport.Envelope) {
	if w.stopped.Load() {
		return
	}
	select {
	case w.dispatch <- env:
	default:
		log.Printf("[World %s] dispatch channel full, dropping envelope from %s", w.Channel, env.ConnID)
	}
}

// Stop shuts down the world. Closes the dispatch channel so Run exits.
func (w *World) Stop() {
	if w.stopped.CompareAndSwap(false, true) {
		close(w.dispatch)
	}
}

// Stopped returns true if the world has been shut down.
func (w *World) Stopped() bool {
	return w.stopped.Load()
}

// ─── Data loading ────────────────────────────────────────────────

func (w *World) loadRooms(p *pack.Pack) {
	for _, def := range p.Rooms {
		room := NewRoom(def)
		w.rooms[room.Name] = room
	}

	if w.defaultRoom == "" && len(p.Rooms) > 0 {
		w.defaultRoom = p.Rooms[0].Name
	}

	log.Printf("[World %s] loaded %d rooms, %d composites, %d tilesets",
		w.Channel, len(p.Rooms), len(p.Composites), len(p.Tilesets))
}

// ─── Run loop ────────────────────────────────────────────────────

// Run is the main event loop. Blocks until the dispatch channel is closed.
// Call in a goroutine: go world.Run()
func (w *World) Run() {
	log.Printf("[World %s] started", w.Channel)

	for env := range w.dispatch {
		w.handleEnvelope(env)
	}

	log.Printf("[World %s] stopped", w.Channel)
}

func (w *World) handleEnvelope(env transport.Envelope) {
	// Nil Raw + nil Transport = disconnect
	if env.Raw == nil && env.Transport == nil {
		w.handleDisconnect(env.ConnID)
		delete(w.transports, env.ConnID)
		return
	}

	// Register/update transport for this connection
	w.transports[env.ConnID] = env.Transport

	var msg ClientMessage
	if err := json.Unmarshal(env.Raw, &msg); err != nil {
		log.Printf("[World %s] bad message from %s: %v", w.Channel, env.ConnID, err)
		return
	}

	w.routeMessage(env.ConnID, &msg)
}

func (w *World) routeMessage(connID string, msg *ClientMessage) {
	switch msg.Type {
	case "join":
		w.handleJoin(connID, msg.Token)
	case "position":
		w.handlePosition(connID, msg.X, msg.Y, msg.Direction, msg.Moving)
	case "use-door":
		w.handleUseDoor(connID, msg.DoorID)
	case "leave":
		w.handleLeave(connID)
	default:
		log.Printf("[World %s] unknown message type %q from %s", w.Channel, msg.Type, connID)
	}
}
