// compiler.go — Pack compiler: generates optimized atlas textures from
// workspace resources/composites/rooms, remapping coordinates onto
// the generated atlases.
//
// The compiler outputs a standard *Pack using the same protobuf types
// as the source format. Atlas images become TilesetDefinition entries
// (tile_width=1, tile_height=1, making coordinates pixel-based).
// All TilesetRegion/ResourceFrame references are remapped from source
// tileset IDs to atlas tileset IDs with new pixel coordinates.
//
// Pipeline:
//  1. Scan tileset PNGs from {workspace}/tilesets/ → build hash→path lookup
//  2. Read resources, composites, rooms from workspace JSON files
//  3. Collect every unique pixel region referenced
//  4. Group regions by source tileset
//  5. For each tileset: extract used regions, shelf-pack into atlas PNG
//  6. Content-hash each atlas for cache-busting filenames
//  7. Build compiled Pack with remapped atlas coordinates
//  8. Write Pack to outDir using standard writer + copy atlas PNGs

package pack

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	pb "github.com/offisims/shared/pack/pb/packv1"
	"google.golang.org/protobuf/proto"
)

// CompileResult summarises the output of a pack compilation.
type CompileResult struct {
	AtlasCount    int
	RoomCount     int
	ResourceCount int
	TotalAtlasKB  int
}

func (r CompileResult) String() string {
	return fmt.Sprintf("%d atlases (%d KB), %d rooms, %d resources",
		r.AtlasCount, r.TotalAtlasKB, r.RoomCount, r.ResourceCount)
}

