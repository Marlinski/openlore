package api

import (
	"archive/zip"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/offisims/shared/pack"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// packBuild compiles the workspace into a compiled pack and .offpack file,
// streaming SSE progress events to the client. The compiled pack (atlas
// tilesets + remapped rooms/resources) is written to {workspace}/pack/
// and the .offpack bundle to {workspace}/packs/latest.offpack.
func (h *Handlers) packBuild(w http.ResponseWriter, r *http.Request) {
	wsID := ownerID(r)

	// SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // nginx passthrough

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "SSE_UNSUPPORTED", "streaming not supported")
		return
	}

	send := func(event, data string) {
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
		flusher.Flush()
	}

	// ── Fetch workspace metadata ───────────────────────────────────────
	send("progress", "Loading workspace metadata...")
	wsInfo, err := h.workspaces.Get(r.Context(), wsID)
	if err != nil {
		send("error", fmt.Sprintf("Failed to load workspace: %s", err))
		return
	}

	// ── Ensure tilesets are scanned ────────────────────────────────────
	send("progress", "Scanning tilesets...")
	if err := h.tilesets.Scan(wsID); err != nil {
		log.Printf("pack: tileset scan warning: %v", err)
	}

	// ── Compile pack (reads workspace dir, builds atlases, writes output) ──
	send("progress", "Compiling pack (generating atlases)...")
	wsDir := h.cfg.WorkspaceDir(wsID)
	compileOutDir := filepath.Join(wsDir, "pack")
	compiledPack, compileResult, err := pack.Compile(wsDir, compileOutDir, wsID, wsInfo.Name)
	if err != nil {
		send("error", fmt.Sprintf("Compilation failed: %s", err))
		return
	}
	send("progress", fmt.Sprintf("Compiled: %s", compileResult))

	// ── Write .offpack to disk ─────────────────────────────────────────
	send("progress", "Writing .offpack bundle...")
	packsDir := filepath.Join(wsDir, "packs")
	if err := os.MkdirAll(packsDir, 0o755); err != nil {
		send("error", fmt.Sprintf("Failed to create packs directory: %s", err))
		return
	}

	packPath := filepath.Join(packsDir, "latest.offpack")
	if err := writeOffpack(packPath, compiledPack); err != nil {
		send("error", fmt.Sprintf("Failed to write pack: %s", err))
		return
	}

	// Get file size
	fi, err := os.Stat(packPath)
	if err != nil {
		send("error", fmt.Sprintf("Failed to stat pack: %s", err))
		return
	}

	send("done", fmt.Sprintf(`{"size":%d,"rooms":%d,"resources":%d,"atlases":%d,"sourceHash":"%s"}`,
		fi.Size(), compileResult.RoomCount, compileResult.ResourceCount, compileResult.AtlasCount,
		compiledPack.Manifest.SourceHash))
}

// packDownload serves the latest built .offpack file for download.
func (h *Handlers) packDownload(w http.ResponseWriter, r *http.Request) {
	wsID := ownerID(r)

	packPath := filepath.Join(h.cfg.WorkspaceDir(wsID), "packs", "latest.offpack")
	fi, err := os.Stat(packPath)
	if os.IsNotExist(err) {
		writeError(w, http.StatusNotFound, "NO_PACK", "no pack has been built yet")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STAT_FAILED", err.Error())
		return
	}

	f, err := os.Open(packPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "OPEN_FAILED", err.Error())
		return
	}
	defer f.Close()

	// Workspace name for filename
	wsInfo, err := h.workspaces.Get(r.Context(), wsID)
	filename := "pack.offpack"
	if err == nil && wsInfo.Name != "" {
		filename = wsInfo.Name + ".offpack"
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", fi.Size()))
	w.WriteHeader(http.StatusOK)
	io.Copy(w, f)
}

// packStatus returns info about the latest built pack (if any),
// including the compiled pack's source hash and the current workspace hash
// so the frontend can detect when the pack is stale.
func (h *Handlers) packStatus(w http.ResponseWriter, r *http.Request) {
	wsID := ownerID(r)
	wsDir := h.cfg.WorkspaceDir(wsID)

	packPath := filepath.Join(wsDir, "packs", "latest.offpack")
	fi, err := os.Stat(packPath)
	if os.IsNotExist(err) {
		// No pack built yet — still compute current hash so frontend knows it
		currentHash, _ := pack.ContentHash(wsDir)
		writeJSON(w, http.StatusOK, map[string]any{
			"exists":      false,
			"currentHash": currentHash,
		})
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STAT_FAILED", err.Error())
		return
	}

	// Read the compiled manifest to get source_hash
	compiledPackDir := filepath.Join(wsDir, "pack")
	var sourceHash string
	var compiledAt string
	if m, err := pack.OpenManifest(compiledPackDir); err == nil && m != nil {
		sourceHash = m.SourceHash
		compiledAt = m.CompiledAt
	}

	// Compute current workspace hash
	currentHash, _ := pack.ContentHash(wsDir)

	writeJSON(w, http.StatusOK, map[string]any{
		"exists":      true,
		"size":        fi.Size(),
		"builtAt":     fi.ModTime().UTC().Format(time.RFC3339),
		"sourceHash":  sourceHash,
		"currentHash": currentHash,
		"compiledAt":  compiledAt,
	})
}

// writeOffpack writes a Pack to a .offpack ZIP file (manifest.json + pack.pb).
func writeOffpack(path string, p *pack.Pack) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	defer func() {
		f.Close()
		os.Remove(tmp) // clean up if rename didn't happen
	}()

	zw := zip.NewWriter(f)

	// manifest.json
	manifestMarshaler := protojson.MarshalOptions{Multiline: true, Indent: "  "}
	manifestData, err := manifestMarshaler.Marshal(p.Manifest)
	if err != nil {
		return fmt.Errorf("marshal manifest: %w", err)
	}
	mw, err := zw.Create("manifest.json")
	if err != nil {
		return err
	}
	if _, err := mw.Write(manifestData); err != nil {
		return err
	}

	// pack.pb
	packData, err := proto.Marshal(p.Pack)
	if err != nil {
		return fmt.Errorf("marshal pack: %w", err)
	}
	pw, err := zw.Create("pack.pb")
	if err != nil {
		return err
	}
	if _, err := pw.Write(packData); err != nil {
		return err
	}

	if err := zw.Close(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}

	return os.Rename(tmp, path)
}
