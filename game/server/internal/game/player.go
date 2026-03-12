package game

import (
	"sync"

	"github.com/google/uuid"
)

// PlayerRecord represents a registered player.
// Created at registration (REST API), persists for the server's lifetime.
type PlayerRecord struct {
	Token       string
	Name        string
	CharacterID string
	CreatedAt   int64 // unix millis
}

// PlayerStore manages player registrations. Thread-safe via RWMutex.
// HTTP handlers call Register/GetByToken, then the token flows into the World
// via WebSocket join messages. The World's Run goroutine also calls GetByToken
// when handling join messages, so the mutex is needed.
type PlayerStore struct {
	mu      sync.RWMutex
	players map[string]*PlayerRecord // token → record
}

// NewPlayerStore creates an empty player store.
func NewPlayerStore() *PlayerStore {
	return &PlayerStore{
		players: make(map[string]*PlayerRecord),
	}
}

// Register creates a new player with a unique token.
func (s *PlayerStore) Register(name, characterID string) *PlayerRecord {
	token := uuid.New().String()
	rec := &PlayerRecord{
		Token:       token,
		Name:        name,
		CharacterID: characterID,
		CreatedAt:   nowMillis(),
	}
	s.mu.Lock()
	s.players[token] = rec
	s.mu.Unlock()
	return rec
}

// GetByToken looks up a player by token, or nil if not found.
func (s *PlayerStore) GetByToken(token string) *PlayerRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.players[token]
}