// Compile reads a workspace directory and produces a compiled pack.
//
// The workspace must contain:
//   - tilesets/ — source tileset PNG images (scanned recursively)
//   - resources/*.json — Resource entities (protojson)
//   - composites/*.json — CompositeObject entities (protojson)
//   - rooms/*.json — RoomDefinition entities (protojson)
//
// Returns the compiled Pack (with atlas tilesets and remapped coordinates)
// and writes atlas PNGs + Pack JSON files to outDir.
func Compile(workspaceDir, outDir, packID, packName string) (*Pack, *CompileResult, error) {
	// ── 1. Scan tilesets ──────────────────────────────────────────────
	tilesetsDir := filepath.Join(workspaceDir, "tilesets")
	tilesets, err := scanTilesets(tilesetsDir)
	if err != nil {
		return nil, nil, fmt.Errorf("scan tilesets: %w", err)
	}
	log.Printf("[compile] scanned %d tilesets", len(tilesets))

	// ── 2. Read entities ──────────────────────────────────────────────
	resources, err := readEntities[*pb.Resource](filepath.Join(workspaceDir, "resources"), func() *pb.Resource { return &pb.Resource{} })
	if err != nil {
		return nil, nil, fmt.Errorf("read resources: %w", err)
	}
	composites, err := readEntities[*pb.CompositeObject](filepath.Join(workspaceDir, "composites"), func() *pb.CompositeObject { return &pb.CompositeObject{} })
	if err != nil {
		return nil, nil, fmt.Errorf("read composites: %w", err)
	}
	rooms, err := readEntities[*pb.RoomDefinition](filepath.Join(workspaceDir, "rooms"), func() *pb.RoomDefinition { return &pb.RoomDefinition{} })
	if err != nil {
		return nil, nil, fmt.Errorf("read rooms: %w", err)
	}
	log.Printf("[compile] read %d resources, %d composites, %d rooms",
		len(resources), len(composites), len(rooms))

	// Build composite lookup for room resolution
	compositeMap := make(map[string]*pb.CompositeObject, len(composites))
	for _, c := range composites {
		compositeMap[c.Id] = c
	}

	// ── 3. Collect unique pixel regions ───────────────────────────────
	collector := newRegionCollector(tilesets)

	// From resources
	for _, res := range resources {
		for _, frame := range res.Frames {
			collector.addTileRegion(frame.TilesetId, frame.SrcCol, frame.SrcRow, frame.W, frame.H)
		}
	}

	// From rooms (direct regions and composites)
	for _, room := range rooms {
		for _, p := range room.Placements {
			if p.Region != nil {
				r := p.Region
				collector.addTileRegion(r.TilesetId, r.SrcCol, r.SrcRow, r.W, r.H)
			}
			if p.CompositeId != "" {
				comp := compositeMap[p.CompositeId]
				if comp != nil {
					for _, part := range comp.Parts {
						if part.Region != nil {
							r := part.Region
							collector.addTileRegion(r.TilesetId, r.SrcCol, r.SrcRow, r.W, r.H)
						}
					}
				}
			}
		}
	}

	log.Printf("[compile] collected %d unique regions from %d tilesets",
		len(collector.all), len(collector.byTileset))

	// ── 4. Clean and create output directory ──────────────────────────
	if err := os.RemoveAll(outDir); err != nil {
		return nil, nil, fmt.Errorf("clean output dir: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(outDir, "atlas"), 0o755); err != nil {
		return nil, nil, fmt.Errorf("create atlas dir: %w", err)
	}

	// ── 5. Build atlas for each tileset ───────────────────────────────
	atlasLookup := make(map[string]*atlasEntry) // regionKey → atlas position
	var atlasTilesets []*pb.TilesetDefinition
	var tilesetEntries []*pb.TilesetEntry
	totalAtlasBytes := 0

	for tilesetID, regionKeys := range collector.byTileset {
		ts, ok := tilesets[tilesetID]
		if !ok {
			continue
		}

		// Load source image
		srcImg, err := loadPNG(ts.fsPath)
		if err != nil {
			log.Printf("[compile] warning: cannot load tileset %s: %v", tilesetID, err)
			continue
		}

		// Gather and sort regions for deterministic output
		regions := make([]*pixelRegion, 0, len(regionKeys))
		for key := range regionKeys {
			regions = append(regions, collector.all[key])
		}
		sort.Slice(regions, func(i, j int) bool {
			if regions[i].y != regions[j].y {
				return regions[i].y < regions[j].y
			}
			if regions[i].x != regions[j].x {
				return regions[i].x < regions[j].x
			}
			if regions[i].w != regions[j].w {
				return regions[i].w < regions[j].w
			}
			return regions[i].h < regions[j].h
		})

		// Shelf-pack regions
		const maxAtlasWidth = 4096
		slots := shelfPack(regions, maxAtlasWidth)
		if len(slots) == 0 {
			continue
		}

		// Compute atlas dimensions
		atlasW, atlasH := 0, 0
		for _, s := range slots {
			if right := s.ax + s.region.w; right > atlasW {
				atlasW = right
			}
			if bottom := s.ay + s.region.h; bottom > atlasH {
				atlasH = bottom
			}
		}
		if atlasW == 0 || atlasH == 0 {
			continue
		}

		// Composite regions into atlas image
		atlas := image.NewNRGBA(image.Rect(0, 0, atlasW, atlasH))
		srcBounds := srcImg.Bounds()
		for _, s := range slots {
			r := s.region
			// Clamp to source image bounds
			extractW := r.w
			extractH := r.h
			if r.x+extractW > srcBounds.Dx() {
				extractW = srcBounds.Dx() - r.x
			}
			if r.y+extractH > srcBounds.Dy() {
				extractH = srcBounds.Dy() - r.y
			}
			if extractW <= 0 || extractH <= 0 {
				continue
			}

			srcRect := image.Rect(r.x, r.y, r.x+extractW, r.y+extractH)
			dstPt := image.Pt(s.ax, s.ay)
			draw.Draw(atlas, image.Rectangle{Min: dstPt, Max: dstPt.Add(image.Pt(extractW, extractH))},
				srcImg, srcRect.Min, draw.Src)
		}

		// Encode atlas to PNG in memory for hashing
		atlasBuf, err := encodePNG(atlas)
		if err != nil {
			return nil, nil, fmt.Errorf("encode atlas for tileset %s: %w", tilesetID, err)
		}

		// Content hash for filename and tileset ID
		hash := sha256.Sum256(atlasBuf)
		hashStr := hex.EncodeToString(hash[:])[:10]
		atlasFile := "atlas_" + hashStr + ".png"
		atlasTilesetID := "atlas_" + hashStr
		atlasPath := filepath.Join(outDir, "atlas", atlasFile)

		if err := os.WriteFile(atlasPath, atlasBuf, 0o644); err != nil {
			return nil, nil, fmt.Errorf("write atlas %s: %w", atlasFile, err)
		}

		log.Printf("[compile] atlas for %q: %dx%dpx, %d regions, %.1f KB → %s",
			ts.label, atlasW, atlasH, len(regions), float64(len(atlasBuf))/1024, atlasFile)

		totalAtlasBytes += len(atlasBuf)

		// Record entries in lookup (with atlas tileset ID for remapping)
		for _, s := range slots {
			atlasLookup[s.region.key] = &atlasEntry{
				tilesetID: atlasTilesetID,
				x:         s.ax,
				y:         s.ay,
				w:         s.region.w,
				h:         s.region.h,
			}
		}

		// Atlas tileset definition: tile_width=1 means coordinates are pixels
		atlasTilesets = append(atlasTilesets, &pb.TilesetDefinition{
			Id:         atlasTilesetID,
			Label:      "atlas:" + ts.label,
			Path:       "atlas/" + atlasFile,
			TileWidth:  1,
			TileHeight: 1,
			Cols:       int32(atlasW),
			Rows:       int32(atlasH),
		})

		// Manifest tileset entry
		tilesetEntries = append(tilesetEntries, &pb.TilesetEntry{
			Id:    atlasTilesetID,
			Label: "atlas:" + ts.label,
			Path:  "atlas/" + atlasFile,
		})
	}

	// ── 6. Build compiled Pack ────────────────────────────────────────
	//
	// Remap all region references from source tileset IDs → atlas tileset IDs.
	// Since atlas tilesets have tile_width=1, coordinates are pixels.

	// Region resolve helper: given source tileset tile coords, returns
	// atlas TilesetRegion (pixel-based since tile_width=1).
	resolveRegion := func(tilesetID string, srcCol, srcRow, w, h int32) *pb.TilesetRegion {
		ts, ok := tilesets[tilesetID]
		if !ok {
			return nil
		}
		px := int(srcCol) * ts.tileWidth
		py := int(srcRow) * ts.tileHeight
		pw := int(w) * ts.tileWidth
		ph := int(h) * ts.tileHeight
		key := regionKey(tilesetID, px, py, pw, ph)
		entry, ok := atlasLookup[key]
		if !ok {
			return nil
		}
		return &pb.TilesetRegion{
			TilesetId: entry.tilesetID,
			SrcCol:    int32(entry.x),
			SrcRow:    int32(entry.y),
			W:         int32(entry.w),
			H:         int32(entry.h),
		}
	}

	// Frame resolve helper: same logic for ResourceFrame
	resolveFrame := func(tilesetID string, srcCol, srcRow, w, h int32) *pb.ResourceFrame {
		ts, ok := tilesets[tilesetID]
		if !ok {
			return nil
		}
		px := int(srcCol) * ts.tileWidth
		py := int(srcRow) * ts.tileHeight
		pw := int(w) * ts.tileWidth
		ph := int(h) * ts.tileHeight
		key := regionKey(tilesetID, px, py, pw, ph)
		entry, ok := atlasLookup[key]
		if !ok {
			return nil
		}
		return &pb.ResourceFrame{
			TilesetId: entry.tilesetID,
			SrcCol:    int32(entry.x),
			SrcRow:    int32(entry.y),
			W:         int32(entry.w),
			H:         int32(entry.h),
		}
	}

	// Build compiled resources
	var compiledResources []*pb.Resource
	var resourceEntries []*pb.ResourceEntry

	for _, res := range resources {
		compiled := &pb.Resource{
			Id:   res.Id,
			Name: res.Name,
			Tags: res.Tags,
		}
		for _, frame := range res.Frames {
			ref := resolveFrame(frame.TilesetId, frame.SrcCol, frame.SrcRow, frame.W, frame.H)
			if ref != nil {
				compiled.Frames = append(compiled.Frames, ref)
			} else {
				log.Printf("[compile] warning: missing frame for resource %s (%s): tileset=%s",
					res.Id, res.Name, frame.TilesetId)
			}
		}
		compiledResources = append(compiledResources, compiled)
		resourceEntries = append(resourceEntries, &pb.ResourceEntry{
			Id:   res.Id,
			Name: res.Name,
			Tags: res.Tags,
		})
	}

	// Build compiled composites (remap part regions)
	var compiledComposites []*pb.CompositeObject

	for _, comp := range composites {
		compiled := &pb.CompositeObject{
			Id:            comp.Id,
			Name:          comp.Name,
			DisplayWidth:  comp.DisplayWidth,
			DisplayHeight: comp.DisplayHeight,
		}
		for _, part := range comp.Parts {
			cp := &pb.CompositePart{
				OffsetX: part.OffsetX,
				OffsetY: part.OffsetY,
				ZBias:   part.ZBias,
			}
			if part.Region != nil {
				r := part.Region
				cp.Region = resolveRegion(r.TilesetId, r.SrcCol, r.SrcRow, r.W, r.H)
			}
			compiled.Parts = append(compiled.Parts, cp)
		}
		compiledComposites = append(compiledComposites, compiled)
	}

	// Build compiled rooms (remap placement regions, keep composite refs)
	var compiledRooms []*pb.RoomDefinition
	var roomEntries []*pb.RoomEntry

	for _, room := range rooms {
		compiled := &pb.RoomDefinition{
			Name:        room.Name,
			Width:       room.Width,
			Height:      room.Height,
			Walkability: room.Walkability,
			Doors:       room.Doors, // doors pass through unchanged
		}

		for _, p := range room.Placements {
			cp := &pb.TexturePlacement{
				GridX:       p.GridX,
				GridY:       p.GridY,
				Layer:       p.Layer,
				CompositeId: p.CompositeId,
				ZBias:       p.ZBias,
			}
			if p.Region != nil {
				r := p.Region
				cp.Region = resolveRegion(r.TilesetId, r.SrcCol, r.SrcRow, r.W, r.H)
			}
			// composite_id is preserved as-is; the compiled composite has remapped regions
			compiled.Placements = append(compiled.Placements, cp)
		}

		compiledRooms = append(compiledRooms, compiled)
		roomEntries = append(roomEntries, &pb.RoomEntry{
			Name: room.Name,
		})
	}

	// Compute workspace content hash for staleness detection
	sourceHash, err := ContentHash(workspaceDir)
	if err != nil {
		return nil, nil, fmt.Errorf("content hash: %w", err)
	}
	log.Printf("[compile] workspace content hash: %s", sourceHash[:12])

	// Build the Pack
	now := time.Now().UTC()
	compiledPack := &Pack{
		Pack: &pb.Pack{
			Manifest: &pb.PackManifest{
				Id:              packID,
				Name:            packName,
				Created:         now.Format(time.RFC3339),
				Updated:         now.Format(time.RFC3339),
				TilesetEntries:  tilesetEntries,
				RoomEntries:     roomEntries,
				ResourceEntries: resourceEntries,
				SourceHash:      sourceHash,
				CompiledAt:      now.Format(time.RFC3339),
			},
			Tilesets:   atlasTilesets,
			Composites: compiledComposites,
			Rooms:      compiledRooms,
			Resources:  compiledResources,
		},
	}

	// ── 7. Write compiled Pack to outDir ──────────────────────────────
	if err := Write(outDir, compiledPack); err != nil {
		return nil, nil, fmt.Errorf("write compiled pack: %w", err)
	}

	totalKB := totalAtlasBytes / 1024
	result := &CompileResult{
		AtlasCount:    len(atlasTilesets),
		RoomCount:     len(compiledRooms),
		ResourceCount: len(compiledResources),
		TotalAtlasKB:  totalKB,
	}
	log.Printf("[compile] done: %s", result)
	return compiledPack, result, nil
}

// ─── Tileset scanning ─────────────────────────────────────────────────────────

type scannedTileset struct {
	id         string // first 16 hex chars of SHA256 (matches Studio tilesetId format)
	label      string // filename stem
	fsPath     string // absolute filesystem path
	tileWidth  int
	tileHeight int
}

var dimRe = regexp.MustCompile(`(\d+)x(\d+)`)

// scanTilesets walks a directory for PNG files and returns a map of
// content-hash → tileset info. Resolves symlinks on the root directory.
func scanTilesets(dir string) (map[string]*scannedTileset, error) {
	result := make(map[string]*scannedTileset)

	// Resolve symlinks so WalkDir can traverse the target.
	resolved, err := filepath.EvalSymlinks(dir)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return nil, err
	}

	err = filepath.WalkDir(resolved, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if !strings.HasSuffix(strings.ToLower(d.Name()), ".png") {
			return nil
		}

		f, err := os.Open(path)
		if err != nil {
			return nil // skip unreadable
		}
		defer f.Close()

		// Hash using the same pattern as Studio's tilesets.go:
		// TeeReader feeds bytes to the hasher during image.DecodeConfig,
		// then io.Copy(h, tr) writes the remaining bytes to the hasher.
		// This must match exactly for tileset ID compatibility.
		h := sha256.New()
		tr := io.TeeReader(f, h)
		_, _, decErr := image.DecodeConfig(tr)
		if decErr != nil {
			return nil // skip non-image files
		}
		if _, err := io.Copy(h, tr); err != nil {
			return nil
		}
		shortHash := hex.EncodeToString(h.Sum(nil))[:16]

		stem := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		tw, th := parseTileDims(stem)

		ts := &scannedTileset{
			id:         shortHash,
			label:      stem,
			fsPath:     path,
			tileWidth:  tw,
			tileHeight: th,
		}

		// Key by short hash (matches Studio resource tilesetId format)
		result[shortHash] = ts
		return nil
	})
	return result, err
}

