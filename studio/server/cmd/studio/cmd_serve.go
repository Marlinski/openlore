package main

import (
	"fmt"
	"io/fs"
	"log"
	"net/http"

	pb "github.com/offisims/shared/pack/pb/packv1"
	"github.com/offisims/studio/internal/api"
	"github.com/offisims/studio/internal/config"
	"github.com/offisims/studio/internal/rag"
	httpemb "github.com/offisims/studio/internal/rag/embedder/http"
	defaultidx "github.com/offisims/studio/internal/rag/indexer"
	flatvec "github.com/offisims/studio/internal/rag/vector/flat"
	fsstore "github.com/offisims/studio/internal/store/fs"
	fsworkspace "github.com/offisims/studio/internal/workspace/fs"
	"github.com/spf13/cobra"
)

var flagPort int

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the Studio HTTP server",
	Long: `Starts the Studio API server with CRUD endpoints, tileset serving,
optional RAG search, and embedded frontend. Serves multiple workspaces
from the studio root directory. All routes are workspace-scoped:
  /{workspaceId}/api/resources, /{workspaceId}/data/tilesets/..., etc.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg := config.New(flagPort, flagStudioDir)
		wsBase := cfg.WorkspacesDir() // workspaces base for stores

		ragSvc := buildRAG(cfg)
		wsMgr := fsworkspace.New(cfg.StudioDir)

		handlers := api.NewHandlers(
			cfg,
			fsstore.New(wsBase, "resources", func() *pb.Resource { return &pb.Resource{} }, func(r *pb.Resource) string { return r.Id }),
			fsstore.New(wsBase, "composites", func() *pb.CompositeObject { return &pb.CompositeObject{} }, func(c *pb.CompositeObject) string { return c.Id }),
			fsstore.New(wsBase, "rooms", func() *pb.RoomDefinition { return &pb.RoomDefinition{} }, func(r *pb.RoomDefinition) string { return r.Name }),
			fsstore.New(wsBase, "masks", func() *pb.Mask { return &pb.Mask{} }, func(m *pb.Mask) string { return m.Id }),
			api.NewTilesetService(wsBase),
			ragSvc,
			wsMgr,
		)

		router := api.NewRouter(cfg, handlers, frontendFS())

		addr := fmt.Sprintf(":%d", cfg.Port)
		log.Printf("studio server listening on http://localhost%s", addr)
		log.Printf("studio dir: %s", cfg.StudioDir)

		if err := http.ListenAndServe(addr, router); err != nil {
			return fmt.Errorf("server error: %w", err)
		}
		return nil
	},
}

func init() {
	serveCmd.Flags().IntVarP(&flagPort, "port", "p", 4000, "HTTP listen port")
}

// frontendFS returns the embedded Preact build as an fs.FS rooted at "dist/".
// Returns nil if no real build is embedded (dev mode — only .gitkeep present).
func frontendFS() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return nil
	}
	// Check for index.html to distinguish real build from placeholder.
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil
	}
	log.Println("embedded frontend detected — serving SPA at /")
	return sub
}

// buildRAG wires the HTTP CLIP embedder + flat vector store + DefaultIndexer.
// Returns nil (graceful degradation) if the embedder URL is not configured.
// The vector store is shared across all workspaces (ownerID namespacing).
func buildRAG(cfg *config.Config) api.RAGService {
	if cfg.EmbedderURL == "" {
		log.Println("[rag] no embedder URL configured — RAG disabled")
		return nil
	}

	emb := httpemb.New(cfg.EmbedderURL, cfg.EmbedderModel)

	// Shared vector store at {studioDir}/rag_vectors.json
	vecPath := cfg.VectorStorePath()
	vec, err := flatvec.New(vecPath)
	if err != nil {
		log.Printf("[rag] vector store init failed: %v — RAG disabled", err)
		return nil
	}

	idx := defaultidx.New(cfg.WorkspacesDir(), emb, vec)
	svc := rag.New(vec, emb, idx)

	log.Printf("[rag] RAG service ready (embedder=%s store=%s)", cfg.EmbedderURL, vecPath)
	return svc
}
