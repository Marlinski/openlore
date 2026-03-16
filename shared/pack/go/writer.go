package pack

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"

	pb "github.com/offisims/shared/pack/pb/packv1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

var marshaler = protojson.MarshalOptions{
	Multiline:       true,
	Indent:          "  ",
	EmitUnpopulated: true,
}

// Write writes a pack to a directory as JSON files.
// Creates the directory and subdirectories as needed.
func Write(dir string, p *Pack) error {
	if p.Manifest == nil {
		return fmt.Errorf("pack has no manifest")
	}

	// Write manifest
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(dir, "manifest.json"), p.Manifest); err != nil {
		return fmt.Errorf("write manifest: %w", err)
	}

	// Write entity collections
	if err := writeEntities(filepath.Join(dir, "tilesets"), p.Tilesets, func(t *pb.TilesetDefinition) string { return t.Id }); err != nil {
		return fmt.Errorf("write tilesets: %w", err)
	}
	if err := writeEntities(filepath.Join(dir, "composites"), p.Composites, func(c *pb.CompositeObject) string { return c.Id }); err != nil {
		return fmt.Errorf("write composites: %w", err)
	}
	if err := writeEntities(filepath.Join(dir, "rooms"), p.Rooms, func(r *pb.RoomDefinition) string { return r.Name }); err != nil {
		return fmt.Errorf("write rooms: %w", err)
	}
	if err := writeEntities(filepath.Join(dir, "resources"), p.Resources, func(r *pb.Resource) string { return r.Id }); err != nil {
		return fmt.Errorf("write resources: %w", err)
	}
	if err := writeEntities(filepath.Join(dir, "masks"), p.Masks, func(m *pb.Mask) string { return m.Id }); err != nil {
		return fmt.Errorf("write masks: %w", err)
	}

	return nil
}

// WriteBinary writes the entire pack as a single binary protobuf file.
func WriteBinary(path string, p *Pack) error {
	data, err := proto.Marshal(p.Pack)
	if err != nil {
		return fmt.Errorf("marshal pack: %w", err)
	}
	return atomicWrite(path, data)
}

// WriteZip writes a pack as a .offpack ZIP archive.
// The ZIP contains manifest.json (human-readable) and pack.pb (binary data).
func WriteZip(path string, p *Pack) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	w := zip.NewWriter(f)
	defer w.Close()

	// Write manifest.json (human-readable)
	manifestData, err := marshaler.Marshal(p.Manifest)
	if err != nil {
		return fmt.Errorf("marshal manifest: %w", err)
	}
	mw, err := w.Create("manifest.json")
	if err != nil {
		return err
	}
	if _, err := mw.Write(manifestData); err != nil {
		return err
	}

	// Write pack.pb (binary protobuf — all data)
	packData, err := proto.Marshal(p.Pack)
	if err != nil {
		return fmt.Errorf("marshal pack: %w", err)
	}
	pw, err := w.Create("pack.pb")
	if err != nil {
		return err
	}
	if _, err := pw.Write(packData); err != nil {
		return err
	}

	return nil
}

// ReadBinary reads a pack from a single binary protobuf file.
func ReadBinary(path string) (*Pack, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	p := &pb.Pack{}
	if err := proto.Unmarshal(data, p); err != nil {
		return nil, fmt.Errorf("unmarshal pack: %w", err)
	}
	return &Pack{Pack: p}, nil
}

// ReadZip reads a pack from a .offpack ZIP archive.
func ReadZip(path string) (*Pack, error) {
	r, err := zip.OpenReader(path)
	if err != nil {
		return nil, err
	}
	defer r.Close()

	for _, f := range r.File {
		if f.Name == "pack.pb" {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			data, err := io.ReadAll(rc)
			if err != nil {
				return nil, err
			}
			p := &pb.Pack{}
			if err := proto.Unmarshal(data, p); err != nil {
				return nil, fmt.Errorf("unmarshal pack.pb: %w", err)
			}
			return &Pack{Pack: p}, nil
		}
	}
	return nil, fmt.Errorf("pack.pb not found in archive")
}

// writeEntities writes a slice of proto messages to a directory, one JSON file per entity.
func writeEntities[T proto.Message](dir string, entities []T, idFn func(T) string) error {
	if len(entities) == 0 {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, e := range entities {
		id := idFn(e)
		if id == "" {
			id = "unnamed"
		}
		if err := writeJSON(filepath.Join(dir, id+".json"), e); err != nil {
			return err
		}
	}
	return nil
}

// writeJSON marshals a proto message to JSON and writes it atomically.
func writeJSON(path string, m proto.Message) error {
	data, err := marshaler.Marshal(m)
	if err != nil {
		return err
	}
	return atomicWrite(path, data)
}

// atomicWrite writes data to a temp file then renames to the target path.
func atomicWrite(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
