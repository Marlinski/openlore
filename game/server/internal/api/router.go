package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/offisims/game/internal/config"
	"github.com/offisims/game/internal/game"
	"github.com/offisims/game/internal/packstore"
	"github.com/offisims/game/internal/transport"
	"nhooyr.io/websocket"
)

// Handlers holds all injected dependencies for HTTP handlers.
type Handlers struct {
	cfg     *config.Config
	packs   *packstore.Store
	worlds  *game.Store
	players *game.PlayerStore
}

func NewHandlers(cfg *config.Config, packs *packstore.Store, worlds *game.Store, players *game.PlayerStore) *Handlers {
	return &Handlers{cfg: cfg, packs: packs, worlds: worlds, players: players}
}

// NewRouter wires all HTTP handlers onto a chi router.
func NewRouter(cfg *config.Config, h *Handlers) http.Handler {
	r := chi.NewRouter()

	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware)

	// ── Status ────────────────────────────────────────────────────────────
	r.Get("/api/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":       true,
			"phase":    5,
			"packs":    h.packs.Count(),
			"sessions": h.worlds.Count(),
		})
	})

	// ── Sessions (backed by game.Store of Worlds) ────────────────────────
	r.Get("/api/sessions", h.listSessions)
	r.Post("/api/sessions", h.createSession)
	r.Delete("/api/sessions/{id}", h.deleteSession)

	// ── Session-scoped game data ─────────────────────────────────────────
	r.Get("/api/sessions/{id}/game-data", h.getSessionGameData)
	r.Get("/api/sessions/{id}/rooms", h.listSessionRooms)
	r.Get("/api/sessions/{id}/rooms/{name}", h.getSessionRoom)

	// ── Player ────────────────────────────────────────────────────────────
	r.Post("/api/register", h.registerPlayer)
	r.Get("/api/session", h.getSession)

	// ── Packs ─────────────────────────────────────────────────────────────
	r.Get("/api/packs", h.listPacks)
	r.Get("/api/packs/{id}", h.getPack)
	r.Post("/api/packs/{id}/install", h.installPack)
	r.Delete("/api/packs/{id}", h.removePack)

	// ── Game data (backward compat — reads from default pack) ─────────────
	r.Get("/api/game-data", h.getGameData)

	// ── Rooms (backward compat — reads from default pack) ─────────────────
	r.Get("/api/rooms", h.listRooms)
	r.Get("/api/rooms/{name}", h.getRoom)

	// ── WebSocket ─────────────────────────────────────────────────────────
	r.Get("/ws", h.serveWS)

	// ── Static data assets ────────────────────────────────────────────────
	r.Get("/data/*", h.serveData)

	return r
}

// ─── Player endpoints ────────────────────────────────────────────────────────

// registerPlayer registers a new player and returns a token.
// POST /api/register  body: { name, characterId } → { token, name, characterId }
func (h *Handlers) registerPlayer(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string `json:"name"`
		CharacterID string `json:"characterId"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON: "+err.Error())
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "name is required")
		return
	}

	rec := h.players.Register(req.Name, req.CharacterID)
	writeJSON(w, http.StatusCreated, map[string]string{
		"token":       rec.Token,
		"name":        rec.Name,
		"characterId": rec.CharacterID,
	})
}

// getSession validates a player token and returns player info + the default world metadata.
// GET /api/session?token=<token> → { token, name, characterId, session }
func (h *Handlers) getSession(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "token query param required")
		return
	}

	rec := h.players.GetByToken(token)
	if rec == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "invalid or expired token")
		return
	}

	result := map[string]any{
		"token":       rec.Token,
		"name":        rec.Name,
		"characterId": rec.CharacterID,
	}

	// Include default world metadata if available
	if dw := h.worlds.Default(); dw != nil {
		result["session"] = dw.Meta()
	}

	writeJSON(w, http.StatusOK, result)
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

// serveWS upgrades the connection to WebSocket and starts a read loop.
// Reads ?session= query param to route to the correct world.
// Falls back to the single running world if no param is given.
func (h *Handlers) serveWS(w http.ResponseWriter, r *http.Request) {
	// Resolve the target world
	sessionID := r.URL.Query().Get("session")
	var world *game.World
	if sessionID != "" {
		world = h.worlds.Get(sessionID)
		if world == nil {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}
	} else {
		world = h.worlds.Default()
		if world == nil {
			http.Error(w, "no session specified and no default session available", http.StatusBadRequest)
			return
		}
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"localhost:3002", "localhost:*"},
	})
	if err != nil {
		return
	}

	t := transport.NewWebSocketTransport(conn)

	onMessage := func(connID string, raw []byte) {
		world.Dispatch(transport.Envelope{
			ConnID:    connID,
			Transport: t,
			Raw:       raw,
		})
	}

	onClose := func(connID string) {
		world.Dispatch(transport.Envelope{
			ConnID:    connID,
			Transport: nil,
			Raw:       nil,
		})
	}

	t.ReadLoop(r.Context(), onMessage, onClose)
}
