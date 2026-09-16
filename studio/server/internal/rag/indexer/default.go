// Package indexer implements DefaultIndexer — a filesystem-to-vector-index sync
// that ports the Node.js indexer.ts logic to Go.
//
// Supported kinds: tileset, resource, resource_sprite, composite, room.
// Change detection uses SHA-256 content hashes stored in the VectorStore.
// File watching uses fsnotify for incremental re-indexing.
package indexer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"golang.org/x/image/draw"

	"github.com/openlore/studio/internal/rag/embedder"
	"github.com/openlore/studio/internal/rag/vector"
)

// ─── Constants ───────────────────────────────────────────────────────────────

const (
	kindTileset        = "tileset"
	kindResource       = "resource"
	kindResourceSprite = "resource_sprite"
	kindComposite      = "composite"
	kindRoom           = "room"
	defaultTileSize    = 48
	embedBatchSize     = 10
	tilesetLogInterval = 100
)

var tileSizeRe = regexp.MustCompile(`(\d+)x(\d+)\.png$`)

// ─── Result ──────────────────────────────────────────────────────────────────

// IndexResult summarises a full-index run.
type IndexResult struct {
	Indexed int
	Skipped int
	Deleted int
	Errors  int
	Elapsed time.Duration
}

// ─── DefaultIndexer ──────────────────────────────────────────────────────────

// DefaultIndexer implements the Indexer interface against a local filesystem.
type DefaultIndexer struct {
	studioDir string // workspaces root (e.g. "data/studio/workspaces")
	emb       embedder.Embedder
	vec       vector.VectorStore
}

// New constructs a DefaultIndexer.
// studioDir is the workspaces root directory (e.g. "data/studio/workspaces").
// Individual workspaces are subdirectories: {studioDir}/{ownerID}/
func New(studioDir string, emb embedder.Embedder, vec vector.VectorStore) *DefaultIndexer {
	return &DefaultIndexer{studioDir: studioDir, emb: emb, vec: vec}
}

// workspaceDir returns the path to a workspace's data directory.
func (idx *DefaultIndexer) workspaceDir(ownerID string) string {
	return filepath.Join(idx.studioDir, ownerID)
}

// ─── Indexer interface ───────────────────────────────────────────────────────

// IndexAll performs a full rescan with hash-diff change detection.
func (idx *DefaultIndexer) IndexAll(ctx context.Context, ownerID string) error {
	t0 := time.Now()
	res := &IndexResult{}

	wsDir := idx.workspaceDir(ownerID)
	log.Printf("[indexer] Starting full index (workspace=%s dir=%s)", ownerID, wsDir)

	hashToPath := make(map[string]string)

	scannedTilesets, err := idx.indexTilesets(ctx, ownerID, res, hashToPath)
	if err != nil {
		return fmt.Errorf("indexTilesets: %w", err)
	}

	scannedResources, err := idx.indexResources(ctx, ownerID, res, hashToPath)
	if err != nil {
		return fmt.Errorf("indexResources: %w", err)
	}

	scannedComposites, err := idx.indexComposites(ctx, ownerID, res)
	if err != nil {
		return fmt.Errorf("indexComposites: %w", err)
	}

	scannedRooms, err := idx.indexRooms(ctx, ownerID, res)
	if err != nil {
		return fmt.Errorf("indexRooms: %w", err)
	}

	// Stale-entry cleanup
	for _, pair := range []struct {
		kind string
		seen map[string]struct{}
	}{
		{kindTileset, scannedTilesets},
		{kindResource, scannedResources},
		{kindResourceSprite, scannedResources}, // sprite IDs mirror resource IDs
		{kindComposite, scannedComposites},
		{kindRoom, scannedRooms},
	} {
		d, err := idx.deleteStale(ctx, ownerID, pair.kind, pair.seen)
		if err != nil {
			log.Printf("[indexer] delete stale %s: %v", pair.kind, err)
		}
		res.Deleted += d
	}

	res.Elapsed = time.Since(t0)
	log.Printf("[indexer] Full index done in %.1fs — indexed=%d skipped=%d deleted=%d errors=%d",
		res.Elapsed.Seconds(), res.Indexed, res.Skipped, res.Deleted, res.Errors)

	// Persist all vector store changes to disk in one write.
	if err := idx.vec.Flush(); err != nil {
		return fmt.Errorf("flush vector store: %w", err)
	}

	return nil
}

// IndexPath indexes (or re-indexes) a single file.
func (idx *DefaultIndexer) IndexPath(ctx context.Context, ownerID, path string) error {
	if err := idx.indexSingleFile(ctx, ownerID, path); err != nil {
		return err
	}
	return idx.vec.Flush()
}

