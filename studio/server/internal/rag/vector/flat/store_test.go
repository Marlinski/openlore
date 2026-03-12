package flat

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestUpsertAndSearch(t *testing.T) {
	s, err := New("")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// Insert two items with normalised vectors.
	v1 := normalise([]float32{1, 0, 0})
	v2 := normalise([]float32{0, 1, 0})
	v3 := normalise([]float32{0.9, 0.1, 0}) // close to v1

	must(t, s.Upsert(ctx, "o", "a", "tileset", [][]float32{v1}, map[string]any{"content_hash": "h1"}, []string{"tag:grass"}))
	must(t, s.Upsert(ctx, "o", "b", "tileset", [][]float32{v2}, map[string]any{"content_hash": "h2"}, []string{"tag:water"}))
	must(t, s.Upsert(ctx, "o", "c", "tileset", [][]float32{v3}, map[string]any{"content_hash": "h3"}, []string{"tag:grass", "tag:dirt"}))

	// Search with query close to v1 — should return c, then a, then b.
	results, err := s.Search(ctx, "o", normalise([]float32{1, 0.05, 0}), "tileset", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %d", len(results))
	}
	// First result should be closest to query.
	if results[0].ID != "a" && results[0].ID != "c" {
		t.Errorf("expected first result to be 'a' or 'c', got %q", results[0].ID)
	}
	// Last should be 'b' (orthogonal).
	if results[2].ID != "b" {
		t.Errorf("expected last result to be 'b', got %q", results[2].ID)
	}
	// Scores should be ascending.
	for i := 1; i < len(results); i++ {
		if results[i].Score < results[i-1].Score {
			t.Errorf("results not sorted: score[%d]=%f < score[%d]=%f", i, results[i].Score, i-1, results[i-1].Score)
		}
	}
}

func TestSearchByKind(t *testing.T) {
	s, err := New("")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	v := normalise([]float32{1, 0, 0})
	must(t, s.Upsert(ctx, "o", "a", "tileset", [][]float32{v}, map[string]any{"content_hash": "h1"}, nil))
	must(t, s.Upsert(ctx, "o", "b", "resource", [][]float32{v}, map[string]any{"content_hash": "h2"}, nil))

	results, err := s.Search(ctx, "o", v, "tileset", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].ID != "a" {
		t.Errorf("expected 1 tileset result 'a', got %v", results)
	}

	// Empty kind searches across all kinds.
	results, err = s.Search(ctx, "o", v, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 results for empty kind, got %d", len(results))
	}
}

func TestMultipleVectorsPerItem(t *testing.T) {
	s, err := New("")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	imgVec := normalise([]float32{1, 0, 0})
	txtVec := normalise([]float32{0, 1, 0})
	must(t, s.Upsert(ctx, "o", "a", "tileset", [][]float32{imgVec, txtVec}, map[string]any{"content_hash": "h"}, nil))

	// Search with text-like query — should still find item via its text vector.
	results, err := s.Search(ctx, "o", normalise([]float32{0, 0.9, 0.1}), "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].ID != "a" {
		t.Fatalf("expected result 'a', got %v", results)
	}
	// Distance should be small (vectors are close).
	if results[0].Score > 0.1 {
		t.Errorf("expected low distance, got %f", results[0].Score)
	}
}

func TestDeleteAndGetAllHashes(t *testing.T) {
	s, err := New("")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	v := normalise([]float32{1, 0, 0})
	must(t, s.Upsert(ctx, "o", "a", "tileset", [][]float32{v}, map[string]any{"content_hash": "ha"}, nil))
	must(t, s.Upsert(ctx, "o", "b", "tileset", [][]float32{v}, map[string]any{"content_hash": "hb"}, nil))

	hashes, err := s.GetAllHashes(ctx, "o", "tileset")
	if err != nil {
		t.Fatal(err)
	}
	if len(hashes) != 2 {
		t.Fatalf("expected 2 hashes, got %d", len(hashes))
	}
	if hashes["a"] != "ha" || hashes["b"] != "hb" {
		t.Errorf("unexpected hashes: %v", hashes)
	}

	must(t, s.Delete(ctx, "o", "a"))
	hashes, err = s.GetAllHashes(ctx, "o", "tileset")
	if err != nil {
		t.Fatal(err)
	}
	if len(hashes) != 1 || hashes["b"] != "hb" {
		t.Errorf("after delete: %v", hashes)
	}
}

