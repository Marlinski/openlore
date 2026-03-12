package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/offisims/studio/internal/workspace"
)

// workspaceHandlers holds workspace management endpoints.
// These are root-level (not workspace-scoped) — they manage workspaces themselves.
type workspaceHandlers struct {
	mgr workspace.Manager
}

func (h *workspaceHandlers) list(w http.ResponseWriter, r *http.Request) {
	items, err := h.mgr.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "LIST_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (h *workspaceHandlers) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	info, err := h.mgr.Get(r.Context(), id)
	if errors.Is(err, workspace.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "workspace not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "GET_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (h *workspaceHandlers) create(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "READ_FAILED", err.Error())
		return
	}

	var body struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusBadRequest, "MISSING_NAME", "workspace name is required")
		return
	}

	info, err := h.mgr.Create(r.Context(), body.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "CREATE_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, info)
}

func (h *workspaceHandlers) remove(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	err := h.mgr.Delete(r.Context(), id)
	if errors.Is(err, workspace.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "workspace not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DELETE_FAILED", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
