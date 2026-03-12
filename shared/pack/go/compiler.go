// compiler.go — Pack compiler: generates optimized atlas textures from
// workspace resources/composites/rooms, remapping coordinates onto
// the generated atlases.
//
// Pipeline:
//  1. Scan tileset PNGs from {workspace}/tilesets/ → build hash→path lookup
//  2. Read resources, composites, rooms from workspace JSON files
//  3. Collect every unique pixel region referenced
//  4. Group regions by source tileset
//  5. For each tileset: extract used regions, shelf-pack into atlas PNG
//  6. Content-hash each atlas for cache-busting filenames
//  7. Write compiled resources/rooms with remapped atlas coordinates
//  8. Write manifest.json

package pack

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

// Compile reads a workspace directory and produces a compiled pack in outDir.
//
// The workspace must contain:
//   - tilesets/ — source tileset PNG images (scanned recursively)
//   - resources/*.json — Resource entities (protojson)
//   - composites/*.json — CompositeObject entities (protojson)
//   - rooms/*.json — RoomDefinition entities (protojson)
//
// Output goes to outDir:
//   - atlas/atlas_<hash>.png — one per source tileset with used regions
//   - resources/<id>.json — compiled resources with atlas coordinates
//   - rooms/<name>.json — compiled rooms with remapped placements
//   - manifest.json — index of all compiled assets
func Compile(workspaceDir, outDir, packID, packName string) (*CompileResult, error) {
	// ── 1. Scan tilesets ──────────────────────────────────────────────
	tilesetsDir := filepath.Join(workspaceDir, "tilesets")
	tilesets, err := scanTilesets(tilesetsDir)
	if err != nil {
		return nil, fmt.Errorf("scan tilesets: %w", err)
	}
	log.Printf("[compile] scanned %d tilesets", len(tilesets))

	// ── 2. Read entities ──────────────────────────────────────────────
	resources, err := readEntities[*pb.Resource](filepath.Join(workspaceDir, "resources"), func() *pb.Resource { return &pb.Resource{} })
	if err != nil {
		return nil, fmt.Errorf("read resources: %w", err)
	}
	composites, err := readEntities[*pb.CompositeObject](filepath.Join(workspaceDir, "composites"), func() *pb.CompositeObject { return &pb.CompositeObject{} })
	if err != nil {
		return nil, fmt.Errorf("read composites: %w", err)
	}
	rooms, err := readEntities[*pb.RoomDefinition](filepath.Join(workspaceDir, "rooms"), func() *pb.RoomDefinition { return &pb.RoomDefinition{} })
	if err != nil {
		return nil, fmt.Errorf("read rooms: %w", err)
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
		return nil, fmt.Errorf("clean output dir: %w", err)
	}
	for _, sub := range []string{"atlas", "rooms", "resources"} {
		if err := os.MkdirAll(filepath.Join(outDir, sub), 0o755); err != nil {
			return nil, fmt.Errorf("create %s dir: %w", sub, err)
		}
	}

	// ── 5. Build atlas for each tileset ───────────────────────────────
	atlasLookup := make(map[string]*atlasEntry) // regionKey → atlas position
	var manifestAtlases []*manifestAtlas

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
			return nil, fmt.Errorf("encode atlas for tileset %s: %w", tilesetID, err)
		}

		// Content hash for filename
		hash := sha256.Sum256(atlasBuf)
		hashStr := hex.EncodeToString(hash[:])[:10]
		atlasFile := "atlas_" + hashStr + ".png"
		atlasPath := filepath.Join(outDir, "atlas", atlasFile)

		if err := os.WriteFile(atlasPath, atlasBuf, 0o644); err != nil {
			return nil, fmt.Errorf("write atlas %s: %w", atlasFile, err)
		}

		log.Printf("[compile] atlas for %q: %dx%dpx, %d regions, %.1f KB → %s",
			ts.label, atlasW, atlasH, len(regions), float64(len(atlasBuf))/1024, atlasFile)

		// Record entries in lookup
		for _, s := range slots {
			atlasLookup[s.region.key] = &atlasEntry{
				atlasFile: atlasFile,
				x:         s.ax,
				y:         s.ay,
				w:         s.region.w,
				h:         s.region.h,
			}
		}

		manifestAtlases = append(manifestAtlases, &manifestAtlas{
			File:      atlasFile,
			TilesetID: tilesetID,
			Regions:   len(regions),
			SizeBytes: len(atlasBuf),
		})
	}

	// ── 6. Resolve helper ─────────────────────────────────────────────
	resolve := func(tilesetID string, srcCol, srcRow, w, h int32) *compiledRegionRef {
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
		return &compiledRegionRef{
			Atlas: entry.atlasFile,
			X:     entry.x,
			Y:     entry.y,
			W:     entry.w,
			H:     entry.h,
		}
	}

	// ── 7. Write compiled resources ───────────────────────────────────
	var manifestResources []*manifestResource

	for _, res := range resources {
		compiled := &compiledResource{
			ID:   res.Id,
			Name: res.Name,
			Tags: res.Tags,
		}
		for _, frame := range res.Frames {
			ref := resolve(frame.TilesetId, frame.SrcCol, frame.SrcRow, frame.W, frame.H)
			if ref != nil {
				compiled.Frames = append(compiled.Frames, ref)
			} else {
				log.Printf("[compile] warning: missing frame for resource %s (%s): tileset=%s",
					res.Id, res.Name, frame.TilesetId)
			}
		}

		data, err := marshalCompiledJSON(compiled)
		if err != nil {
			return nil, fmt.Errorf("marshal resource %s: %w", res.Id, err)
		}
		if err := os.WriteFile(filepath.Join(outDir, "resources", res.Id+".json"), data, 0o644); err != nil {
			return nil, fmt.Errorf("write resource %s: %w", res.Id, err)
		}
		manifestResources = append(manifestResources, &manifestResource{
			ID:   res.Id,
			Name: res.Name,
			Tags: res.Tags,
			File: res.Id + ".json",
		})
	}

	// ── 8. Write compiled rooms ───────────────────────────────────────
	var manifestRooms []*manifestRoom

	for _, room := range rooms {
		atlasesUsed := make(map[string]struct{})
		var compiledPlacements []*compiledPlacement

		for _, p := range room.Placements {
			if p.Region != nil {
				r := p.Region
				ref := resolve(r.TilesetId, r.SrcCol, r.SrcRow, r.W, r.H)
				if ref != nil {
					atlasesUsed[ref.Atlas] = struct{}{}
					cp := &compiledPlacement{
						GridX:  int(p.GridX),
						GridY:  int(p.GridY),
						Layer:  int(p.Layer),
						Region: ref,
						ZBias:  int(p.ZBias),
					}
					compiledPlacements = append(compiledPlacements, cp)
				}
			} else if p.CompositeId != "" {
				comp := compositeMap[p.CompositeId]
				if comp != nil {
					var parts []*compiledCompositePart
					for _, part := range comp.Parts {
						if part.Region == nil {
							continue
						}
						r := part.Region
						ref := resolve(r.TilesetId, r.SrcCol, r.SrcRow, r.W, r.H)
						if ref != nil {
							atlasesUsed[ref.Atlas] = struct{}{}
							parts = append(parts, &compiledCompositePart{
								Region:  ref,
								OffsetX: int(part.OffsetX),
								OffsetY: int(part.OffsetY),
								ZBias:   int(part.ZBias),
							})
						}
					}
					if len(parts) > 0 {
						cp := &compiledPlacement{
							GridX: int(p.GridX),
							GridY: int(p.GridY),
							Layer: int(p.Layer),
							Parts: parts,
							ZBias: int(p.ZBias),
						}
						compiledPlacements = append(compiledPlacements, cp)
					}
				}
			}
		}

		atlasesList := make([]string, 0, len(atlasesUsed))
		for a := range atlasesUsed {
			atlasesList = append(atlasesList, a)
		}
		sort.Strings(atlasesList)

		compiled := &compiledRoom{
			Name:        room.Name,
			Width:       int(room.Width),
			Height:      int(room.Height),
			Walkability: room.Walkability,
			Doors:       make([]*compiledDoor, 0, len(room.Doors)),
			Placements:  compiledPlacements,
			Atlases:     atlasesList,
		}
		for _, d := range room.Doors {
			compiled.Doors = append(compiled.Doors, &compiledDoor{
				ID:     d.Id,
				Col:    int(d.Col),
				Row:    int(d.Row),
				Target: d.Target,
			})
		}

		data, err := marshalCompiledJSON(compiled)
		if err != nil {
			return nil, fmt.Errorf("marshal room %s: %w", room.Name, err)
		}
		if err := os.WriteFile(filepath.Join(outDir, "rooms", room.Name+".json"), data, 0o644); err != nil {
			return nil, fmt.Errorf("write room %s: %w", room.Name, err)
		}
		manifestRooms = append(manifestRooms, &manifestRoom{
			Name: room.Name,
			File: room.Name + ".json",
		})
	}

	// ── 9. Write manifest ─────────────────────────────────────────────
	manifest := &compiledManifest{
		ID:         packID,
		Name:       packName,
		CompiledAt: time.Now().UTC().Format(time.RFC3339),
		Atlases:    manifestAtlases,
		Rooms:      manifestRooms,
		Resources:  manifestResources,
	}
	data, err := marshalCompiledJSON(manifest)
	if err != nil {
		return nil, fmt.Errorf("marshal manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(outDir, "manifest.json"), data, 0o644); err != nil {
		return nil, fmt.Errorf("write manifest: %w", err)
	}

	totalKB := 0
	for _, a := range manifestAtlases {
		totalKB += a.SizeBytes
	}
	totalKB /= 1024

	result := &CompileResult{
		AtlasCount:    len(manifestAtlases),
		RoomCount:     len(manifestRooms),
		ResourceCount: len(manifestResources),
		TotalAtlasKB:  totalKB,
	}
	log.Printf("[compile] done: %s", result)
	return result, nil
}