func TestTags(t *testing.T) {
	s, err := New("")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	v := normalise([]float32{1, 0, 0})
	must(t, s.Upsert(ctx, "o", "a", "t", [][]float32{v}, map[string]any{"content_hash": ""}, []string{"cat:grass", "cat:dirt"}))
	must(t, s.Upsert(ctx, "o", "b", "t", [][]float32{v}, map[string]any{"content_hash": ""}, []string{"cat:grass", "style:pixel"}))

	tags, err := s.Tags(ctx, "o", "cat:", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) == 0 {
		t.Fatal("expected tags")
	}
	// "cat:grass" appears in 2 items, should be first.
	if tags[0] != "cat:grass" {
		t.Errorf("expected first tag 'cat:grass', got %q", tags[0])
	}
}

func TestPersistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vectors.json")

	s1, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	v := normalise([]float32{1, 0, 0})
	must(t, s1.Upsert(ctx, "o", "x", "tileset", [][]float32{v}, map[string]any{"content_hash": "hx", "name": "grass"}, []string{"tag:green"}))
	must(t, s1.Flush())

	// Open a new store from the same file.
	s2, err := New(path)
	if err != nil {
		t.Fatal(err)
	}

	hashes, err := s2.GetAllHashes(ctx, "o", "tileset")
	if err != nil {
		t.Fatal(err)
	}
	if hashes["x"] != "hx" {
		t.Errorf("persistence failed: %v", hashes)
	}

	results, err := s2.Search(ctx, "o", v, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].ID != "x" {
		t.Errorf("search after reload failed: %v", results)
	}

	// Verify file exists on disk.
	if _, err := os.Stat(path); err != nil {
		t.Errorf("expected file at %s: %v", path, err)
	}
}

func TestStats(t *testing.T) {
	s, err := New("")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	v := normalise([]float32{1, 0, 0})
	must(t, s.Upsert(ctx, "o", "a", "tileset", [][]float32{v}, map[string]any{"content_hash": ""}, nil))
	must(t, s.Upsert(ctx, "o", "b", "tileset", [][]float32{v}, map[string]any{"content_hash": ""}, nil))
	must(t, s.Upsert(ctx, "o", "c", "resource", [][]float32{v}, map[string]any{"content_hash": ""}, nil))

	stats, err := s.Stats(ctx, "o")
	if err != nil {
		t.Fatal(err)
	}
	if stats["tileset"] != 2 || stats["resource"] != 1 {
		t.Errorf("unexpected stats: %v", stats)
	}
}

func TestUpsertOverwrite(t *testing.T) {
	s, err := New("")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	v1 := normalise([]float32{1, 0, 0})
	v2 := normalise([]float32{0, 1, 0})
	must(t, s.Upsert(ctx, "o", "a", "t", [][]float32{v1}, map[string]any{"content_hash": "old"}, []string{"old"}))
	must(t, s.Upsert(ctx, "o", "a", "t", [][]float32{v2}, map[string]any{"content_hash": "new"}, []string{"new"}))

	hashes, _ := s.GetAllHashes(ctx, "o", "t")
	if hashes["a"] != "new" {
		t.Errorf("upsert didn't overwrite hash: %v", hashes)
	}

	// Search should find item 'a' near v2 now, not v1.
	results, _ := s.Search(ctx, "o", v2, "", 1)
	if len(results) != 1 || results[0].Score > 0.01 {
		t.Errorf("upsert didn't overwrite vector: %v", results)
	}
}

// ─── test helpers ────────────────────────────────────────────────────────────

func normalise(v []float32) []float32 {
	var sum float64
	for _, x := range v {
		sum += float64(x) * float64(x)
	}
	norm := float32(math.Sqrt(sum))
	out := make([]float32, len(v))
	for i := range v {
		out[i] = v[i] / norm
	}
	return out
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