// Watch starts a blocking fsnotify loop until ctx is cancelled.
func (idx *DefaultIndexer) Watch(ctx context.Context, ownerID string) error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("fsnotify: %w", err)
	}
	defer watcher.Close()

	// Watch the directories we care about
	wsDir := idx.workspaceDir(ownerID)
	dirs := []string{
		filepath.Join(wsDir, "tilesets"),
		filepath.Join(wsDir, "resources"),
		filepath.Join(wsDir, "composites"),
		filepath.Join(wsDir, "rooms"),
	}
	for _, d := range dirs {
		if err := watchRecursive(watcher, d); err != nil {
			log.Printf("[indexer] watch: cannot watch %s: %v", d, err)
		}
	}

	log.Printf("[indexer] Watching for changes under %s", wsDir)

	for {
		select {
		case <-ctx.Done():
			return nil
		case event, ok := <-watcher.Events:
			if !ok {
				return nil
			}
			if event.Has(fsnotify.Create) || event.Has(fsnotify.Write) || event.Has(fsnotify.Rename) {
				if err := idx.indexSingleFile(ctx, ownerID, event.Name); err != nil {
					log.Printf("[indexer] watch index %s: %v", event.Name, err)
				}
			}
		case err, ok := <-watcher.Errors:
			if !ok {
				return nil
			}
			log.Printf("[indexer] watcher error: %v", err)
		}
	}
}

// ─── Tileset indexing ────────────────────────────────────────────────────────

// tilesetEntry holds pre-computed data for a tileset that needs embedding.
type tilesetEntry struct {
	filePath  string
	relPath   string
	hash      string
	textLabel string
	tileW     int
	tileH     int
	imgW      int
	imgH      int
	cols      int
	rows      int
}