// ─── Tileset scanning ─────────────────────────────────────────────────────────

type scannedTileset struct {
	id         string // full SHA256 hex of the PNG file
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

		h := sha256.New()
		if _, err := io.Copy(h, f); err != nil {
			return nil
		}
		fullHash := hex.EncodeToString(h.Sum(nil))

		stem := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		tw, th := parseTileDims(stem)

		ts := &scannedTileset{
			id:         fullHash,
			label:      stem,
			fsPath:     path,
			tileWidth:  tw,
			tileHeight: th,
		}

		// Key by full hash (matches resource tilesetId format)
		result[fullHash] = ts
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
	atlasFile string
	x, y      int
	w, h      int
}

// ─── Compiled output types (JSON serialization) ───────────────────────────────
// These are simple structs for JSON output — NOT protobuf types.
// The compiled format is different from the source format: regions reference
// atlas files with pixel coordinates instead of tilesets with tile coordinates.

type compiledRegionRef struct {
	Atlas string `json:"atlas"`
	X     int    `json:"x"`
	Y     int    `json:"y"`
	W     int    `json:"w"`
	H     int    `json:"h"`
}

type compiledCompositePart struct {
	Region  *compiledRegionRef `json:"region"`
	OffsetX int                `json:"offsetX"`
	OffsetY int                `json:"offsetY"`
	ZBias   int                `json:"zBias,omitempty"`
}

