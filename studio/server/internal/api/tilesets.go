package api

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
)

// TilesetMeta holds scanned tileset information keyed by content hash.
type TilesetMeta struct {
	Hash       string `json:"id"`
	Label      string `json:"label"`
	RelPath    string `json:"path"` // relative to tilesets/, used as URL path
	TileWidth  int    `json:"tileWidth"`
	TileHeight int    `json:"tileHeight"`
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
	Width      int    `json:"width"`  // full image width in pixels
	Height     int    `json:"height"` // full image height in pixels
}

// TilesetService scans {workspacesDir}/{workspaceId}/tilesets/ and serves tileset
// metadata and images. Results are cached per-workspace in memory.
type TilesetService struct {
	studioDir string // absolute path to workspaces root (e.g. "data/studio/workspaces")

	mu    sync.RWMutex
	cache map[string]map[string]*TilesetMeta // workspaceID → hash → meta
}

// NewTilesetService creates a workspace-aware tileset service.
// studioDir is the workspaces root directory containing all workspace subdirs.
func NewTilesetService(studioDir string) *TilesetService {
	return &TilesetService{
		studioDir: studioDir,
		cache:     make(map[string]map[string]*TilesetMeta),
	}
}

// tilesetDir returns the tilesets directory for a given workspace.
func (s *TilesetService) tilesetDir(workspaceID string) string {
	return filepath.Join(s.studioDir, workspaceID, "tilesets")
}

// dimPattern matches the WxH suffix in filenames: e.g. "Room_Builder_48x48.png" → 48, 48
var dimPattern = regexp.MustCompile(`(\d+)x(\d+)`)

// Scan walks the tilesets directory for a workspace and rebuilds the cache.
func (s *TilesetService) Scan(workspaceID string) error {
	dir := s.tilesetDir(workspaceID)
	found := make(map[string]*TilesetMeta)

	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".png" && ext != ".jpg" && ext != ".jpeg" {
			return nil
		}

		meta, err := s.scanFile(dir, path)
		if err != nil {
			return nil // skip unreadable files
		}
		found[meta.Hash] = meta
		return nil
	})
	if err != nil {
		return fmt.Errorf("scan tilesets: %w", err)
	}

	s.mu.Lock()
	s.cache[workspaceID] = found
	s.mu.Unlock()
	return nil
}

func (s *TilesetService) scanFile(tilesetDir, absPath string) (*TilesetMeta, error) {
	f, err := os.Open(absPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// Hash and decode image config in one pass using TeeReader
	h := sha256.New()
	tr := io.TeeReader(f, h)
	cfg, _, err := image.DecodeConfig(tr)
	if err != nil {
		return nil, fmt.Errorf("decode image config %s: %w", absPath, err)
	}
	// Drain remaining bytes into the hash
	_, _ = io.Copy(h, tr)
	hash := hex.EncodeToString(h.Sum(nil))[:16] // first 16 hex chars

	// Parse tile dimensions from filename: "Name_WxH.png"
	stem := strings.TrimSuffix(filepath.Base(absPath), filepath.Ext(absPath))
	tileW, tileH := parseTileDims(stem)

	relPath, _ := filepath.Rel(tilesetDir, absPath)

	cols, rows := 0, 0
	if tileW > 0 && tileH > 0 {
		cols = cfg.Width / tileW
		rows = cfg.Height / tileH
	}

	return &TilesetMeta{
		Hash:       hash,
		Label:      stem,
		RelPath:    filepath.ToSlash(relPath),
		TileWidth:  tileW,
		TileHeight: tileH,
		Cols:       cols,
		Rows:       rows,
		Width:      cfg.Width,
		Height:     cfg.Height,
	}, nil
}

// parseTileDims extracts the last WxH match from the filename stem.
func parseTileDims(stem string) (w, h int) {
	matches := dimPattern.FindAllStringSubmatch(stem, -1)
	if len(matches) == 0 {
		return 0, 0
	}
	last := matches[len(matches)-1]
	w, _ = strconv.Atoi(last[1])
	h, _ = strconv.Atoi(last[2])
	return w, h
}

// All returns a copy of all cached tilesets for a workspace.
func (s *TilesetService) All(workspaceID string) []*TilesetMeta {
	s.mu.RLock()
	defer s.mu.RUnlock()
	wsCache := s.cache[workspaceID]
	out := make([]*TilesetMeta, 0, len(wsCache))
	for _, m := range wsCache {
		out = append(out, m)
	}
	return out
}

// ByHash looks up a tileset by hash within a workspace.
func (s *TilesetService) ByHash(workspaceID, hash string) (*TilesetMeta, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	wsCache := s.cache[workspaceID]
	if wsCache == nil {
		return nil, false
	}
	m, ok := wsCache[hash]
	return m, ok
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

func (h *Handlers) listTilesets(w http.ResponseWriter, r *http.Request) {
	wsID := ownerID(r)
	// Rescan on every request for now; Phase 2 will use the RAG index instead.
	if err := h.tilesets.Scan(wsID); err != nil {
		writeError(w, http.StatusInternalServerError, "SCAN_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, h.tilesets.All(wsID))
}

func (h *Handlers) getTileset(w http.ResponseWriter, r *http.Request) {
	wsID := ownerID(r)
	hash := chi.URLParam(r, "hash")
	meta, ok := h.tilesets.ByHash(wsID, hash)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "tileset not found")
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (h *Handlers) getTilesetImage(w http.ResponseWriter, r *http.Request) {
	wsID := ownerID(r)
	hash := chi.URLParam(r, "hash")
	meta, ok := h.tilesets.ByHash(wsID, hash)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "tileset not found")
		return
	}

	absPath := filepath.Join(h.tilesets.tilesetDir(wsID), filepath.FromSlash(meta.RelPath))
	http.ServeFile(w, r, absPath)
}
