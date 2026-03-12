package indexer

import "context"

// Indexer coordinates the Embedder and VectorStore to keep the search
// index in sync with the filesystem.
// Swap implementations by changing the concrete type wired in main.go.
type Indexer interface {
	// IndexAll performs a full rescan: hash-diff against the DB,
	// embed new/changed items, remove stale entries.
	IndexAll(ctx context.Context, ownerID string) error

	// IndexPath indexes (or re-indexes) a single file path.
	// Called by the filesystem watcher on individual change events.
	IndexPath(ctx context.Context, ownerID, path string) error

	// Watch starts a blocking fsnotify loop that calls IndexPath
	// for every create/write/rename event under the data directory.
	// Returns when ctx is cancelled.
	Watch(ctx context.Context, ownerID string) error
}
