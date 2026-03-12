package api

import (
	"net/http"
	"path/filepath"
	"strings"
)

// serveData serves files from the game data directory with path traversal protection.
// URL: /data/{relPath} → {dataDir}/{relPath}
func (h *Handlers) serveData(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/data/")
	if rel == "" || strings.Contains(rel, "..") {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	abs := filepath.Join(h.cfg.DataDir, filepath.FromSlash(rel))

	if !strings.HasPrefix(abs, h.cfg.DataDir) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	http.ServeFile(w, r, abs)
}
