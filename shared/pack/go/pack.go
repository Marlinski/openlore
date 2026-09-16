// Package pack provides the pack format library for OpenLore.
// A pack is a bundle of rooms, resources, tilesets, composites and masks.
// Studio authors packs; the game server loads them and runs sessions on them.
package pack

import (
	pb "github.com/openlore/shared/pack/pb/packv1"
)

// Pack wraps the generated protobuf Pack message with convenience methods.
type Pack struct {
	*pb.Pack
}

// New returns an empty pack with the given ID and name.
func New(id, name string) *Pack {
	return &Pack{
		Pack: &pb.Pack{
			Manifest: &pb.PackManifest{
				Id:   id,
				Name: name,
			},
		},
	}
}

// FromProto wraps an existing protobuf Pack message.
func FromProto(p *pb.Pack) *Pack {
	if p == nil {
		return nil
	}
	return &Pack{Pack: p}
}