func (idx *DefaultIndexer) indexTilesets(
	ctx context.Context,
	ownerID string,
	res *IndexResult,
	hashToPath map[string]string,
) (map[string]struct{}, error) {
	tilesetsDir := filepath.Join(idx.workspaceDir(ownerID), "tilesets")
	files, err := walkDir(tilesetsDir, ".png")
	if err != nil {
		return nil, err
	}
	log.Printf("[indexer] Tilesets: found %d PNG files", len(files))

	scanned := make(map[string]struct{}, len(files))
	var phaseIndexed, phaseSkipped, phaseErrors int

	// Phase 1: Scan files, compute hashes, identify what needs embedding.
	var toEmbed []tilesetEntry
	for _, filePath := range files {
		relPath, _ := filepath.Rel(idx.workspaceDir(ownerID), filePath)

		data, err := os.ReadFile(filePath)
		if err != nil {
			log.Printf("[indexer] Tilesets: read error %s: %v", relPath, err)
			phaseErrors++
			continue
		}

		hash := hashBytes(data)
		externalID := hash
		scanned[externalID] = struct{}{}
		hashToPath[hash] = filePath

		// Skip if content + path unchanged.
		existing, _ := idx.vec.GetItemMetadata(ctx, ownerID, kindTileset, externalID)
		if existing != nil && existing["relPath"] == relPath {
			phaseSkipped++
			continue
		}

		// Needs embedding.
		tileW, tileH := parseTileSize(filepath.Base(filePath))
		imgW, imgH := imageSize(data)
		cols, rows := 0, 0
		if tileW > 0 {
			cols = imgW / tileW
		}
		if tileH > 0 {
			rows = imgH / tileH
		}

		toEmbed = append(toEmbed, tilesetEntry{
			filePath:  filePath,
			relPath:   relPath,
			hash:      hash,
			textLabel: textLabelFromRelPath(relPath),
			tileW:     tileW,
			tileH:     tileH,
			imgW:      imgW,
			imgH:      imgH,
			cols:      cols,
			rows:      rows,
		})
	}

	log.Printf("[indexer] Tilesets: %d need embedding, %d skipped (unchanged)", len(toEmbed), phaseSkipped)

	if len(toEmbed) == 0 {
		res.Skipped += phaseSkipped
		res.Errors += phaseErrors
		log.Printf("[indexer] Tilesets done: indexed=0 skipped=%d errors=%d", phaseSkipped, phaseErrors)
		return scanned, nil
	}

	// Phase 2: Batch-embed text labels in groups of embedBatchSize.
	imagePaths := make([]string, len(toEmbed))
	textVecs := make([][]float32, len(toEmbed))
	for i, e := range toEmbed {
		imagePaths[i] = e.filePath
	}

	for batchStart := 0; batchStart < len(toEmbed); batchStart += embedBatchSize {
		batchEnd := batchStart + embedBatchSize
		if batchEnd > len(toEmbed) {
			batchEnd = len(toEmbed)
		}
		batch := toEmbed[batchStart:batchEnd]
		texts := make([]string, len(batch))
		for i, e := range batch {
			texts[i] = e.textLabel
		}

		log.Printf("[indexer] Tilesets: embedding texts [%d:%d]/%d", batchStart, batchEnd, len(toEmbed))
		vecs, embErr := idx.emb.EmbedTexts(ctx, texts)
		if embErr != nil {
			res.Skipped += phaseSkipped
			res.Errors += phaseErrors
			return scanned, fmt.Errorf("batch text embed [%d:%d]: %w", batchStart, batchEnd, embErr)
		}
		copy(textVecs[batchStart:], vecs)
	}

	// Phase 3: Batch-embed images in groups of embedBatchSize (with per-image fallback).
	imgVecs := make([][]float32, len(toEmbed))
	for batchStart := 0; batchStart < len(imagePaths); batchStart += embedBatchSize {
		batchEnd := batchStart + embedBatchSize
		if batchEnd > len(imagePaths) {
			batchEnd = len(imagePaths)
		}
		chunk := imagePaths[batchStart:batchEnd]

		log.Printf("[indexer] Tilesets: embedding images [%d:%d]/%d", batchStart, batchEnd, len(imagePaths))
		vecs, embErr := idx.emb.EmbedImages(ctx, chunk)
		if embErr != nil {
			// Chunk failed — fall back to one-at-a-time so we can skip bad images.
			log.Printf("[indexer] Tilesets: image batch [%d:%d] failed (%v), falling back to individual calls", batchStart, batchEnd, embErr)
			for i, p := range chunk {
				v, indErr := idx.emb.EmbedImage(ctx, p)
				if indErr != nil {
					log.Printf("[indexer] Tilesets: image embed error %s: %v (skipping)", toEmbed[batchStart+i].relPath, indErr)
					continue
				}
				imgVecs[batchStart+i] = v
			}
			continue
		}
		copy(imgVecs[batchStart:], vecs)
	}

	// Phase 4: Upsert results.
	log.Printf("[indexer] Tilesets: upserting %d items...", len(toEmbed))
	for i, e := range toEmbed {
		if imgVecs[i] == nil {
			phaseErrors++
			continue
		}
		meta := map[string]any{
			"tileWidth": e.tileW, "tileHeight": e.tileH,
			"relPath": e.relPath,
			"width":   e.imgW, "height": e.imgH,
			"cols": e.cols, "rows": e.rows,
		}
		if err := idx.vec.Upsert(ctx, ownerID, e.hash, kindTileset, [][]float32{imgVecs[i], textVecs[i]}, meta, nil); err != nil {
			log.Printf("[indexer] Tilesets: upsert error %s: %v", e.relPath, err)
			phaseErrors++
			continue
		}
		phaseIndexed++

		if phaseIndexed%tilesetLogInterval == 0 {
			log.Printf("[indexer] Tilesets: %d/%d indexed", phaseIndexed, len(toEmbed))
		}
	}

	res.Indexed += phaseIndexed
	res.Skipped += phaseSkipped
	res.Errors += phaseErrors
	log.Printf("[indexer] Tilesets done: indexed=%d skipped=%d errors=%d", phaseIndexed, phaseSkipped, phaseErrors)
	return scanned, nil
}

// ─── Resource indexing ───────────────────────────────────────────────────────

type resourceJSON struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Tags   []string `json:"tags"`
	Frames []struct {
		TilesetID string `json:"tilesetId"`
		SrcCol    int    `json:"srcCol"`
		SrcRow    int    `json:"srcRow"`
		W         int    `json:"w"`
		H         int    `json:"h"`
	} `json:"frames"`
}

// resourceEntry holds pre-computed data for a resource that needs embedding.
type resourceEntry struct {
	filePath    string
	parsed      resourceJSON
	hash        string
	description string
	meta        map[string]any
}