// parseTileDims extracts the last WxH match from a filename stem.
func parseTileDims(stem string) (w, h int) {
	matches := dimRe.FindAllStringSubmatch(stem, -1)
	if len(matches) == 0 {
		return 48, 48 // default
	}
	last := matches[len(matches)-1]
	w, _ = strconv.Atoi(last[1])
	h, _ = strconv.Atoi(last[2])
	if w == 0 {
		w = 48
	}
	if h == 0 {
		h = 48
	}
	return w, h
}

// ─── Region collection ────────────────────────────────────────────────────────

// pixelRegion is a unique rectangular region within a source tileset, in pixels.
type pixelRegion struct {
	tilesetID string
	x, y      int // pixel offset in source
	w, h      int // pixel size
	key       string
}

// regionKey builds a canonical dedup key for a pixel region.
func regionKey(tilesetID string, x, y, w, h int) string {
	return fmt.Sprintf("%s:%d,%d,%d,%d", tilesetID, x, y, w, h)
}

type regionCollector struct {
	tilesets  map[string]*scannedTileset
	all       map[string]*pixelRegion        // key → region
	byTileset map[string]map[string]struct{} // tilesetID → set of keys
}

func newRegionCollector(tilesets map[string]*scannedTileset) *regionCollector {
	return &regionCollector{
		tilesets:  tilesets,
		all:       make(map[string]*pixelRegion),
		byTileset: make(map[string]map[string]struct{}),
	}
}

