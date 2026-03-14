// hash.go — Deterministic content hash for a workspace directory.
//
// ContentHash walks a workspace directory, collecting all source files
// (tilesets/*.png recursively, resources/*.json, composites/*.json,
// rooms/*.json, masks/*.json) and computes a single SHA-256 digest.
//
// The hash is deterministic: file paths are sorted lexicographically
// and each (relative-path, file-SHA-256) pair is fed into the final
// hash in order. This means identical workspace contents always produce
// the same hash, regardless of filesystem ordering.

package pack

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ContentHash computes a deterministic SHA-256 content hash of a
// workspace directory. It hashes all source files that feed into
// pack compilation: tileset PNGs and entity JSON files.
//
// Returns the hex-encoded SHA-256 hash string.
func ContentHash(workspaceDir string) (string, error) {
	type entry struct {
		relPath string
		hash    [32]byte
	}

	var entries []entry

	// Subdirectories and their file extensions to include
	dirs := []struct {
		subdir    string
		ext       string
		recursive bool
	}{
		{"tilesets", ".png", true},
		{"resources", ".json", false},
		{"composites", ".json", false},
		{"rooms", ".json", false},
		{"masks", ".json", false},
	}

	for _, d := range dirs {
		dirPath := filepath.Join(workspaceDir, d.subdir)
		if _, err := os.Stat(dirPath); os.IsNotExist(err) {
			continue // skip missing directories
		}

		walkFn := func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if info.IsDir() {
				if !d.recursive && path != dirPath {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.EqualFold(filepath.Ext(path), d.ext) {
				return nil
			}

			rel, err := filepath.Rel(workspaceDir, path)
			if err != nil {
				return fmt.Errorf("rel path: %w", err)
			}
			// Normalise to forward slashes for cross-platform determinism
			rel = filepath.ToSlash(rel)

			h, err := hashFile(path)
			if err != nil {
				return fmt.Errorf("hash %s: %w", rel, err)
			}

			entries = append(entries, entry{relPath: rel, hash: h})
			return nil
		}

		if err := filepath.Walk(dirPath, walkFn); err != nil {
			return "", fmt.Errorf("walk %s: %w", d.subdir, err)
		}
	}

	// Sort by relative path for deterministic ordering
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].relPath < entries[j].relPath
	})

	// Final hash: feed sorted (path, fileHash) pairs
	h := sha256.New()
	for _, e := range entries {
		// Write path as length-prefixed to avoid ambiguity
		h.Write([]byte(e.relPath))
		h.Write([]byte{0}) // null separator
		h.Write(e.hash[:])
	}

	return hex.EncodeToString(h.Sum(nil)), nil
}

// hashFile returns the SHA-256 hash of a file's contents.
func hashFile(path string) ([32]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return [32]byte{}, err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return [32]byte{}, err
	}

	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out, nil
}
