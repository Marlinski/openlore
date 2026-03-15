package api

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/offisims/game/internal/channelstore"
	pb "github.com/offisims/shared/pack/pb/packv1"
	"google.golang.org/protobuf/proto"
)

// ── Channel endpoints (backed by game.Store of Worlds) ───────────────────────

// listChannels returns all active channels.
// GET /api/channels → []ChannelMeta
func (h *Handlers) listChannels(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.worlds.List())
}

// createChannel starts a new world for a channel, backed by a pack.
// POST /api/channels  body: { channel, packId } → ChannelMeta
func (h *Handlers) createChannel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Channel string `json:"channel"`
		PackID  string `json:"packId"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON: "+err.Error())
		return
	}
	if req.Channel == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "channel is required")
		return
	}
	if req.PackID == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "packId is required")
		return
	}

	// Normalise: ensure channel name starts with #
	channel := req.Channel
	if !strings.HasPrefix(channel, "#") {
		channel = "#" + channel
	}

	// Verify the pack exists
	p, err := h.packs.Get(req.PackID)
	if err != nil {
		writeError(w, http.StatusNotFound, "PACK_NOT_FOUND", "pack not found: "+req.PackID)
		return
	}

	world, err := h.worlds.Create(channel, req.PackID, p)
	if err != nil {
		writeError(w, http.StatusConflict, "CHANNEL_EXISTS", err.Error())
		return
	}

	// Persist to disk so it survives restarts
	if err := h.channels.Save(channelstore.NewChannelConfig(channel, req.PackID)); err != nil {
		// World is running but config failed to save — log but don't fail the request
		writeJSON(w, http.StatusCreated, world.Meta())
		return
	}

	writeJSON(w, http.StatusCreated, world.Meta())
}

// deleteChannel stops a running channel world and removes its persisted config.
// DELETE /api/channels/{channel} → 204
func (h *Handlers) deleteChannel(w http.ResponseWriter, r *http.Request) {
	channel := "#" + chi.URLParam(r, "channel")
	if err := h.worlds.Stop(channel); err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", err.Error())
		return
	}
	// Remove persisted config (best-effort)
	_ = h.channels.Remove(channel)
	w.WriteHeader(http.StatusNoContent)
}

// ── Channel-scoped game data ─────────────────────────────────────────────────

// getChannelGameData returns the full Pack from a channel's world as protojson.
// GET /api/channels/{channel}/game-data → Pack
func (h *Handlers) getChannelGameData(w http.ResponseWriter, r *http.Request) {
	channel := "#" + chi.URLParam(r, "channel")
	world := h.worlds.Get(channel)
	if world == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "channel not found: "+channel)
		return
	}
	writeProtoJSON(w, http.StatusOK, world.Pack.Pack)
}

// listChannelRooms returns all room definitions from a channel's pack.
// GET /api/channels/{channel}/rooms → RoomDefinition[]
func (h *Handlers) listChannelRooms(w http.ResponseWriter, r *http.Request) {
	channel := "#" + chi.URLParam(r, "channel")
	world := h.worlds.Get(channel)
	if world == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "channel not found: "+channel)
		return
	}
	rooms := world.Pack.GetRooms()
	msgs := make([]proto.Message, len(rooms))
	for i, room := range rooms {
		msgs[i] = room
	}
	writeProtoJSONList(w, http.StatusOK, msgs)
}

// getChannelRoom returns a single room by name from a channel's pack.
// GET /api/channels/{channel}/rooms/{name} → RoomDefinition
func (h *Handlers) getChannelRoom(w http.ResponseWriter, r *http.Request) {
	channel := "#" + chi.URLParam(r, "channel")
	world := h.worlds.Get(channel)
	if world == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "channel not found: "+channel)
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
