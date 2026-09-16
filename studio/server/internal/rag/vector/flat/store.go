// Package flat implements VectorStore with in-memory brute-force cosine
// search and JSON file persistence. This is optimal for small collections
// (up to ~10k vectors at 512 dimensions: sub-millisecond search, <2MB on disk).
//
// The VectorStore interface makes it trivial to swap this for a more
// sophisticated backend (USearch, Qdrant, etc.) when the collection outgrows
// brute-force.
package flat

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"sync"

	"github.com/openlore/studio/internal/rag/vector"
)

// ─── Persisted data model ────────────────────────────────────────────────────

// item holds all data for a single indexed entity.
type item struct {
	ID          string         `json:"id"`
	Kind        string         `json:"kind"`
	OwnerID     string         `json:"owner_id"`
	ContentHash string         `json:"content_hash"`
	Metadata    map[string]any `json:"metadata"`
	Tags        []string       `json:"tags"`
	Vectors     [][]float32    `json:"vectors"` // 1+ embeddings (e.g. image + text)
}

// snapshot is the on-disk representation of the entire store.
type snapshot struct {
	Items []*item `json:"items"`
}

// ─── Store ───────────────────────────────────────────────────────────────────

// Store is a brute-force vector store with JSON persistence.
// Mutations are buffered in-memory; call Flush() to persist to disk.
type Store struct {
	mu    sync.RWMutex
	path  string // file path for persistence ("" = in-memory only)
	dirty bool   // true if in-memory state differs from disk

	// Primary storage: ownerID:kind:externalID → *item
	items map[string]*item
}

// New creates a new flat vector store. If path points to an existing JSON file,
// data is loaded from it. All mutations are persisted back to path.
// Pass "" for an ephemeral in-memory store.
func New(path string) (*Store, error) {
	s := &Store{
		path:  path,
		items: make(map[string]*item),
	}
	if path != "" {
		if err := s.load(); err != nil && !os.IsNotExist(err) {
			return nil, fmt.Errorf("load %s: %w", path, err)
		}
	}
	return s, nil
}

// Close flushes any pending changes to disk.
func (s *Store) Close() error { return s.Flush() }

// ─── VectorStore interface ────────────────────────────────────────────────────

func (s *Store) Upsert(
	_ context.Context,
	ownerID, id, kind string,
	vecs [][]float32,
	meta map[string]any,
	tags []string,
) error {
	if ownerID == "" {
		ownerID = "default"
	}

	contentHash, _ := meta["content_hash"].(string)

	s.mu.Lock()
	defer s.mu.Unlock()

	key := itemKey(ownerID, kind, id)
	s.items[key] = &item{
		ID:          id,
		Kind:        kind,
		OwnerID:     ownerID,
		ContentHash: contentHash,
		Metadata:    meta,
		Tags:        tags,
		Vectors:     vecs,
	}

	s.dirty = true
	return nil
}

func (s *Store) Search(
	_ context.Context,
	ownerID string,
	query []float32,
	kind string,
	k int,
) ([]vector.SearchResult, error) {
	if ownerID == "" {
		ownerID = "default"
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	type scored struct {
		item     *item
		distance float32
	}

	var candidates []scored
	for _, it := range s.items {
		if it.OwnerID != ownerID {
			continue
		}
		if kind != "" && it.Kind != kind {
			continue
		}
		// Find the best (lowest distance) vector for this item.
		best := float32(math.MaxFloat32)
		for _, v := range it.Vectors {
			d := cosineDistance(query, v)
			if d < best {
				best = d
			}
		}
		if best < math.MaxFloat32 {
			candidates = append(candidates, scored{item: it, distance: best})
		}
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].distance < candidates[j].distance
	})
	if len(candidates) > k {
		candidates = candidates[:k]
	}

	results := make([]vector.SearchResult, len(candidates))
	for i, c := range candidates {
		results[i] = vector.SearchResult{
			ID:       c.item.ID,
			Kind:     c.item.Kind,
			Score:    c.distance,
			Metadata: c.item.Metadata,
			Tags:     c.item.Tags,
		}
	}
	return results, nil
}