func (idx *DefaultIndexer) indexResources(
	ctx context.Context,
	ownerID string,
	res *IndexResult,
	hashToPath map[string]string,
) (map[string]struct{}, error) {
	resourcesDir := filepath.Join(idx.workspaceDir(ownerID), "resources")
	files, err := walkDir(resourcesDir, ".json")
	if err != nil {
		return nil, err
	}
	log.Printf("[indexer] Resources: found %d JSON files", len(files))

	existingHashes, _ := idx.vec.GetAllHashes(ctx, ownerID, kindResource)
	scanned := make(map[string]struct{}, len(files))
	var phaseIndexed, phaseSkipped, phaseErrors int

	// Phase 1: Scan files, compute hashes, identify what needs embedding.
	var toEmbed []resourceEntry
	for _, filePath := range files {
		content, readErr := os.ReadFile(filePath)
		if readErr != nil {
			log.Printf("[indexer] Resources: read error %s: %v", filePath, readErr)
			phaseErrors++
			continue
		}

		var r resourceJSON
		if parseErr := json.Unmarshal(content, &r); parseErr != nil {
			log.Printf("[indexer] Resources: parse error %s: %v", filePath, parseErr)
			phaseErrors++
			continue
		}

		externalID := r.ID
		scanned[externalID] = struct{}{}
		hash := hashBytes(content)

		if existingHashes[externalID] == hash {
			phaseSkipped++
			continue
		}

		tagValues := strings.Join(r.Tags, " ")
		tagValues = strings.ReplaceAll(tagValues, ":", " ")
		nameClean := strings.ReplaceAll(r.Name, ":", " ")
		description := strings.TrimSpace(nameClean + " " + tagValues)

		meta := map[string]any{
			"name":         r.Name,
			"tags":         r.Tags,
			"frameCount":   len(r.Frames),
			"content_hash": hash,
		}
		if len(r.Frames) > 0 {
			meta["tilesetId"] = r.Frames[0].TilesetID
		}

		toEmbed = append(toEmbed, resourceEntry{
			filePath:    filePath,
			parsed:      r,
			hash:        hash,
			description: description,
			meta:        meta,
		})
	}

	log.Printf("[indexer] Resources: %d need embedding, %d skipped (unchanged)", len(toEmbed), phaseSkipped)

	// Phase 2: Batch-embed text descriptions in groups of embedBatchSize.
	for batchStart := 0; batchStart < len(toEmbed); batchStart += embedBatchSize {
		batchEnd := batchStart + embedBatchSize
		if batchEnd > len(toEmbed) {
			batchEnd = len(toEmbed)
		}
		batch := toEmbed[batchStart:batchEnd]

		texts := make([]string, len(batch))
		for i, e := range batch {
			texts[i] = e.description
		}

		log.Printf("[indexer] Resources: batch-embedding texts [%d:%d]/%d...", batchStart, batchEnd, len(toEmbed))
		textVecs, embErr := idx.emb.EmbedTexts(ctx, texts)
		if embErr != nil {
			log.Printf("[indexer] Resources: batch text embed [%d:%d] failed: %v", batchStart, batchEnd, embErr)
			phaseErrors += len(batch)
			continue
		}

		for i, e := range batch {
			r := e.parsed
			externalID := r.ID

			if upsertErr := idx.vec.Upsert(ctx, ownerID, externalID, kindResource, [][]float32{textVecs[i]}, e.meta, r.Tags); upsertErr != nil {
				log.Printf("[indexer] Resources: upsert error %s: %v", externalID, upsertErr)
				phaseErrors++
				continue
			}
			phaseIndexed++
			log.Printf("[indexer] Resource indexed: %s %q [%s] (hash=%s)", externalID, r.Name, strings.Join(r.Tags, ","), e.hash[:8])

			// Sprite image embedding (per-resource, requires cropping)
			if len(r.Frames) > 0 {
				frame := r.Frames[0]
				if spriteErr := idx.indexResourceSprite(ctx, ownerID, externalID, e.hash, e.meta, r.Tags, frame.TilesetID, frame.SrcCol, frame.SrcRow, frame.W, frame.H, hashToPath); spriteErr != nil {
					log.Printf("[indexer] Resources: sprite embed failed for %s: %v", externalID, spriteErr)
				}
			}
		}
	}

	res.Indexed += phaseIndexed
	res.Skipped += phaseSkipped
	res.Errors += phaseErrors
	log.Printf("[indexer] Resources done: indexed=%d skipped=%d errors=%d", phaseIndexed, phaseSkipped, phaseErrors)
	return scanned, nil
}

