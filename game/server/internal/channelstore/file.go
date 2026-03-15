package channelstore

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// FileStore is a Store backed by one JSON file per channel on disk.
// Files are stored as {dir}/{safeName}.json where safeName is the channel
// name with the leading "#" stripped.
type FileStore struct {
	dir string
}

// Compile-time check that FileStore implements Store.
var _ Store = (*FileStore)(nil)

// NewFileStore creates a FileStore backed by the given directory.
// The directory is created if it doesn't exist on first write.
func NewFileStore(dir string) *FileStore {
	return &FileStore{dir: dir}
}

// List reads all .json files from the directory and returns their configs.
func (s *FileStore) List() ([]*ChannelConfig, error) {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return nil, fmt.Errorf("channelstore: mkdir %s: %w", s.dir, err)
	}

	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, fmt.Errorf("channelstore: readdir %s: %w", s.dir, err)
	}

	var result []*ChannelConfig
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}

		data, err := os.ReadFile(filepath.Join(s.dir, e.Name()))
		if err != nil {
			log.Printf("channelstore: skip %s: %v", e.Name(), err)
			continue
		}

		var cfg ChannelConfig
		if err := json.Unmarshal(data, &cfg); err != nil {
			log.Printf("channelstore: skip %s: %v", e.Name(), err)
			continue
		}

		if cfg.Channel == "" || cfg.PackID == "" {
			log.Printf("channelstore: skip %s: missing channel or packId", e.Name())
			continue
		}

		result = append(result, &cfg)
	}

	return result, nil
}

// Get reads a single channel config from disk.
func (s *FileStore) Get(channel string) (*ChannelConfig, error) {
	path := filepath.Join(s.dir, safeName(channel)+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("channelstore: read %s: %w", path, err)
	}

	var cfg ChannelConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("channelstore: unmarshal %s: %w", path, err)
	}
	return &cfg, nil
}

// Save writes a channel config to disk as a JSON file.
func (s *FileStore) Save(cfg *ChannelConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("channelstore: marshal: %w", err)
	}

	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return fmt.Errorf("channelstore: mkdir: %w", err)
	}

	path := filepath.Join(s.dir, safeName(cfg.Channel)+".json")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("channelstore: write %s: %w", path, err)
	}

	return nil
}

// Remove deletes a channel config file from disk.
func (s *FileStore) Remove(channel string) error {
	path := filepath.Join(s.dir, safeName(channel)+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("channelstore: remove %s: %w", path, err)
	}
	return nil
}

// safeName converts a channel name (e.g. "#lobby") to a filesystem-safe name ("lobby").
func safeName(channel string) string {
	return strings.TrimPrefix(channel, "#")
}
