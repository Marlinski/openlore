package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	pb "github.com/openlore/shared/pack/pb/packv1"
	"github.com/openlore/studio/internal/store"
)

func (h *Handlers) listResources(w http.ResponseWriter, r *http.Request) {
	items, err := h.resources.List(r.Context(), store.Filter{OwnerID: ownerID(r)})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "LIST_FAILED", err.Error())
		return
	}
	writeProtoList(w, http.StatusOK, items)
}

func (h *Handlers) getResource(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	item, err := h.resources.Get(r.Context(), ownerID(r), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "resource not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "GET_FAILED", err.Error())
		return
	}
	writeProto(w, http.StatusOK, item)
}

func (h *Handlers) putResource(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	item := &pb.Resource{}
	if err := decodeProto(r, item); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	item.Id = id // URL param is authoritative
	saved, err := h.resources.Put(r.Context(), ownerID(r), item)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "PUT_FAILED", err.Error())
		return
	}
	writeProto(w, http.StatusOK, saved)
}

func (h *Handlers) deleteResource(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	err := h.resources.Delete(r.Context(), ownerID(r), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "resource not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DELETE_FAILED", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
