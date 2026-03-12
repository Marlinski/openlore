package pack

import (
	"fmt"
	"os"
	"path/filepath"

	pb "github.com/offisims/shared/pack/pb/packv1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

var unmarshaler = protojson.UnmarshalOptions{DiscardUnknown: true}

// Open reads a pack from a directory containing manifest.json and
// subdirectories of JSON entity files. Missing subdirectories are
// silently skipped (resulting in empty slices).
func Open(dir string) (*Pack, error) {
	p := &pb.Pack{}

	// Read manifest
	manifest, err := OpenManifest(dir)
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}
	p.Manifest = manifest

	// Read entity collections from subdirectories
	if err := readDir(filepath.Join(dir, "tilesets"), func(data []byte) error {
		m := &pb.TilesetDefinition{}
		if err := unmarshaler.Unmarshal(data, m); err != nil {
			return err
		}
		p.Tilesets = append(p.Tilesets, m)
		return nil
	}); err != nil {
		return nil, fmt.Errorf("read tilesets: %w", err)
	}

	if err := readDir(filepath.Join(dir, "composites"), func(data []byte) error {
		m := &pb.CompositeObject{}
		if err := unmarshaler.Unmarshal(data, m); err != nil {
			return err
		}
		p.Composites = append(p.Composites, m)
		return nil
	}); err != nil {
		return nil, fmt.Errorf("read composites: %w", err)
	}

	if err := readDir(filepath.Join(dir, "rooms"), func(data []byte) error {
		m := &pb.RoomDefinition{}
		if err := unmarshaler.Unmarshal(data, m); err != nil {
			return err
		}
		p.Rooms = append(p.Rooms, m)
		return nil
	}); err != nil {
		return nil, fmt.Errorf("read rooms: %w", err)
	}

	if err := readDir(filepath.Join(dir, "resources"), func(data []byte) error {
		m := &pb.Resource{}
		if err := unmarshaler.Unmarshal(data, m); err != nil {
			return err
		}
		p.Resources = append(p.Resources, m)
		return nil
	}); err != nil {
		return nil, fmt.Errorf("read resources: %w", err)
	}

	if err := readDir(filepath.Join(dir, "masks"), func(data []byte) error {
		m := &pb.Mask{}
		if err := unmarshaler.Unmarshal(data, m); err != nil {
			return err
		}
		p.Masks = append(p.Masks, m)
		return nil
	}); err != nil {
		return nil, fmt.Errorf("read masks: %w", err)
	}

	return &Pack{Pack: p}, nil
}

// OpenManifest reads only the manifest.json from a pack directory.
func OpenManifest(dir string) (*pb.PackManifest, error) {
	data, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return nil, err
	}
	m := &pb.PackManifest{}
	if err := unmarshaler.Unmarshal(data, m); err != nil {
		return nil, fmt.Errorf("unmarshal manifest: %w", err)
	}
	return m, nil
}

// readDir reads all .json files from a directory, calling fn for each.
// Returns nil if the directory does not exist.
func readDir(dir string, fn func(data []byte) error) error {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			return fmt.Errorf("read %s: %w", entry.Name(), err)
		}
		if err := fn(data); err != nil {
			return fmt.Errorf("unmarshal %s: %w", entry.Name(), err)
		}
	}
	return nil
}

// Ensure Pack implements proto.Message (it embeds *pb.Pack which does).
var _ proto.Message = (*pb.Pack)(nil)
