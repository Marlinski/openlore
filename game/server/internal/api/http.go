package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	pb "github.com/offisims/shared/pack/pb/packv1"
	"google.golang.org/protobuf/proto"
)

// ── Session-scoped endpoints (backed by game.Store of Worlds) ────────────────

// listSessions returns all active worlds (still called "sessions" in the API).
// GET /api/sessions → []WorldMeta
func (h *Handlers) listSessions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.worlds.List())
}

// createSession starts a new world backed by a pack.
// POST /api/sessions  body: { packId, name? } → WorldMeta
func (h *Handlers) createSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PackID string `json:"packId"`
		Name   string `json:"name"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON: "+err.Error())
		return
	}
	if req.PackID == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "packId is required")
		return
	}

	// Verify the pack exists
	p, err := h.packs.Get(req.PackID)
	if err != nil {
		writeError(w, http.StatusNotFound, "PACK_NOT_FOUND", "pack not found: "+req.PackID)
		return
	}

	id := h.worlds.GenerateID()
	world, err := h.worlds.Create(id, req.Name, req.PackID, p)
	if err != nil {
		writeError(w, http.StatusConflict, "SESSION_EXISTS", err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, world.Meta())
}

// deleteSession stops a running world.
// DELETE /api/sessions/{id} → 204
func (h *Handlers) deleteSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.worlds.Stop(id); err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── Session-scoped game data ─────────────────────────────────────────────────

// getSessionGameData returns the full Pack from a world's pack as protojson.
// GET /api/sessions/{id}/game-data → Pack
func (h *Handlers) getSessionGameData(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	world := h.worlds.Get(id)
	if world == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "session not found: "+id)
		return
	}
	writeProtoJSON(w, http.StatusOK, world.Pack.Pack)
}

// listSessionRooms returns all room definitions from a world's pack.
// GET /api/sessions/{id}/rooms → RoomDefinition[]
func (h *Handlers) listSessionRooms(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	world := h.worlds.Get(id)
	if world == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "session not found: "+id)
		return
	}
	rooms := world.Pack.GetRooms()
	msgs := make([]proto.Message, len(rooms))
	for i, room := range rooms {
		msgs[i] = room
	}
	writeProtoJSONList(w, http.StatusOK, msgs)
}

// getSessionRoom returns a single room by name from a world's pack.
// GET /api/sessions/{id}/rooms/{name} → RoomDefinition
func (h *Handlers) getSessionRoom(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	world := h.worlds.Get(id)
	if world == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "session not found: "+id)
		return
	}

	name := chi.URLParam(r, "name")
	for _, room := range world.Pack.GetRooms() {
		if room.GetName() == name {
			writeProtoJSON(w, http.StatusOK, room)
			return
		}
	}

	writeError(w, http.StatusNotFound, "NOT_FOUND", "room not found: "+name)
}

// ── Backward-compat endpoints (read from default pack) ───────────────────────

// defaultPack is the pack ID used by backward-compat endpoints
// (game-data, rooms) that predate multi-pack support.
const defaultPack = "default"

// getGameData returns the full Pack as protojson from the default pack.
// GET /api/game-data → Pack
func (h *Handlers) getGameData(w http.ResponseWriter, r *http.Request) {
	p, err := h.packs.Get(defaultPack)
	if err != nil {
		writeProtoJSON(w, http.StatusOK, &pb.Pack{})
		return
	}
	writeProtoJSON(w, http.StatusOK, p.Pack)
}

// listRooms returns all room definitions from the default pack.
// GET /api/rooms → RoomDefinition[]
func (h *Handlers) listRooms(w http.ResponseWriter, r *http.Request) {
	p, err := h.packs.Get(defaultPack)
	if err != nil {
		writeProtoJSONList(w, http.StatusOK, nil)
		return
	}
	rooms := p.GetRooms()
	msgs := make([]proto.Message, len(rooms))
	for i, room := range rooms {
		msgs[i] = room
	}
	writeProtoJSONList(w, http.StatusOK, msgs)
}

// getRoom returns a single room by name from the default pack.
// GET /api/rooms/{name} → RoomDefinition
func (h *Handlers) getRoom(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	p, err := h.packs.Get(defaultPack)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "room not found: "+name)
		return
	}

	for _, room := range p.GetRooms() {
		if room.GetName() == name {
			writeProtoJSON(w, http.StatusOK, room)
			return
		}
	}

	writeError(w, http.StatusNotFound, "NOT_FOUND", "room not found: "+name)
}
