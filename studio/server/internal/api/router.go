package api

import (
	"io/fs"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	pb "github.com/offisims/shared/pack/pb/packv1"
	"github.com/offisims/studio/internal/config"
	"github.com/offisims/studio/internal/store"
	"github.com/offisims/studio/internal/workspace"
)

// Handlers holds all injected dependencies for HTTP handlers.
type Handlers struct {
	cfg        *config.Config
	resources  store.Store[*pb.Resource]
	composites store.Store[*pb.CompositeObject]
	rooms      store.Store[*pb.RoomDefinition]
	masks      store.Store[*pb.Mask]
	tilesets   *TilesetService
	rag        RAGService // nil when CLIP models are not available
	workspaces workspace.Manager
}

// NewHandlers constructs Handlers with all dependencies.
func NewHandlers(
	cfg *config.Config,
	resources store.Store[*pb.Resource],
	composites store.Store[*pb.CompositeObject],
	rooms store.Store[*pb.RoomDefinition],
	masks store.Store[*pb.Mask],
	tilesets *TilesetService,
	rag RAGService,
	workspaces workspace.Manager,
) *Handlers {
	return &Handlers{
		cfg:        cfg,
		resources:  resources,
		composites: composites,
		rooms:      rooms,
		masks:      masks,
		tilesets:   tilesets,
		rag:        rag,
		workspaces: workspaces,
	}
}

// NewRouter wires all HTTP handlers onto a chi router.
// frontendFS may be nil in dev mode (frontend served by Vite).
//
// All workspace-scoped routes live under /{workspaceId}/...
// The workspace ID is extracted from the URL and injected into context.
func NewRouter(cfg *config.Config, h *Handlers, frontendFS fs.FS) http.Handler {
	r := chi.NewRouter()

	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware)

	// ── Root-level workspace management ─────────────────────────────────
	// These endpoints are NOT workspace-scoped — they manage workspaces themselves.
	// Future multi-user: add auth middleware here to scope by user.
	wsH := &workspaceHandlers{mgr: h.workspaces}
	r.Route("/api/workspaces", func(api chi.Router) {
		api.Get("/", wsH.list)
		api.Post("/", wsH.create)
		api.Get("/{id}", wsH.get)
		api.Delete("/{id}", wsH.remove)
	})

	// ── Workspace-scoped routes ──────────────────────────────────────────
	r.Route("/{workspaceId}", func(ws chi.Router) {
		ws.Use(WorkspaceMiddleware)

		// ── Status ────────────────────────────────────────────────────
		ws.Get("/api/status", func(w http.ResponseWriter, req *http.Request) {
			ragOK := h.rag != nil
			payload := map[string]any{"ok": true, "rag": ragOK}
			if ragOK {
				if stats, err := h.rag.Stats(req.Context(), ownerID(req)); err == nil {
					payload["stats"] = stats
				}
			}
			writeJSON(w, http.StatusOK, payload)
		})

		// ── Resources ────────────────────────────────────────────────
		ws.Get("/api/resources", h.listResources)
		ws.Get("/api/resources/{id}", h.getResource)
		ws.Put("/api/resources/{id}", h.putResource)
		ws.Delete("/api/resources/{id}", h.deleteResource)

		// ── Composites ───────────────────────────────────────────────
		ws.Get("/api/composites", h.listComposites)
		ws.Get("/api/composites/{id}", h.getComposite)
		ws.Put("/api/composites/{id}", h.putComposite)
		ws.Delete("/api/composites/{id}", h.deleteComposite)

		// ── Rooms ────────────────────────────────────────────────────
		ws.Get("/api/rooms", h.listRooms)
		ws.Get("/api/rooms/{name}", h.getRoom)
		ws.Put("/api/rooms/{name}", h.putRoom)
		ws.Delete("/api/rooms/{name}", h.deleteRoom)

		// ── Masks ────────────────────────────────────────────────────
		ws.Get("/api/masks", h.listMasks)
		ws.Get("/api/masks/{id}", h.getMask)
		ws.Put("/api/masks/{id}", h.putMask)
		ws.Delete("/api/masks/{id}", h.deleteMask)

		// ── Tilesets ─────────────────────────────────────────────────
		ws.Get("/api/tilesets", h.listTilesets)
		ws.Get("/api/tilesets/{hash}", h.getTileset)
		ws.Get("/api/tilesets/{hash}/image", h.getTilesetImage)

		// ── RAG ──────────────────────────────────────────────────────
		ws.Get("/api/search", h.search)
		ws.Get("/api/similar", h.similar)
		ws.Get("/api/tags", h.tags)
		ws.Post("/api/reindex", h.reindex)

		// ── Static data assets ───────────────────────────────────────
		ws.Get("/data/*", h.serveData)
	})

	// ── Embedded SPA frontend ────────────────────────────────────────────
	// The SPA catches all unmatched routes and handles client-side routing.
	spa := NewSPAHandler(frontendFS)
	r.NotFound(spa.ServeHTTP)

	return r
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		// Allow Vite dev server and same-origin (embedded mode has no Origin).
		if origin == "http://localhost:5173" || origin == "http://localhost:4000" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, DELETE, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
