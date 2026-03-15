// Package packstore discovers, loads and manages packs for the game server.
// Packs are stored as directories under a root packs directory. Each directory
// contains manifest.json and subdirectories of JSON entity files.
//
// PackStore is safe for concurrent use. It caches loaded packs in memory
// and only reads from disk on first access or explicit reload.
package packstore

import (
	"archive/zip"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/offisims/shared/pack"
	pb "github.com/offisims/shared/pack/pb/packv1"
)

// Store discovers and manages packs on disk.
type Store struct {
	mu        sync.RWMutex
	root      string                      // data/packs/ directory
	manifests map[string]*pb.PackManifest // packID → manifest (always populated after Scan)
	cache     map[string]*pack.Pack       // packID → full pack (lazy-loaded)
}

// New creates a PackStore rooted at the given directory.
// Call Scan() to discover installed packs.
func New(root string) *Store {
	return &Store{
		root:      root,
		manifests: make(map[string]*pb.PackManifest),
		cache:     make(map[string]*pack.Pack),
	}
}

// Scan walks the packs directory and reads all manifests.
// Call this once at startup after any migration.
func (s *Store) Scan() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Reset
	s.manifests = make(map[string]*pb.PackManifest)
	s.cache = make(map[string]*pack.Pack)

	entries, err := os.ReadDir(s.root)
	if os.IsNotExist(err) {
		return nil // no packs directory yet — that's fine
	}
	if err != nil {
		return fmt.Errorf("read packs dir: %w", err)
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		id := entry.Name()
		dir := filepath.Join(s.root, id)

		manifest, err := pack.OpenManifest(dir)
		if err != nil {
			log.Printf("packstore: skipping %q: %v", id, err)
			continue
		}
		// Ensure manifest ID matches directory name
		manifest.Id = id
		s.manifests[id] = manifest
	}

	log.Printf("packstore: found %d pack(s)", len(s.manifests))
	return nil
}

// List returns manifests of all installed packs.
func (s *Store) List() []*pb.PackManifest {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make([]*pb.PackManifest, 0, len(s.manifests))
	for _, m := range s.manifests {
		out = append(out, m)
	}
	return out
}

// GetManifest returns the manifest for a single pack, or nil if not found.
func (s *Store) GetManifest(id string) *pb.PackManifest {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.manifests[id]
}

// Get loads and returns a full pack. The pack is cached after first load.
// Returns an error if the pack is not installed or cannot be read.
func (s *Store) Get(id string) (*pack.Pack, error) {
	// Fast path: check cache under read lock
	s.mu.RLock()
	if p, ok := s.cache[id]; ok {
		s.mu.RUnlock()
		return p, nil
	}
	_, known := s.manifests[id]
	s.mu.RUnlock()

	if !known {
		return nil, fmt.Errorf("pack %q not found", id)
	}

	// Slow path: load from disk under write lock
	s.mu.Lock()
	defer s.mu.Unlock()

	// Double-check after acquiring write lock
	if p, ok := s.cache[id]; ok {
		return p, nil
	}

	dir := filepath.Join(s.root, id)
	p, err := pack.Open(dir)
	if err != nil {
		return nil, fmt.Errorf("load pack %q: %w", id, err)
	}

	s.cache[id] = p
	return p, nil
}

// Has returns true if a pack with the given ID is installed.
func (s *Store) Has(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.manifests[id]
	return ok
}

// Count returns the number of installed packs.
func (s *Store) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.manifests)
}

// Install extracts an .offpack ZIP from the reader and installs it under
// the given pack ID. If a pack with that ID already exists, it is overwritten.
// After installation, the pack is added to the index.
func (s *Store) Install(id string, r io.Reader) error {
	// Write the zip to a temp file so we can use zip.OpenReader
	tmp, err := os.CreateTemp("", "offpack-*.zip")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if _, err := io.Copy(tmp, r); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	tmp.Close()

	// Read the pack from the zip
	p, err := pack.ReadZip(tmpPath)
	if err != nil {
		return fmt.Errorf("read zip: %w", err)
	}

	// Ensure manifest ID matches requested ID
	if p.Manifest != nil {
		p.Manifest.Id = id
	}

	// Write pack to disk as JSON directory
	dir := filepath.Join(s.root, id)
	if err := pack.Write(dir, p); err != nil {
		return fmt.Errorf("write pack: %w", err)
	}

	// Extract atlas PNGs from the ZIP (they aren't in the protobuf)
	if err := extractAtlas(tmpPath, dir); err != nil {
		return fmt.Errorf("extract atlas: %w", err)
	}

	// Update index
	s.mu.Lock()
	defer s.mu.Unlock()
	s.manifests[id] = p.Manifest
	s.cache[id] = p

	return nil
}

// Remove deletes a pack from disk and removes it from the index.
func (s *Store) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.manifests[id]; !ok {
		return fmt.Errorf("pack %q not found", id)
	}

	dir := filepath.Join(s.root, id)
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("remove pack dir: %w", err)
	}

	delete(s.manifests, id)
	delete(s.cache, id)
	return nil
}

// PackDir returns the on-disk directory for a pack ID.
func (s *Store) PackDir(id string) string {
	return filepath.Join(s.root, id)
}

// extractAtlas reads a .offpack ZIP and extracts any atlas/*.png files
// into the pack directory on disk.
func extractAtlas(zipPath, packDir string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()

	for _, f := range r.File {
		if !strings.HasPrefix(f.Name, "atlas/") || filepath.Ext(f.Name) != ".png" {
			continue
		}

		// Ensure atlas directory exists
		atlasDir := filepath.Join(packDir, "atlas")
		if err := os.MkdirAll(atlasDir, 0o755); err != nil {
			return err
		}

		// Extract the PNG
		rc, err := f.Open()
		if err != nil {
			return fmt.Errorf("open %s: %w", f.Name, err)
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return fmt.Errorf("read %s: %w", f.Name, err)
		}

		outPath := filepath.Join(packDir, filepath.FromSlash(f.Name))
		if err := os.WriteFile(outPath, data, 0o644); err != nil {
			return fmt.Errorf("write %s: %w", f.Name, err)
		}
		log.Printf("packstore: extracted %s", f.Name)
	}
	return nil
}
