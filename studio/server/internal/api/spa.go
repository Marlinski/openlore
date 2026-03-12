package api

import (
	"io/fs"
	"net/http"
	"strings"
)

// SPAHandler serves an embedded SPA filesystem.
// For requests matching real files it serves the file directly.
// For everything else it serves index.html (client-side routing).
type SPAHandler struct {
	fs     http.Handler
	root   fs.FS
	active bool // false when no real frontend is embedded
}

// NewSPAHandler creates a handler that serves the given filesystem as a SPA.
// If the FS is nil or contains no index.html the handler serves a placeholder.
func NewSPAHandler(embedded fs.FS) *SPAHandler {
	if embedded == nil {
		return &SPAHandler{active: false}
	}
	// Check if index.html exists (distinguishes real build from .gitkeep placeholder).
	if _, err := fs.Stat(embedded, "index.html"); err != nil {
		return &SPAHandler{active: false}
	}
	return &SPAHandler{
		fs:     http.FileServerFS(embedded),
		root:   embedded,
		active: true,
	}
}

func (s *SPAHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.active {
		http.Error(w, "Studio frontend not embedded. Run the Vite dev server on :5173.", http.StatusNotFound)
		return
	}

	// Try to serve the exact file. If it exists, serve it.
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}

	if _, err := fs.Stat(s.root, path); err == nil {
		s.fs.ServeHTTP(w, r)
		return
	}

	// File not found — serve index.html for SPA client-side routing.
	r.URL.Path = "/"
	s.fs.ServeHTTP(w, r)
}
