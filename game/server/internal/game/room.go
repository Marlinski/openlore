package game

import (
	"math"
	"math/rand"

	pb "github.com/offisims/shared/pack/pb/packv1"
)

// tileSize is the pixel size of a tile for walkability checks and spawning.
// Matches the TILE_SIZE constant in shared/js/types.ts.
const tileSize = 48

// Room is the runtime representation of a room in the game world.
// Owns the walkability grid, door definitions, and tracks avatar presence.
// Owned exclusively by the World goroutine.
type Room struct {
	Name        string
	Width       int // tiles
	Height      int // tiles
	Walkability []bool
	Doors       []*pb.DoorDefinition
	AvatarIDs   map[string]struct{} // set of avatar IDs in this room
}

// NewRoom creates a Room from a proto RoomDefinition.
func NewRoom(def *pb.RoomDefinition) *Room {
	walk := make([]bool, len(def.Walkability))
	copy(walk, def.Walkability)

	doors := make([]*pb.DoorDefinition, len(def.Doors))
	copy(doors, def.Doors)

	return &Room{
		Name:        def.Name,
		Width:       int(def.Width),
		Height:      int(def.Height),
		Walkability: walk,
		Doors:       doors,
		AvatarIDs:   make(map[string]struct{}),
	}
}

// IsWalkable checks if a pixel position is walkable.
// Converts pixel coords to tile coords and checks the walkability grid.
func (r *Room) IsWalkable(px, py float64) bool {
	col := int(math.Floor(px / tileSize))
	row := int(math.Floor(py / tileSize))

	if col < 0 || col >= r.Width || row < 0 || row >= r.Height {
		return false
	}

	idx := row*r.Width + col
	if idx < 0 || idx >= len(r.Walkability) {
		return false
	}

	return r.Walkability[idx]
}

// GetDoor finds a door by ID, or nil if not found.
func (r *Room) GetDoor(doorID string) *pb.DoorDefinition {
	for _, d := range r.Doors {
		if d.Id == doorID {
			return d
		}
	}
	return nil
}

// ToSnapshot returns a JSON-serializable room snapshot for clients.
func (r *Room) ToSnapshot() RoomSnapshot {
	return RoomSnapshot{
		Name:   r.Name,
		Width:  r.Width,
		Height: r.Height,
	}
}

// FindSpawnPosition finds a suitable spawn position.
// If preferDoorID is non-empty, spawn at that door's tile center.
// Otherwise, pick a random walkable non-door tile.
// Returns pixel coordinates (center of tile).
func (r *Room) FindSpawnPosition(preferDoorID string) (x, y float64) {
	// Door transition — spawn at the target door
	if preferDoorID != "" {
		if door := r.GetDoor(preferDoorID); door != nil {
			return float64(door.Col)*tileSize + tileSize/2,
				float64(door.Row)*tileSize + tileSize/2
		}
	}

	// Build set of door tile indices for exclusion
	doorTiles := make(map[int]struct{})
	for _, d := range r.Doors {
		col := int(d.Col)
		row := int(d.Row)
		if col >= 0 && col < r.Width && row >= 0 && row < r.Height {
			doorTiles[row*r.Width+col] = struct{}{}
		}
	}

	// Gather walkable non-door tiles
	var candidates []int
	for i, w := range r.Walkability {
		if w {
			if _, isDoor := doorTiles[i]; !isDoor {
				candidates = append(candidates, i)
			}
		}
	}

	// Pick random candidate
	if len(candidates) > 0 {
		idx := candidates[rand.Intn(len(candidates))]
		col := idx % r.Width
		row := idx / r.Width
		return float64(col)*tileSize + tileSize/2,
			float64(row)*tileSize + tileSize/2
	}

	// Fallback: any walkable tile
	for i, w := range r.Walkability {
		if w {
			col := i % r.Width
			row := i / r.Width
			return float64(col)*tileSize + tileSize/2,
				float64(row)*tileSize + tileSize/2
		}
	}

	// Last resort: center of room
	return float64(r.Width*tileSize) / 2,
		float64(r.Height*tileSize) / 2
}