// indexOneResource indexes a single resource file (used by watch mode).
func (idx *DefaultIndexer) indexOneResource(
	ctx context.Context,
	ownerID, filePath string,
	existingHashes map[string]string,
	hashToPath map[string]string,
	scanned map[string]struct{},
) (indexed, skipped, errors int, err error) {
	content, readErr := os.ReadFile(filePath)
	if readErr != nil {
		return 0, 0, 1, fmt.Errorf("read %s: %w", filePath, readErr)
	}

	var r resourceJSON
	if parseErr := json.Unmarshal(content, &r); parseErr != nil {
		return 0, 0, 1, fmt.Errorf("parse %s: %w", filePath, parseErr)
	}

	externalID := r.ID
	scanned[externalID] = struct{}{}
	hash := hashBytes(content)

	if existingHashes[externalID] == hash {
		return 0, 1, 0, nil
	}

	tagValues := strings.Join(r.Tags, " ")
	tagValues = strings.ReplaceAll(tagValues, ":", " ")
	nameClean := strings.ReplaceAll(r.Name, ":", " ")
	description := strings.TrimSpace(nameClean + " " + tagValues)

	textEmb, embErr := idx.emb.EmbedText(ctx, description)
	if embErr != nil {
		return 0, 0, 1, fmt.Errorf("embed text %s: %w", externalID, embErr)
	}

	meta := map[string]any{
		"name":         r.Name,
		"tags":         r.Tags,
		"frameCount":   len(r.Frames),
		"content_hash": hash,
	}
	if len(r.Frames) > 0 {
		meta["tilesetId"] = r.Frames[0].TilesetID
	}

	if upsertErr := idx.vec.Upsert(ctx, ownerID, externalID, kindResource, [][]float32{textEmb}, meta, r.Tags); upsertErr != nil {
		return 0, 0, 1, fmt.Errorf("upsert resource %s: %w", externalID, upsertErr)
	}
	log.Printf("[indexer] Resource indexed: %s %q [%s] (hash=%s)", externalID, r.Name, strings.Join(r.Tags, ","), hash[:8])

	// Sprite image embedding
	if len(r.Frames) > 0 {
		frame := r.Frames[0]
		if spriteErr := idx.indexResourceSprite(ctx, ownerID, externalID, hash, meta, r.Tags, frame.TilesetID, frame.SrcCol, frame.SrcRow, frame.W, frame.H, hashToPath); spriteErr != nil {
			log.Printf("[indexer] Resources: sprite embed failed for %s: %v", externalID, spriteErr)
		}
	}

	return 1, 0, 0, nil
}

func (idx *DefaultIndexer) indexResourceSprite(
	ctx context.Context,
	ownerID, externalID, hash string,
	meta map[string]any,
	tags []string,
	tilesetID string, srcCol, srcRow, w, h int,
	hashToPath map[string]string,
) error {
	tilesetPath := idx.resolveTilesetPath(ctx, ownerID, tilesetID, hashToPath)
	if tilesetPath == "" {
		return fmt.Errorf("cannot resolve tileset %s", tilesetID[:min(12, len(tilesetID))])
	}

	tileW, tileH := parseTileSize(filepath.Base(tilesetPath))
	cropImg, err := cropSprite(tilesetPath, srcCol, srcRow, w, h, tileW, tileH)
	if err != nil {
		return fmt.Errorf("crop sprite: %w", err)
	}

	tmp, err := writeTempPNG(cropImg)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)

	imgEmb, err := idx.emb.EmbedImage(ctx, tmp)
	if err != nil {
		return fmt.Errorf("embed sprite: %w", err)
	}

	return idx.vec.Upsert(ctx, ownerID, externalID, kindResourceSprite, [][]float32{imgEmb}, meta, tags)
}

// ─── Composite indexing ──────────────────────────────────────────────────────

type compositeJSON struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Category string `json:"category"`
	Parts    []struct {
		Region struct {
			TilesetID string `json:"tilesetId"`
		} `json:"region"`
	} `json:"parts"`
	DisplaySize struct{ W, H int } `json:"displaySize"`
}

// compositeEntry holds pre-computed data for a composite that needs embedding.
type compositeEntry struct {
	parsed compositeJSON
	hash   string
	desc   string
	tags   []string
	meta   map[string]any
}