type compiledPlacement struct {
	GridX  int                      `json:"gridX"`
	GridY  int                      `json:"gridY"`
	Layer  int                      `json:"layer"`
	Region *compiledRegionRef       `json:"region,omitempty"`
	Parts  []*compiledCompositePart `json:"parts,omitempty"`
	ZBias  int                      `json:"zBias,omitempty"`
}

type compiledDoor struct {
	ID     string `json:"id"`
	Col    int    `json:"col"`
	Row    int    `json:"row"`
	Target string `json:"target"`
}

type compiledRoom struct {
	Name        string               `json:"name"`
	Width       int                  `json:"width"`
	Height      int                  `json:"height"`
	Walkability []bool               `json:"walkability"`
	Doors       []*compiledDoor      `json:"doors"`
	Placements  []*compiledPlacement `json:"placements"`
	Atlases     []string             `json:"atlases"`
}

type compiledResource struct {
	ID     string               `json:"id"`
	Name   string               `json:"name"`
	Tags   []string             `json:"tags"`
	Frames []*compiledRegionRef `json:"frames"`
}

type manifestAtlas struct {
	File      string `json:"file"`
	TilesetID string `json:"tilesetId"`
	Regions   int    `json:"regions"`
	SizeBytes int    `json:"sizeBytes"`
}

type manifestRoom struct {
	Name string `json:"name"`
	File string `json:"file"`
}

type manifestResource struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	Tags []string `json:"tags"`
	File string   `json:"file"`
}

type compiledManifest struct {
	ID         string              `json:"id"`
	Name       string              `json:"name"`
	CompiledAt string              `json:"compiledAt"`
	Atlases    []*manifestAtlas    `json:"atlases"`
	Rooms      []*manifestRoom     `json:"rooms"`
	Resources  []*manifestResource `json:"resources"`
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

// marshalCompiledJSON marshals a compiled output struct to indented JSON.
func marshalCompiledJSON(v any) ([]byte, error) {
	return json.MarshalIndent(v, "", "  ")
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
