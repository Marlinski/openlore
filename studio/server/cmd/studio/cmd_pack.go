package main

import (
	"fmt"
	"log"
	"path/filepath"

	"github.com/offisims/shared/pack"
	"github.com/offisims/studio/internal/config"
	"github.com/spf13/cobra"
)

var (
	flagPackWorkspace string
	flagPackName      string
	flagPackID        string
	flagPackOutput    string
	flagPackFormat    string
	flagPackRaw       bool
)

var packCmd = &cobra.Command{
	Use:   "pack",
	Short: "Compile a workspace into an optimized pack",
	Long: `Compiles workspace assets into an optimized pack with atlas textures.

By default, the compiler:
  1. Scans tileset PNGs from {workspace}/tilesets/
  2. Reads resources, composites, and rooms from workspace JSON files
  3. Collects every unique pixel region referenced by entities
  4. Generates minimal atlas PNGs (one per source tileset with used regions)
  5. Writes compiled resources/rooms with remapped atlas coordinates
  6. Writes a manifest.json index

Output goes to {workspace}/packs/{id}/ by default.

Use --raw to skip atlas compilation and bundle raw entities instead (supports
zip, binary, and json directory formats).`,
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg := config.New(0, flagStudioDir)
		wsDir := cfg.WorkspaceDir(flagPackWorkspace)

		if flagPackRaw {
			return packRaw(wsDir)
		}
		return packCompile(wsDir)
	},
}

func init() {
	packCmd.Flags().StringVar(&flagPackWorkspace, "workspace", "default", "workspace ID to pack")
	packCmd.Flags().StringVar(&flagPackID, "id", "default", "pack ID")
	packCmd.Flags().StringVar(&flagPackName, "name", "Default Pack", "pack display name")
	packCmd.Flags().StringVarP(&flagPackOutput, "output", "o", "", "output path (default: {workspace}/packs/<id>)")
	packCmd.Flags().StringVarP(&flagPackFormat, "format", "f", "json", "raw mode format: zip, binary, json")
	packCmd.Flags().BoolVar(&flagPackRaw, "raw", false, "skip atlas compilation, bundle raw entities")
}

// packCompile runs the atlas compiler pipeline.
func packCompile(wsDir string) error {
	outDir := flagPackOutput
	if outDir == "" {
		outDir = filepath.Join(wsDir, "packs", flagPackID)
	}

	log.Printf("compiling workspace: %s → %s", wsDir, outDir)
	_, result, err := pack.Compile(wsDir, outDir, flagPackID, flagPackName)
	if err != nil {
		return fmt.Errorf("compile: %w", err)
	}

	log.Printf("compiled: %s", result)
	return nil
}

// packRaw bundles raw entities without atlas compilation.
func packRaw(wsDir string) error {
	log.Printf("reading workspace (raw): %s (id=%s)", wsDir, flagPackWorkspace)
	p, err := pack.Open(wsDir)
	if err != nil {
		return fmt.Errorf("open workspace data: %w", err)
	}

	// Override manifest fields.
	if p.Manifest == nil {
		tmp := pack.New(flagPackID, flagPackName)
		p.Pack.Manifest = tmp.Manifest
	} else {
		p.Manifest.Id = flagPackID
		p.Manifest.Name = flagPackName
	}

	stats := fmt.Sprintf(
		"tilesets=%d composites=%d rooms=%d resources=%d masks=%d",
		len(p.Tilesets), len(p.Composites), len(p.Rooms),
		len(p.Resources), len(p.Masks),
	)
	log.Printf("pack contents: %s", stats)

	// Default output goes into {workspace}/packs/
	output := flagPackOutput
	packsDir := filepath.Join(wsDir, "packs")
	switch flagPackFormat {
	case "zip":
		if output == "" {
			output = filepath.Join(packsDir, flagPackID+".offpack")
		}
		if err := pack.WriteZip(output, p); err != nil {
			return fmt.Errorf("write zip: %w", err)
		}
		log.Printf("wrote %s (zip/offpack)", output)

	case "binary":
		if output == "" {
			output = filepath.Join(packsDir, flagPackID+".pb")
		}
		if err := pack.WriteBinary(output, p); err != nil {
			return fmt.Errorf("write binary: %w", err)
		}
		log.Printf("wrote %s (binary protobuf)", output)

	case "json":
		if output == "" {
			output = filepath.Join(packsDir, flagPackID)
		}
		if err := pack.Write(output, p); err != nil {
			return fmt.Errorf("write json dir: %w", err)
		}
		log.Printf("wrote %s/ (json directory)", output)

	default:
		return fmt.Errorf("unknown format %q — use zip, binary, or json", flagPackFormat)
	}

	return nil
}
