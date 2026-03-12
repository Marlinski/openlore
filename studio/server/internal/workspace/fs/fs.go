package fsworkspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/offisims/studio/internal/workspace"
)

// subdirs are the directories scaffolded inside each new workspace.
var subdirs = []string{"tilesets", "resources", "composites", "rooms", "masks", "packs"}

// FSManager implements workspace.Manager backed by the local filesystem.
// Workspaces live under {studioDir}/workspaces/{id}/ with a metadata.json
// and the standard resource subdirectories.
type FSManager struct {
	studioDir string
}

// New creates a filesystem-backed workspace manager.
// studioDir is the studio root directory (e.g. "data/studio").
func New(studioDir string) *FSManager {
	return &FSManager{studioDir: studioDir}
}

// workspacesDir returns the directory containing all workspaces.
func (m *FSManager) workspacesDir() string {
	return filepath.Join(m.studioDir, "workspaces")
}

func (m *FSManager) List(_ context.Context) ([]workspace.Info, error) {
	entries, err := os.ReadDir(m.workspacesDir())
	if errors.Is(err, os.ErrNotExist) {
		return []workspace.Info{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read studio dir: %w", err)
	}

	var result []workspace.Info
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		info, err := m.readMeta(e.Name())
		if err != nil {
			// Directory without metadata — skip (e.g. leftover dirs).
			continue
		}
		result = append(result, info)
	}

	// Sort by creation time, newest first.
	sort.Slice(result, func(i, j int) bool {
		return result[i].CreatedAt.After(result[j].CreatedAt)
	})

	return result, nil
}

func (m *FSManager) Get(_ context.Context, id string) (workspace.Info, error) {
	return m.readMeta(id)
}

func (m *FSManager) Create(_ context.Context, name string) (workspace.Info, error) {
	id := generateID()
	dir := filepath.Join(m.workspacesDir(), id)

	// Create workspace directory and resource subdirs.
	for _, sub := range subdirs {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return workspace.Info{}, fmt.Errorf("mkdir %s/%s: %w", id, sub, err)
		}
	}

	info := workspace.Info{
		ID:        id,
		Name:      name,
		CreatedAt: time.Now().UTC(),
	}

	if err := m.writeMeta(info); err != nil {
		// Best effort cleanup on metadata write failure.
		_ = os.RemoveAll(dir)
		return workspace.Info{}, err
	}

	return info, nil
}

func (m *FSManager) Delete(_ context.Context, id string) error {
	dir := filepath.Join(m.workspacesDir(), id)
	if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
		return workspace.ErrNotFound
	}
	return os.RemoveAll(dir)
}

// ── Internal helpers ────────────────────────────────────────────────────

const metaFile = "metadata.json"

func (m *FSManager) metaPath(id string) string {
	return filepath.Join(m.workspacesDir(), id, metaFile)
}

func (m *FSManager) readMeta(id string) (workspace.Info, error) {
	data, err := os.ReadFile(m.metaPath(id))
	if errors.Is(err, os.ErrNotExist) {
		return workspace.Info{}, workspace.ErrNotFound
	}
	if err != nil {
		return workspace.Info{}, fmt.Errorf("read metadata %s: %w", id, err)
	}
	var info workspace.Info
	if err := json.Unmarshal(data, &info); err != nil {
		return workspace.Info{}, fmt.Errorf("unmarshal metadata %s: %w", id, err)
	}
	return info, nil
}

func (m *FSManager) writeMeta(info workspace.Info) error {
	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal metadata: %w", err)
	}
	target := m.metaPath(info.ID)
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return fmt.Errorf("write metadata: %w", err)
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename metadata: %w", err)
	}
	return nil
}

// generateID creates a short, URL-safe workspace ID.
// Format: base36 timestamp + 6 random base36 chars (e.g. "m1a2b3c4d5e6f7").
// Same pattern used by the frontend for resource IDs.
func generateID() string {
	ts := strconv.FormatInt(time.Now().UnixMilli(), 36)
	const charset = "0123456789abcdefghijklmnopqrstuvwxyz"
	suffix := make([]byte, 6)
	for i := range suffix {
		suffix[i] = charset[rand.Intn(len(charset))]
	}
	return ts + string(suffix)
}
