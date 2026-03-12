// Package workspace defines the interface for workspace management.
//
// A workspace is an isolated project directory containing tilesets,
// resources, composites, rooms, and masks. The Manager interface
// abstracts workspace CRUD so the backing store can be swapped
// (filesystem today, database + S3 later).
package workspace

import (
	"context"
	"time"
)

// Info holds workspace metadata. Stored as metadata.json inside
// each workspace directory in the filesystem implementation.
type Info struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

// Manager is the interface for workspace lifecycle operations.
// Implementations must be safe for concurrent use.
//
// For multi-user: add a userID parameter to List/Create and store
// a user→workspace mapping in the backing store.
type Manager interface {
	// List returns all workspaces visible to the current user.
	List(ctx context.Context) ([]Info, error)

	// Get returns a single workspace by ID.
	Get(ctx context.Context, id string) (Info, error)

	// Create scaffolds a new workspace with the given display name.
	// The ID is generated server-side.
	Create(ctx context.Context, name string) (Info, error)

	// Delete removes a workspace and all its data.
	Delete(ctx context.Context, id string) error
}

// Sentinel errors.
var (
	ErrNotFound = workspaceError("workspace not found")
)

type workspaceError string

func (e workspaceError) Error() string { return string(e) }
