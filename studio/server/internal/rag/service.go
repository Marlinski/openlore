// Package rag provides the RAGService — a thin orchestration layer that
// wraps VectorStore + Embedder + Indexer into a single dependency for HTTP handlers.
package rag

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/offisims/studio/internal/rag/embedder"
	"github.com/offisims/studio/internal/rag/indexer"
	"github.com/offisims/studio/internal/rag/vector"
)

// Service orchestrates embeddings, vector storage, and indexing.
type Service struct {
	vec vector.VectorStore
	emb embedder.Embedder
	idx indexer.Indexer
}

// New creates a RAGService.
func New(vec vector.VectorStore, emb embedder.Embedder, idx indexer.Indexer) *Service {
	return &Service{vec: vec, emb: emb, idx: idx}
}

// Search embeds the query text and finds the k nearest items.
func (s *Service) Search(ctx context.Context, ownerID, query, kind string, k int) ([]vector.SearchResult, error) {
	vec, err := s.emb.EmbedText(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("embed query: %w", err)
	}
	return s.vec.Search(ctx, ownerID, vec, kind, k)
}

// Similar finds the k nearest items to an already-indexed item.
func (s *Service) Similar(ctx context.Context, ownerID, id, kind string, k int) ([]vector.SearchResult, error) {
	return s.vec.Similar(ctx, ownerID, id, kind, k)
}

// Tags returns tags matching the given prefix.
func (s *Service) Tags(ctx context.Context, ownerID, prefix string, limit int) ([]string, error) {
	return s.vec.Tags(ctx, ownerID, prefix, limit)
}

// Stats returns item counts by kind for the given owner.
func (s *Service) Stats(ctx context.Context, ownerID string) (map[string]int, error) {
	return s.vec.Stats(ctx, ownerID)
}

// Reindex triggers a full re-index for the given owner and returns timing.
func (s *Service) Reindex(ctx context.Context, ownerID string) (map[string]any, error) {
	t0 := time.Now()
	log.Printf("[rag] Reindex triggered for owner=%s", ownerID)
	if err := s.idx.IndexAll(ctx, ownerID); err != nil {
		return nil, err
	}
	stats, err := s.vec.Stats(ctx, ownerID)
	if err != nil {
		stats = map[string]int{}
	}
	return map[string]any{
		"ok":      true,
		"elapsed": time.Since(t0).Seconds(),
		"stats":   stats,
	}, nil
}

// StartWatch launches the fsnotify watch loop in the background.
// It returns immediately; the loop runs until ctx is cancelled.
func (s *Service) StartWatch(ctx context.Context, ownerID string) {
	go func() {
		if err := s.idx.Watch(ctx, ownerID); err != nil {
			log.Printf("[rag] watcher stopped: %v", err)
		}
	}()
}
