package config

import (
	"os"
	"path/filepath"
)

// Config holds all Studio server configuration.
// StudioDir is the root directory containing all studio data:
//
//	{StudioDir}/workspaces/{workspaceID}/   — per-workspace data
//	{StudioDir}/rag_vectors.json            — shared RAG vector store
type Config struct {
	Port      int
	StudioDir string // e.g. "data/studio"

	// EmbedderURL is the base URL of the external CLIP embedding server
	// (e.g. "http://localhost:7997"). Empty = RAG disabled.
	EmbedderURL string

	// EmbedderModel is the model identifier sent in embedding requests.
	EmbedderModel string
}

// New creates a Config from a studio root directory.
func New(port int, studioDir string) *Config {
	return &Config{
		Port:          port,
		StudioDir:     studioDir,
		EmbedderURL:   "http://localhost:7997",
		EmbedderModel: "openai/clip-vit-base-patch32",
	}
}

// WorkspaceDir returns the absolute path for a given workspace.
func (c *Config) WorkspaceDir(workspaceID string) string {
	return filepath.Join(c.StudioDir, "workspaces", workspaceID)
}

// WorkspacesDir returns the directory containing all workspaces.
func (c *Config) WorkspacesDir() string {
	return filepath.Join(c.StudioDir, "workspaces")
}

// VectorStorePath returns the path to the shared RAG vector store.
func (c *Config) VectorStorePath() string {
	return filepath.Join(c.StudioDir, "rag_vectors.json")
}

// DefaultStudioDir resolves the studio root from env or filesystem heuristics.
func DefaultStudioDir() string {
	if d := os.Getenv("STUDIO_DIR"); d != "" {
		return d
	}
	// Dev default: repo root data/studio
	if _, err := os.Stat("data/studio"); err == nil {
		abs, _ := filepath.Abs("data/studio")
		return abs
	}
	// Fallback: CWD/data/studio
	abs, _ := filepath.Abs(filepath.Join("data", "studio"))
	return abs
}