func (idx *DefaultIndexer) indexComposites(ctx context.Context, ownerID string, res *IndexResult) (map[string]struct{}, error) {
	dir := filepath.Join(idx.workspaceDir(ownerID), "composites")
	files, err := walkDir(dir, ".json")
	if err != nil {
		return nil, err
	}
	log.Printf("[indexer] Composites: found %d JSON files", len(files))

	existingHashes, _ := idx.vec.GetAllHashes(ctx, ownerID, kindComposite)
	scanned := make(map[string]struct{}, len(files))
	var phaseIndexed, phaseSkipped, phaseErrors int

	// Phase 1: Scan files, compute hashes, identify what needs embedding.
	var toEmbed []compositeEntry
	for _, filePath := range files {
		content, err := os.ReadFile(filePath)
		if err != nil {
			phaseErrors++
			continue
		}
		var c compositeJSON
		if err := json.Unmarshal(content, &c); err != nil {
			phaseErrors++
			continue
		}
		externalID := c.ID
		scanned[externalID] = struct{}{}
		hash := hashBytes(content)

		if existingHashes[externalID] == hash {
			phaseSkipped++
			continue
		}

		desc := fmt.Sprintf("%s %s composite with %d parts", c.Name, c.Category, len(c.Parts))
		tags := []string{"category:" + c.Category}
		meta := map[string]any{
			"name":         c.Name,
			"category":     c.Category,
			"partCount":    len(c.Parts),
			"displaySize":  c.DisplaySize,
			"content_hash": hash,
		}

		toEmbed = append(toEmbed, compositeEntry{
			parsed: c,
			hash:   hash,
			desc:   desc,
			tags:   tags,
			meta:   meta,
		})
	}

	log.Printf("[indexer] Composites: %d need embedding, %d skipped (unchanged)", len(toEmbed), phaseSkipped)

	// Phase 2: Batch-embed text descriptions in groups of embedBatchSize.
	for batchStart := 0; batchStart < len(toEmbed); batchStart += embedBatchSize {
		batchEnd := batchStart + embedBatchSize
		if batchEnd > len(toEmbed) {
			batchEnd = len(toEmbed)
		}
		batch := toEmbed[batchStart:batchEnd]

		texts := make([]string, len(batch))
		for i, e := range batch {
			texts[i] = e.desc
		}

		log.Printf("[indexer] Composites: batch-embedding texts [%d:%d]/%d...", batchStart, batchEnd, len(toEmbed))
		textVecs, embErr := idx.emb.EmbedTexts(ctx, texts)
		if embErr != nil {
			log.Printf("[indexer] Composites: batch text embed [%d:%d] failed: %v", batchStart, batchEnd, embErr)
			phaseErrors += len(batch)
			continue
		}

		for i, e := range batch {
			if upsertErr := idx.vec.Upsert(ctx, ownerID, e.parsed.ID, kindComposite, [][]float32{textVecs[i]}, e.meta, e.tags); upsertErr != nil {
				phaseErrors++
				continue
			}
			phaseIndexed++
			log.Printf("[indexer] Composite indexed: %s %q cat=%s (hash=%s)", e.parsed.ID, e.parsed.Name, e.parsed.Category, e.hash[:8])
		}
	}

	res.Indexed += phaseIndexed
	res.Skipped += phaseSkipped
	res.Errors += phaseErrors
	log.Printf("[indexer] Composites done: indexed=%d skipped=%d errors=%d", phaseIndexed, phaseSkipped, phaseErrors)
	return scanned, nil
}

// ─── Room indexing ───────────────────────────────────────────────────────────

