package api

import (
	"context"
	"net/http"
	"strconv"

	"github.com/openlore/studio/internal/rag/vector"
)

const defaultSearchLimit = 20
const maxSearchLimit = 100

// ─── RAGService interface (what Handlers needs) ───────────────────────────────

// RAGService is the interface that Handlers depends on for search and indexing.
// *rag.Service satisfies this interface; you can swap in a mock for tests.
type RAGService interface {
	Search(ctx context.Context, ownerID, query, kind string, k int) ([]vector.SearchResult, error)
	Similar(ctx context.Context, ownerID, id, kind string, k int) ([]vector.SearchResult, error)
	Tags(ctx context.Context, ownerID, prefix string, limit int) ([]string, error)
	Stats(ctx context.Context, ownerID string) (map[string]int, error)
	Reindex(ctx context.Context, ownerID string) (map[string]any, error)
}

// ─── Search handlers ─────────────────────────────────────────────────────────

// GET /api/search?q=&kind=&limit=
func (h *Handlers) search(w http.ResponseWriter, r *http.Request) {
	if h.rag == nil {
		writeError(w, http.StatusServiceUnavailable, "RAG not available", "RAG_UNAVAILABLE")
		return
	}
	q := r.URL.Query().Get("q")
	if q == "" {
		writeError(w, http.StatusBadRequest, "query param 'q' is required", "MISSING_QUERY")
		return
	}
	kind := r.URL.Query().Get("kind")
	k := parseLimit(r, defaultSearchLimit)

	results, err := h.rag.Search(r.Context(), ownerID(r), q, kind, k)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "SEARCH_ERROR")
		return
	}
	if results == nil {
		results = []vector.SearchResult{}
	}
	writeJSON(w, http.StatusOK, results)
}

// GET /api/similar?id=&kind=&limit=
func (h *Handlers) similar(w http.ResponseWriter, r *http.Request) {
	if h.rag == nil {
		writeError(w, http.StatusServiceUnavailable, "RAG not available", "RAG_UNAVAILABLE")
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "query param 'id' is required", "MISSING_ID")
		return
	}
	kind := r.URL.Query().Get("kind")
	k := parseLimit(r, defaultSearchLimit)

	results, err := h.rag.Similar(r.Context(), ownerID(r), id, kind, k)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "SIMILAR_ERROR")
		return
	}
	if results == nil {
		results = []vector.SearchResult{}
	}
	writeJSON(w, http.StatusOK, results)
}

// GET /api/tags?prefix=&limit=
func (h *Handlers) tags(w http.ResponseWriter, r *http.Request) {
	if h.rag == nil {
		writeError(w, http.StatusServiceUnavailable, "RAG not available", "RAG_UNAVAILABLE")
		return
	}
	prefix := r.URL.Query().Get("prefix")
	k := parseLimit(r, 50)

	tags, err := h.rag.Tags(r.Context(), ownerID(r), prefix, k)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "TAGS_ERROR")
		return
	}
	if tags == nil {
		tags = []string{}
	}
	writeJSON(w, http.StatusOK, tags)
}

// POST /api/reindex
func (h *Handlers) reindex(w http.ResponseWriter, r *http.Request) {
	if h.rag == nil {
		writeError(w, http.StatusServiceUnavailable, "RAG not available", "RAG_UNAVAILABLE")
		return
	}
	result, err := h.rag.Reindex(r.Context(), ownerID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "REINDEX_ERROR")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func parseLimit(r *http.Request, def int) int {
	s := r.URL.Query().Get("limit")
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return def
	}
	if n > maxSearchLimit {
		return maxSearchLimit
	}
	return n
}
