package api

import (
	"net/http"
	"path/filepath"
	"strings"
)

// serveData serves files from the workspace directory with path traversal protection.
// URL: /{workspaceId}/data/{relPath} → {studioDir}/{workspaceId}/{relPath}
func (h *Handlers) serveData(w http.ResponseWriter, r *http.Request) {
	wsID := ownerID(r)
	wsDir := h.cfg.WorkspaceDir(wsID)

	// Strip the /{workspaceId}/data/ prefix to get the relative path.
	prefix := "/" + wsID + "/data/"
	rel := strings.TrimPrefix(r.URL.Path, prefix)
	if rel == "" || strings.Contains(rel, "..") {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	abs := filepath.Join(wsDir, filepath.FromSlash(rel))

	// Ensure the resolved path stays within workspace dir
	if !strings.HasPrefix(abs, wsDir) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	http.ServeFile(w, r, abs)
}
