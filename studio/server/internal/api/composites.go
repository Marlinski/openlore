package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	pb "github.com/openlore/shared/pack/pb/packv1"
	"github.com/openlore/studio/internal/store"
)

func (h *Handlers) listComposites(w http.ResponseWriter, r *http.Request) {
	items, err := h.composites.List(r.Context(), store.Filter{OwnerID: ownerID(r)})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "LIST_FAILED", err.Error())
		return
	}
	writeProtoList(w, http.StatusOK, items)
}

func (h *Handlers) getComposite(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	item, err := h.composites.Get(r.Context(), ownerID(r), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "composite not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "GET_FAILED", err.Error())
		return
	}
	writeProto(w, http.StatusOK, item)
}

func (h *Handlers) putComposite(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	item := &pb.CompositeObject{}
	if err := decodeProto(r, item); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	item.Id = id
	saved, err := h.composites.Put(r.Context(), ownerID(r), item)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "PUT_FAILED", err.Error())
		return
	}
	writeProto(w, http.StatusOK, saved)
}

func (h *Handlers) deleteComposite(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	err := h.composites.Delete(r.Context(), ownerID(r), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "composite not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DELETE_FAILED", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