type roomJSON struct {
	Name   string `json:"name"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Doors  []struct {
		ID     string `json:"id"`
		Col    int    `json:"col"`
		Row    int    `json:"row"`
		Target string `json:"target"`
	} `json:"doors"`
	Placements []any `json:"placements"`
}

// roomEntry holds pre-computed data for a room that needs embedding.
type roomEntry struct {
	parsed roomJSON
	hash   string
	desc   string
	meta   map[string]any
}

func (idx *DefaultIndexer) indexRooms(ctx context.Context, ownerID string, res *IndexResult) (map[string]struct{}, error) {
	dir := filepath.Join(idx.workspaceDir(ownerID), "rooms")
	files, err := walkDir(dir, ".json")
	if err != nil {
		return nil, err
	}
	log.Printf("[indexer] Rooms: found %d JSON files", len(files))

	existingHashes, _ := idx.vec.GetAllHashes(ctx, ownerID, kindRoom)
	scanned := make(map[string]struct{}, len(files))
	var phaseIndexed, phaseSkipped, phaseErrors int

	// Phase 1: Scan files, compute hashes, identify what needs embedding.
	var toEmbed []roomEntry
	for _, filePath := range files {
		content, err := os.ReadFile(filePath)
		if err != nil {
			phaseErrors++
			continue
		}
		var r roomJSON
		if err := json.Unmarshal(content, &r); err != nil {
			phaseErrors++
			continue
		}
		externalID := r.Name
		scanned[externalID] = struct{}{}
		hash := hashBytes(content)

		if existingHashes[externalID] == hash {
			phaseSkipped++
			continue
		}

		desc := fmt.Sprintf("room %s %dx%d with %d doors and %d placements",
			r.Name, r.Width, r.Height, len(r.Doors), len(r.Placements))
		meta := map[string]any{
			"name":           r.Name,
			"width":          r.Width,
			"height":         r.Height,
			"doorCount":      len(r.Doors),
			"placementCount": len(r.Placements),
			"content_hash":   hash,
		}

		toEmbed = append(toEmbed, roomEntry{
			parsed: r,
			hash:   hash,
			desc:   desc,
			meta:   meta,
		})
	}

	log.Printf("[indexer] Rooms: %d need embedding, %d skipped (unchanged)", len(toEmbed), phaseSkipped)

	// Phase 2: Batch-embed text descriptions in groups of embedBatchSize.
	for batchStart := 0; batchStart < len(toEmbed); batchStart += embedBatchSize {
		batchEnd := batchStart + embedBatchSize
		if batchEnd > len(toEmbed) {
			batchEnd = len(toEmbed)
		}
		batch := toEmbed[batchStart:batchEnd]

		texts := make([]string, len(batch))
		for i, e := range batch {
			texts[i] = e.desc
		}

		log.Printf("[indexer] Rooms: batch-embedding texts [%d:%d]/%d...", batchStart, batchEnd, len(toEmbed))
		textVecs, embErr := idx.emb.EmbedTexts(ctx, texts)
		if embErr != nil {
			log.Printf("[indexer] Rooms: batch text embed [%d:%d] failed: %v", batchStart, batchEnd, embErr)
			phaseErrors += len(batch)
			continue
		}

		for i, e := range batch {
			if upsertErr := idx.vec.Upsert(ctx, ownerID, e.parsed.Name, kindRoom, [][]float32{textVecs[i]}, e.meta, nil); upsertErr != nil {
				phaseErrors++
				continue
			}
			phaseIndexed++
			log.Printf("[indexer] Room indexed: %s %dx%d (hash=%s)", e.parsed.Name, e.parsed.Width, e.parsed.Height, e.hash[:8])
		}
	}

	res.Indexed += phaseIndexed
	res.Skipped += phaseSkipped
	res.Errors += phaseErrors
	log.Printf("[indexer] Rooms done: indexed=%d skipped=%d errors=%d", phaseIndexed, phaseSkipped, phaseErrors)
	return scanned, nil
}

// ─── Single-file indexing ────────────────────────────────────────────────────

func (idx *DefaultIndexer) indexSingleFile(ctx context.Context, ownerID, filePath string) error {
	relPath, err := filepath.Rel(idx.workspaceDir(ownerID), filePath)
	if err != nil {
		relPath = filePath
	}
	relPath = filepath.ToSlash(relPath)

	switch {
	case strings.HasPrefix(relPath, "tilesets/") && strings.HasSuffix(relPath, ".png"):
		return idx.indexSingleTileset(ctx, ownerID, filePath, relPath)
	case strings.HasPrefix(relPath, "resources/") && strings.HasSuffix(relPath, ".json"):
		_, _, _, err := idx.indexOneResource(ctx, ownerID, filePath, nil, nil, make(map[string]struct{}))
		return err
	case strings.HasPrefix(relPath, "composites/") && strings.HasSuffix(relPath, ".json"):
		dummy := IndexResult{}
		scanned := make(map[string]struct{})
		_, err := idx.indexComposites(ctx, ownerID, &dummy)
		_ = scanned
		return err
	case strings.HasPrefix(relPath, "rooms/") && strings.HasSuffix(relPath, ".json"):
		dummy := IndexResult{}
		_, err := idx.indexRooms(ctx, ownerID, &dummy)
		return err
	default:
		return nil // unknown file type — ignore
	}
}

func (idx *DefaultIndexer) indexSingleTileset(ctx context.Context, ownerID, filePath, relPath string) error {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return err
	}
	hash := hashBytes(data)

	existing, _ := idx.vec.GetItemMetadata(ctx, ownerID, kindTileset, hash)
	if existing != nil && existing["relPath"] == relPath {
		return nil // unchanged
	}

	tileW, tileH := parseTileSize(filepath.Base(filePath))
	imgW, imgH := imageSize(data)
	textLabel := textLabelFromRelPath(relPath)

	imgEmb, err := idx.emb.EmbedImage(ctx, filePath)
	if err != nil {
		return err
	}
	textEmb, err := idx.emb.EmbedText(ctx, textLabel)
	if err != nil {
		return err
	}

	cols, rows := 0, 0
	if tileW > 0 {
		cols = imgW / tileW
	}
	if tileH > 0 {
		rows = imgH / tileH
	}
	meta := map[string]any{
		"tileWidth": tileW, "tileHeight": tileH,
		"relPath": relPath,
		"width":   imgW, "height": imgH,
		"cols": cols, "rows": rows,
	}
	return idx.vec.Upsert(ctx, ownerID, hash, kindTileset, [][]float32{imgEmb, textEmb}, meta, nil)
}

// ─── Stale cleanup ───────────────────────────────────────────────────────────

func (idx *DefaultIndexer) deleteStale(ctx context.Context, ownerID, kind string, seen map[string]struct{}) (int, error) {
	existing, err := idx.vec.GetAllHashes(ctx, ownerID, kind)
	if err != nil {
		return 0, err
	}
	deleted := 0
	for id := range existing {
		if _, ok := seen[id]; !ok {
			if err := idx.vec.Delete(ctx, ownerID, id); err != nil {
				log.Printf("[indexer] delete stale %s/%s: %v", kind, id, err)
			} else {
				deleted++
			}
		}
	}
	if deleted > 0 {
		log.Printf("[indexer] %s: deleted %d stale entries", kind, deleted)
	}
	return deleted, nil
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// resolveTilesetPath looks up a tileset's filesystem path from its ID (hash or legacy path).
func (idx *DefaultIndexer) resolveTilesetPath(ctx context.Context, ownerID, tilesetID string, hashToPath map[string]string) string {
	// Full SHA-256 hash (64 hex chars)
	if len(tilesetID) == 64 {
		if p, ok := hashToPath[tilesetID]; ok {
			return p
		}
		// Fall back to metadata lookup
		meta, _ := idx.vec.GetItemMetadata(ctx, ownerID, kindTileset, tilesetID)
		if meta != nil {
			if relPath, ok := meta["relPath"].(string); ok {
				abs := filepath.Join(idx.workspaceDir(ownerID), relPath)
				if _, err := os.Stat(abs); err == nil {
					return abs
				}
			}
		}
		return ""
	}
	// Short hash (16 chars, used by TilesetService as ID)
	// Search in hashToPath for prefix match
	for h, p := range hashToPath {
		if strings.HasPrefix(h, tilesetID) {
			return p
		}
	}
	// Legacy path-based ID
	base := filepath.Join(idx.workspaceDir(ownerID), tilesetID)
	if _, err := os.Stat(base); err == nil {
		return base
	}
	if _, err := os.Stat(base + ".png"); err == nil {
		return base + ".png"
	}
	return ""
}

// walkDir recursively collects files with the given extension.
func walkDir(dir, ext string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable dirs
		}
		if !d.IsDir() && strings.HasSuffix(strings.ToLower(d.Name()), ext) {
			files = append(files, path)
		}
		return nil
	})
	return files, err
}

// hashBytes returns the hex SHA-256 of data.
func hashBytes(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

// parseTileSize extracts tile dimensions from a filename like "foo_48x48.png".
func parseTileSize(filename string) (int, int) {
	m := tileSizeRe.FindStringSubmatch(strings.ToLower(filename))
	if m != nil {
		var w, h int
		fmt.Sscan(m[1], &w)
		fmt.Sscan(m[2], &h)
		if w > 0 && h > 0 {
			return w, h
		}
	}
	return defaultTileSize, defaultTileSize
}

// imageSize decodes just the image config to read width/height without full decode.
func imageSize(data []byte) (int, int) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0
	}
	return cfg.Width, cfg.Height
}

// textLabelFromRelPath converts "tilesets/foo/bar_48x48.png" → "foo bar".
func textLabelFromRelPath(relPath string) string {
	s := strings.TrimPrefix(relPath, "tilesets/")
	s = strings.TrimSuffix(s, filepath.Ext(s))
	s = strings.ReplaceAll(s, "_", " ")
	s = strings.ReplaceAll(s, "/", " ")
	s = strings.ReplaceAll(s, "\\", " ")
	// Remove trailing dimension token e.g. "48 48" → ""
	parts := strings.Fields(s)
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		var n int
		if _, err := fmt.Sscan(p, &n); err == nil {
			continue // skip pure numbers (e.g. "48" from "48x48")
		}
		out = append(out, p)
	}
	return strings.Join(out, " ")
}

// cropSprite extracts a tile region from a PNG file.
func cropSprite(tilesetPath string, srcCol, srcRow, w, h, tileW, tileH int) (image.Image, error) {
	f, err := os.Open(tilesetPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	src, err := png.Decode(f)
	if err != nil {
		return nil, err
	}

	x0 := srcCol * tileW
	y0 := srcRow * tileH
	x1 := x0 + w*tileW
	y1 := y0 + h*tileH

	dst := image.NewRGBA(image.Rect(0, 0, x1-x0, y1-y0))
	draw.Copy(dst, image.Point{}, src, image.Rect(x0, y0, x1, y1), draw.Over, nil)
	return dst, nil
}

// writeTempPNG writes img to a temp file and returns its path.
// Caller is responsible for deleting it.
func writeTempPNG(img image.Image) (string, error) {
	f, err := os.CreateTemp("", "sprite-*.png")
	if err != nil {
		return "", err
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		os.Remove(f.Name())
		return "", err
	}
	// Convert to RGBA so CLIP sees proper colours
	return f.Name(), nil
}

// watchRecursive adds dir and all its subdirectories to the watcher.
func watchRecursive(w *fsnotify.Watcher, dir string) error {
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		return w.Add(path)
	})
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