func (s *Store) Similar(
	ctx context.Context,
	ownerID, id, kind string,
	k int,
) ([]vector.SearchResult, error) {
	if ownerID == "" {
		ownerID = "default"
	}

	s.mu.RLock()
	// Find the item's first vector.
	var queryVec []float32
	for _, it := range s.items {
		if it.OwnerID == ownerID && it.ID == id {
			if len(it.Vectors) > 0 {
				queryVec = it.Vectors[0]
			}
			break
		}
	}
	s.mu.RUnlock()

	if queryVec == nil {
		return nil, nil
	}
	return s.Search(ctx, ownerID, queryVec, kind, k)
}

func (s *Store) Tags(_ context.Context, ownerID, prefix string, limit int) ([]string, error) {
	if ownerID == "" {
		ownerID = "default"
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	freq := make(map[string]int)
	for _, it := range s.items {
		if it.OwnerID != ownerID {
			continue
		}
		for _, tag := range it.Tags {
			if strings.HasPrefix(tag, prefix) {
				freq[tag]++
			}
		}
	}

	type tagCount struct {
		tag   string
		count int
	}
	sorted := make([]tagCount, 0, len(freq))
	for t, c := range freq {
		sorted = append(sorted, tagCount{t, c})
	}
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].count > sorted[j].count
	})
	if len(sorted) > limit {
		sorted = sorted[:limit]
	}

	tags := make([]string, len(sorted))
	for i, tc := range sorted {
		tags[i] = tc.tag
	}
	return tags, nil
}

func (s *Store) Delete(_ context.Context, ownerID, id string) error {
	if ownerID == "" {
		ownerID = "default"
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// Delete across all kinds for this ownerID + id.
	for key, it := range s.items {
		if it.OwnerID == ownerID && it.ID == id {
			delete(s.items, key)
			s.dirty = true
		}
	}

	return nil
}

func (s *Store) GetAllHashes(_ context.Context, ownerID, kind string) (map[string]string, error) {
	if ownerID == "" {
		ownerID = "default"
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	m := make(map[string]string)
	for _, it := range s.items {
		if it.OwnerID == ownerID && it.Kind == kind {
			m[it.ID] = it.ContentHash
		}
	}
	return m, nil
}

func (s *Store) GetItemMetadata(_ context.Context, ownerID, kind, id string) (map[string]any, error) {
	if ownerID == "" {
		ownerID = "default"
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	key := itemKey(ownerID, kind, id)
	it, ok := s.items[key]
	if !ok {
		return nil, nil
	}
	return it.Metadata, nil
}

func (s *Store) Stats(_ context.Context, ownerID string) (map[string]int, error) {
	if ownerID == "" {
		ownerID = "default"
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	m := make(map[string]int)
	for _, it := range s.items {
		if it.OwnerID == ownerID {
			m[it.Kind]++
		}
	}
	return m, nil
}

// ─── Persistence ─────────────────────────────────────────────────────────────

// Flush persists in-memory state to disk if there are pending changes.
func (s *Store) Flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.dirty {
		return nil
	}
	return s.saveLocked()
}

func (s *Store) load() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}

	var snap snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return fmt.Errorf("decode: %w", err)
	}

	s.items = make(map[string]*item, len(snap.Items))
	for _, it := range snap.Items {
		key := itemKey(it.OwnerID, it.Kind, it.ID)
		s.items[key] = it
	}
	return nil
}

// saveLocked persists the store to disk. Caller must hold s.mu.
func (s *Store) saveLocked() error {
	if s.path == "" {
		return nil
	}

	snap := snapshot{Items: make([]*item, 0, len(s.items))}
	for _, it := range s.items {
		snap.Items = append(snap.Items, it)
	}

	data, err := json.Marshal(snap)
	if err != nil {
		return fmt.Errorf("encode: %w", err)
	}

	// Atomic write: write to temp file, then rename.
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("rename: %w", err)
	}
	s.dirty = false
	return nil
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func itemKey(ownerID, kind, id string) string {
	return ownerID + "\x00" + kind + "\x00" + id
}

// cosineDistance returns 1 - cos(a, b). Lower = more similar.
// Assumes inputs are L2-normalised (so dot product == cosine similarity).
func cosineDistance(a, b []float32) float32 {
	if len(a) != len(b) {
		return 2.0 // maximum possible cosine distance
	}
	var dot float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
	}
	return float32(1.0 - dot)
}
