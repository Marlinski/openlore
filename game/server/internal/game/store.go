package game

import (
	"fmt"
	"sync"

	pack "github.com/offisims/shared/pack"
)

// Store manages the set of running Worlds. Thread-safe via RWMutex.
// Replaces session.Store — every "session" is now a World.
type Store struct {
	mu      sync.RWMutex
	worlds  map[string]*World
	nextID  int
	chat    ChatProvider
	players *PlayerStore
}

// NewStore creates an empty world store. The chat provider and player store
// are injected and shared across all worlds created by this store.
func NewStore(chat ChatProvider, players *PlayerStore) *Store {
	return &Store{
		worlds:  make(map[string]*World),
		chat:    chat,
		players: players,
	}
}

// Create starts a new World backed by the given pack and launches its Run loop.
// If name is empty, a default name is derived from the pack manifest.
func (s *Store) Create(id, name, packID string, p *pack.Pack) (*World, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.worlds[id]; exists {
		return nil, fmt.Errorf("world %q already exists", id)
	}

	if name == "" {
		if p.Manifest != nil && p.Manifest.Name != "" {
			name = p.Manifest.Name
		} else {
			name = packID
		}
	}

	w := NewWorld(id, name, packID, p, s.chat, s.players)
	s.worlds[id] = w

	go w.Run()

	return w, nil
}

// GenerateID returns the next unique world ID.
func (s *Store) GenerateID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	return fmt.Sprintf("world-%d", s.nextID)
}

// Get returns a world by ID, or nil if not found.
func (s *Store) Get(id string) *World {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.worlds[id]
}

// List returns metadata for all running worlds.
func (s *Store) List() []WorldMeta {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]WorldMeta, 0, len(s.worlds))
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
func (s *Store) Stop(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	w, ok := s.worlds[id]
	if !ok {
		return fmt.Errorf("world %q not found", id)
	}

	w.Stop()
	delete(s.worlds, id)
	return nil
}

// StopAll shuts down all worlds. Called on server shutdown.
func (s *Store) StopAll() {
	s.mu.Lock()
	defer s.mu.Unlock()

	for id, w := range s.worlds {
		w.Stop()
		delete(s.worlds, id)
	}
}

// Default returns the single world if there is exactly one, or nil.
// Supports the single-world shorthand: WS connects without ?session= param.
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
