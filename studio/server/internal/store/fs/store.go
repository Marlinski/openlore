package fs

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/offisims/studio/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// protojson options matching shared/pack conventions.
var (
	marshaler = protojson.MarshalOptions{
		Multiline:       true,
		Indent:          "  ",
		UseEnumNumbers:  true,
		EmitUnpopulated: true,
	}
	unmarshaler = protojson.UnmarshalOptions{DiscardUnknown: true}
)

// FSStore[T] persists protobuf entities as individual JSON files under:
//
//	{base}/{ownerID}/{kind}/{id}.json
//
// base is the workspaces root directory (e.g. "data/studio/workspaces").
// ownerID is the workspace ID extracted from the URL path.
// T must be a pointer-to-proto-message (e.g. *pb.Resource).
//
// Atomic writes: temp file → rename, so readers never see partial writes.
type FSStore[T proto.Message] struct {
	base  string         // workspaces root, e.g. "data/studio/workspaces"
	kind  string         // e.g. "resources", "composites", "rooms", "masks"
	newT  func() T       // factory: returns a zero-value T
	getID func(T) string // extracts the entity ID from T
}

// New constructs an FSStore. base is the workspaces root directory.
// newT returns a fresh zero-value T for unmarshaling.
// getID extracts the entity's primary key.
func New[T proto.Message](base, kind string, newT func() T, getID func(T) string) *FSStore[T] {
	return &FSStore[T]{base: base, kind: kind, newT: newT, getID: getID}
}

// dir returns the directory for the given workspace (ownerID).
func (s *FSStore[T]) dir(ownerID string) string {
	return filepath.Join(s.base, ownerID, s.kind)
}

func (s *FSStore[T]) path(ownerID, id string) string {
	return filepath.Join(s.dir(ownerID), id+".json")
}

func (s *FSStore[T]) List(_ context.Context, f store.Filter) ([]T, error) {
	dir := s.dir(f.OwnerID)
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return []T{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read dir %s: %w", dir, err)
	}

	var results []T
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".json")
		entity, err := s.Get(context.Background(), f.OwnerID, id)
		if err != nil {
			continue // skip corrupt files silently
		}
		results = append(results, entity)
	}
	return results, nil
}

func (s *FSStore[T]) Get(_ context.Context, ownerID, id string) (T, error) {
	var zero T
	data, err := os.ReadFile(s.path(ownerID, id))
	if errors.Is(err, os.ErrNotExist) {
		return zero, store.ErrNotFound
	}
	if err != nil {
		return zero, fmt.Errorf("read %s: %w", id, err)
	}
	entity := s.newT()
	if err := unmarshaler.Unmarshal(data, entity); err != nil {
		return zero, fmt.Errorf("unmarshal %s: %w", id, err)
	}
	return entity, nil
}

func (s *FSStore[T]) Put(_ context.Context, ownerID string, e T) (T, error) {
	dir := s.dir(ownerID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return e, fmt.Errorf("mkdir %s: %w", dir, err)
	}

	data, err := marshaler.Marshal(e)
	if err != nil {
		return e, fmt.Errorf("marshal %s: %w", s.getID(e), err)
	}

	target := s.path(ownerID, s.getID(e))
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return e, fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return e, fmt.Errorf("rename to %s: %w", target, err)
	}
	return e, nil
}

func (s *FSStore[T]) Delete(_ context.Context, ownerID, id string) error {
	err := os.Remove(s.path(ownerID, id))
	if errors.Is(err, os.ErrNotExist) {
		return store.ErrNotFound
	}
	return err
}
