package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	pb "github.com/offisims/shared/pack/pb/packv1"
	"github.com/offisims/studio/internal/store"
)

func (h *Handlers) listRooms(w http.ResponseWriter, r *http.Request) {
	items, err := h.rooms.List(r.Context(), store.Filter{OwnerID: ownerID(r)})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "LIST_FAILED", err.Error())
		return
	}
	writeProtoList(w, http.StatusOK, items)
}

func (h *Handlers) getRoom(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	item, err := h.rooms.Get(r.Context(), ownerID(r), name)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "room not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "GET_FAILED", err.Error())
		return
	}
	writeProto(w, http.StatusOK, item)
}

func (h *Handlers) putRoom(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	item := &pb.RoomDefinition{}
	if err := decodeProto(r, item); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	item.Name = name
	saved, err := h.rooms.Put(r.Context(), ownerID(r), item)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "PUT_FAILED", err.Error())
		return
	}
	writeProto(w, http.StatusOK, saved)
}

func (h *Handlers) deleteRoom(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	err := h.rooms.Delete(r.Context(), ownerID(r), name)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "room not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "DELETE_FAILED", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
