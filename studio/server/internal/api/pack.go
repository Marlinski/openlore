package api

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/openlore/shared/pack"
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
	if err := writeOffpack(packPath, compiledPack, compileOutDir); err != nil {
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

// writeOffpack writes a Pack to a .offpack ZIP file (manifest.json + pack.pb + atlas PNGs).
// outDir is the compile output directory containing the atlas/ subdirectory.
func writeOffpack(path string, p *pack.Pack, outDir string) error {
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

	// atlas/*.png — include all atlas images from the compile output
	atlasDir := filepath.Join(outDir, "atlas")
	if entries, err := os.ReadDir(atlasDir); err == nil {
		for _, entry := range entries {
			if entry.IsDir() || filepath.Ext(entry.Name()) != ".png" {
				continue
			}
			data, err := os.ReadFile(filepath.Join(atlasDir, entry.Name()))
			if err != nil {
				return fmt.Errorf("read atlas %s: %w", entry.Name(), err)
			}
			aw, err := zw.Create("atlas/" + entry.Name())
			if err != nil {
				return err
			}
			if _, err := aw.Write(data); err != nil {
				return err
			}
		}
	}

	if err := zw.Close(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}

	return os.Rename(tmp, path)
}

// publishRequest is the JSON body for POST /api/pack/publish.
type publishRequest struct {
	Name string   `json:"name"` // pack name on the game server (used as pack ID)
	Tags []string `json:"tags"` // optional discoverable tags
}

// packPublish forwards the latest .offpack to the configured game server.
// The request body provides the pack name (used as the ID on the game server)
// and optional tags. Tags are injected into the .offpack manifest before sending.
//
// POST /{workspaceId}/api/pack/publish  body: {"name":"my-pack","tags":["office","modern"]}
func (h *Handlers) packPublish(w http.ResponseWriter, r *http.Request) {
	if h.cfg.GameServerURL == "" {
		writeError(w, http.StatusServiceUnavailable, "NO_GAME_SERVER", "game server URL not configured")
		return
	}

	// Parse request body
	var req publishRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON body: "+err.Error())
		return
	}
	r.Body.Close()

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "name is required")
		return
	}

	// Sanitise name → pack ID (lowercase, hyphens, no spaces)
	packID := sanitizePackID(req.Name)

	wsID := ownerID(r)
	packPath := filepath.Join(h.cfg.WorkspaceDir(wsID), "packs", "latest.offpack")

	// Read the .offpack, inject tags into the manifest, re-write as a temp file
	p, err := pack.ReadZip(packPath)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "NO_PACK", "no pack has been built yet — build first")
			return
		}
		writeError(w, http.StatusInternalServerError, "READ_FAILED", err.Error())
		return
	}

	// Update manifest with publish metadata
	p.Manifest.Name = req.Name
	p.Manifest.Id = packID
	p.Manifest.Tags = req.Tags

	// Write to temp .offpack with updated manifest
	tmp, err := os.CreateTemp("", "publish-*.offpack")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "TEMP_FAILED", err.Error())
		return
	}
	tmpPath := tmp.Name()
	tmp.Close()
	defer os.Remove(tmpPath)

	compileOutDir := filepath.Join(h.cfg.WorkspaceDir(wsID), "pack")

	if err := writeOffpack(tmpPath, p, compileOutDir); err != nil {
		writeError(w, http.StatusInternalServerError, "REWRITE_FAILED", err.Error())
		return
	}

	// POST to game server
	f, err := os.Open(tmpPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "OPEN_FAILED", err.Error())
		return
	}
	defer f.Close()

	installURL := fmt.Sprintf("%s/api/packs/%s/install", strings.TrimRight(h.cfg.GameServerURL, "/"), packID)
	log.Printf("publish: posting pack %q to %s", packID, installURL)

	resp, err := http.Post(installURL, "application/octet-stream", f)
	if err != nil {
		writeError(w, http.StatusBadGateway, "GAME_SERVER_ERROR", "failed to reach game server: "+err.Error())
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		writeError(w, http.StatusBadGateway, "INSTALL_FAILED",
			fmt.Sprintf("game server returned %d: %s", resp.StatusCode, string(body)))
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"packId": packID,
		"name":   req.Name,
		"tags":   req.Tags,
	})
}

// sanitizePackID converts a human-friendly name into a URL-safe pack ID.
func sanitizePackID(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' {
			return r
		}
		if r == ' ' || r == '_' {
			return '-'
		}
		return -1 // drop
	}, s)
	// Collapse multiple hyphens
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	return strings.Trim(s, "-")
}
