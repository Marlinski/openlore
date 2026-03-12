package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/offisims/studio/internal/config"
	httpemb "github.com/offisims/studio/internal/rag/embedder/http"
	defaultidx "github.com/offisims/studio/internal/rag/indexer"
	flatvec "github.com/offisims/studio/internal/rag/vector/flat"
	"github.com/spf13/cobra"
)

var flagReindexWorkspace string

var reindexCmd = &cobra.Command{
	Use:   "reindex",
	Short: "Run a one-shot RAG reindex for a workspace and exit",
	Long:  `Indexes all workspace assets (tilesets, resources, composites, rooms) into the RAG vector store, then exits. Requires the external CLIP embedding server to be running.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg := config.New(0, flagStudioDir)
		wsID := flagReindexWorkspace

		if cfg.EmbedderURL == "" {
			return fmt.Errorf("no embedder URL configured — cannot reindex")
		}

		emb := httpemb.New(cfg.EmbedderURL, cfg.EmbedderModel)

		// Shared vector store at {studioDir}/rag_vectors.json
		vecPath := cfg.VectorStorePath()
		vec, err := flatvec.New(vecPath)
		if err != nil {
			return fmt.Errorf("vector store init failed: %w", err)
		}
		defer vec.Close()

		idx := defaultidx.New(cfg.WorkspacesDir(), emb, vec)

		log.Printf("reindexing workspace: %s (dir=%s)", wsID, cfg.WorkspaceDir(wsID))
		log.Printf("embedder: %s", cfg.EmbedderURL)
		log.Printf("vector store: %s", vecPath)
		t0 := time.Now()

		ctx := context.Background()
		if err := idx.IndexAll(ctx, wsID); err != nil {
			return fmt.Errorf("reindex failed: %w", err)
		}

		stats, err := vec.Stats(ctx, wsID)
		if err != nil {
			stats = map[string]int{}
		}

		elapsed := time.Since(t0)
		log.Printf("reindex complete in %s", elapsed.Round(time.Millisecond))
		for kind, count := range stats {
			log.Printf("  %s: %d items", kind, count)
		}

		return nil
	},
}

func init() {
	reindexCmd.Flags().StringVar(&flagReindexWorkspace, "workspace", "default", "workspace ID to reindex")
}
