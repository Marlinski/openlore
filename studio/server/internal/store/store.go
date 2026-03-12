package store

import "context"

// Filter constrains entity queries. All fields are optional.
type Filter struct {
	OwnerID string   // "" matches the default tenant
	Tags    []string // intersection filter: entity must have ALL listed tags
}

// Store is a generic CRUD interface for protobuf entity types.
// T is always a pointer-to-proto-message (e.g. *pb.Resource).
type Store[T any] interface {
	List(ctx context.Context, f Filter) ([]T, error)
	Get(ctx context.Context, ownerID, id string) (T, error)
	Put(ctx context.Context, ownerID string, e T) (T, error)
	Delete(ctx context.Context, ownerID, id string) error
}

// Sentinel errors.
var (
	ErrNotFound = storeError("not found")
	ErrConflict = storeError("conflict")
)

type storeError string

func (e storeError) Error() string { return string(e) }