func (c *regionCollector) addTileRegion(tilesetID string, srcCol, srcRow, w, h int32) {
	ts, ok := c.tilesets[tilesetID]
	if !ok {
		return
	}
	px := int(srcCol) * ts.tileWidth
	py := int(srcRow) * ts.tileHeight
	pw := int(w) * ts.tileWidth
	ph := int(h) * ts.tileHeight
	key := regionKey(tilesetID, px, py, pw, ph)

	if _, exists := c.all[key]; exists {
		return
	}
	c.all[key] = &pixelRegion{
		tilesetID: tilesetID,
		x:         px, y: py,
		w: pw, h: ph,
		key: key,
	}
	if c.byTileset[tilesetID] == nil {
		c.byTileset[tilesetID] = make(map[string]struct{})
	}
	c.byTileset[tilesetID][key] = struct{}{}
}

// ─── Shelf packing ───────────────────────────────────────────────────────────

type packedSlot struct {
	region *pixelRegion
	ax, ay int // position in atlas
}

// shelfPack arranges regions into rows (shelves) within maxWidth.
func shelfPack(regions []*pixelRegion, maxWidth int) []packedSlot {
	var slots []packedSlot
	curX, curY, rowH := 0, 0, 0

	for _, r := range regions {
		if curX+r.w > maxWidth && curX > 0 {
			curY += rowH
			curX = 0
			rowH = 0
		}
		slots = append(slots, packedSlot{region: r, ax: curX, ay: curY})
		curX += r.w
		if r.h > rowH {
			rowH = r.h
		}
	}
	return slots
}

// ─── Atlas entry ──────────────────────────────────────────────────────────────

type atlasEntry struct {
	tilesetID string // atlas tileset ID (e.g. "atlas_a0e448f9b5")
	x, y      int    // pixel position in atlas
	w, h      int    // pixel size
}

// ─── Image helpers ────────────────────────────────────────────────────────────

func loadPNG(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", filepath.Base(path), err)
	}
	return img, nil
}

func encodePNG(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	enc := &png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ─── Entity reading ───────────────────────────────────────────────────────────

// readEntities reads all .json files from a directory into protobuf messages.
func readEntities[T interface {
	*E
	proto.Message
}, E any](dir string, newFn func() T) ([]T, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	var result []T
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			log.Printf("[compile] warning: skip %s: %v", entry.Name(), err)
			continue
		}
		m := newFn()
		if err := unmarshaler.Unmarshal(data, m); err != nil {
			log.Printf("[compile] warning: skip %s: %v", entry.Name(), err)
			continue
		}
		result = append(result, m)
	}
	return result, nil
}
