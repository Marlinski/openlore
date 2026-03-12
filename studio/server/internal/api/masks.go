package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	pb "github.com/offisims/shared/pack/pb/packv1"
	"github.com/offisims/studio/internal/store"
)

func (h *Handlers) listMasks(w http.ResponseWriter, r *http.Request) {
	items, err := h.masks.List(r.Context(), store.Filter{OwnerID: ownerID(r)})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "LIST_FAILED", err.Error())
		return
	}
	writeProtoList(w, http.StatusOK, items)
}

func (h *Handlers) getMask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	item, err := h.masks.Get(r.Context(), ownerID(r), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "mask not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "GET_FAILED", err.Error())
		return
	}
	writeProto(w, http.StatusOK, item)
}

func (h *Handlers) putMask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	item := &pb.Mask{}
	if err := decodeProto(r, item); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	item.Id = id
	saved, err := h.masks.Put(r.Context(), ownerID(r), item)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "PUT_FAILED", err.Error())
		return
	}
	writeProto(w, http.StatusOK, saved)
}

func (h *Handlers) deleteMask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	err := h.masks.Delete(r.Context(), ownerID(r), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "mask not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DELETE_FAILED", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
