package main

import (
	"fmt"
	"os"

	"github.com/offisims/studio/internal/config"
	"github.com/spf13/cobra"
)

var (
	// Shared persistent flags.
	flagStudioDir string
)

var rootCmd = &cobra.Command{
	Use:   "studio",
	Short: "Offisims Studio — world editor and authoring tool",
	Long: `Offisims Studio provides an HTTP server for editing game assets
(rooms, resources, composites, masks) and tools for packing and indexing.
The server serves multiple workspaces from a studio root directory.
Each workspace is a subdirectory accessed via URL path prefix:
  /{workspaceId}/api/resources, /{workspaceId}/data/tilesets/..., etc.`,
	// No Run — requires a subcommand.
	SilenceUsage: true,
}

func init() {
	rootCmd.PersistentFlags().StringVar(&flagStudioDir, "studio-dir", config.DefaultStudioDir(), "studio root directory containing workspaces (env: STUDIO_DIR)")

	rootCmd.AddCommand(serveCmd)
	rootCmd.AddCommand(reindexCmd)
	rootCmd.AddCommand(packCmd)
}

func execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
