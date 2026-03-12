package vector

import "context"

// SearchResult is returned by vector similarity queries.
type SearchResult struct {
	ID       string
	Kind     string
	Score    float32 // lower = more similar (cosine distance)
	Metadata map[string]any
	Tags     []string
}

// VectorStore stores embedding vectors and answers similarity queries.
// All operations are scoped to an ownerID for multi-tenancy.
// Swap implementations (flat → USearch → Qdrant) in main.go.
type VectorStore interface {
	// Upsert inserts or replaces all vectors for an item.
	// vecs may contain multiple vectors (e.g. image + text for the same tileset).
	Upsert(ctx context.Context, ownerID, id, kind string, vecs [][]float32, meta map[string]any, tags []string) error

	// Search finds the k nearest items to query within ownerID's namespace.
	// kind="" searches across all kinds.
	Search(ctx context.Context, ownerID string, query []float32, kind string, k int) ([]SearchResult, error)

	// Similar finds the k nearest items to an already-indexed item.
	Similar(ctx context.Context, ownerID, id string, kind string, k int) ([]SearchResult, error)

	// Tags returns tags with the given prefix, ordered by frequency.
	Tags(ctx context.Context, ownerID, prefix string, limit int) ([]string, error)

	// Delete removes all vectors associated with an item.
	Delete(ctx context.Context, ownerID, id string) error

	// GetAllHashes returns externalID → contentHash for all items of a given kind.
	// Used by the indexer for hash-diff change detection.
	GetAllHashes(ctx context.Context, ownerID, kind string) (map[string]string, error)

	// GetItemMetadata returns the stored metadata for a single item.
	// Returns nil, nil if the item does not exist.
	GetItemMetadata(ctx context.Context, ownerID, kind, id string) (map[string]any, error)

	// Stats returns item counts per kind for the given owner.
	Stats(ctx context.Context, ownerID string) (map[string]int, error)

	// Flush persists any pending in-memory changes to disk.
	// Implementations that persist on every write may no-op.
	Flush() error
}
