package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// listPacks returns manifests of all installed packs.
// GET /api/packs → []PackManifest
func (h *Handlers) listPacks(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.packs.List())
}

// getPack returns the manifest for a single pack.
// GET /api/packs/{id} → PackManifest
func (h *Handlers) getPack(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	m := h.packs.GetManifest(id)
	if m == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "pack not found: "+id)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

// installPack installs a pack from an uploaded .offpack ZIP.
// POST /api/packs/{id}/install  body: .offpack ZIP → 200
func (h *Handlers) installPack(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "pack id required")
		return
	}

	defer r.Body.Close()
	if err := h.packs.Install(id, r.Body); err != nil {
		writeError(w, http.StatusInternalServerError, "INSTALL_ERROR", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// removePack deletes an installed pack.
// DELETE /api/packs/{id} → 204
func (h *Handlers) removePack(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.packs.Remove(id); err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
