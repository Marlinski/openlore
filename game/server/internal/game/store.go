package game

import (
	"fmt"
	"sync"

	pack "github.com/openlore/shared/pack"
)

// Store manages the set of running Worlds keyed by channel name (e.g. "#lobby").
// Thread-safe via RWMutex.
//
// Each channel maps to exactly one World. The channel name is the primary key,
// matching the IRC model where each game room = one IRC channel.
type Store struct {
	mu      sync.RWMutex
	worlds  map[string]*World // channel name → World
	players *PlayerStore
}

// NewStore creates an empty world store. The player store is injected and
// shared across all worlds created by this store.
func NewStore(players *PlayerStore) *Store {
	return &Store{
		worlds:  make(map[string]*World),
		players: players,
	}
}

// Create starts a new World for the given channel, backed by the given pack,
// and launches its Run loop. The channel name (e.g. "#lobby") is the primary key.
// defaultRoom sets the spawn room for new avatars; pass "" to use the first room in the pack.
func (s *Store) Create(channel, packID string, p *pack.Pack, defaultRoom string) (*World, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.worlds[channel]; exists {
		return nil, fmt.Errorf("channel %q already exists", channel)
	}

	w := NewWorld(channel, packID, p, s.players, defaultRoom)
	s.worlds[channel] = w

	go w.Run()

	return w, nil
}

// Get returns a world by channel name, or nil if not found.
func (s *Store) Get(channel string) *World {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.worlds[channel]
}

// List returns metadata for all running worlds.
func (s *Store) List() []ChannelMeta {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]ChannelMeta, 0, len(s.worlds))
	for _, w := range s.worlds {
		result = append(result, w.Meta())
	}
	return result
}

// Count returns the number of running worlds.
func (s *Store) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.worlds)
}

// Stop shuts down a world and removes it from the store.
func (s *Store) Stop(channel string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	w, ok := s.worlds[channel]
	if !ok {
		return fmt.Errorf("channel %q not found", channel)
	}

	w.Stop()
	delete(s.worlds, channel)
	return nil
}

// StopAll shuts down all worlds. Called on server shutdown.
func (s *Store) StopAll() {
	s.mu.Lock()
	defer s.mu.Unlock()

	for ch, w := range s.worlds {
		w.Stop()
		delete(s.worlds, ch)
	}
}

// Default returns the single world if there is exactly one, or nil.
// Supports the single-world shorthand: WS connects without ?channel= param.
func (s *Store) Default() *World {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if len(s.worlds) == 1 {
		for _, w := range s.worlds {
			return w
		}
	}
	return nil
}
