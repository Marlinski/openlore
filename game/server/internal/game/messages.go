package game

// JSON message types for the WebSocket protocol.
// These match the existing Node.js/TypeScript protocol exactly so the
// current SolidJS client continues to work unchanged.
//
// Phase 7 (client migration to Preact) will switch to binary protobuf
// using the generated types in pb/protocolv1. Until then, JSON text frames.

// ─── Shared snapshots ────────────────────────────────────────────

// AvatarSnapshot is the JSON shape sent to clients for avatar state.
type AvatarSnapshot struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	CharacterID string  `json:"characterId"`
	Room        string  `json:"room"`
	X           float64 `json:"x"`
	Y           float64 `json:"y"`
	Direction   string  `json:"direction"`
	Moving      bool    `json:"moving"`
	Family      string  `json:"family"`
}

// RoomSnapshot is the JSON shape sent to clients for room state.
type RoomSnapshot struct {
	Name   string `json:"name"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

// ─── Client → Server ─────────────────────────────────────────────

// ClientMessage is the raw JSON envelope from the client.
// The Type field determines which fields are populated.
type ClientMessage struct {
	Type      string  `json:"type"`
	Token     string  `json:"token,omitempty"`     // join
	X         float64 `json:"x,omitempty"`         // position
	Y         float64 `json:"y,omitempty"`         // position
	Direction string  `json:"direction,omitempty"` // position
	Moving    bool    `json:"moving,omitempty"`    // position
	DoorID    string  `json:"doorId,omitempty"`    // use-door
}

// ─── Server → Client ─────────────────────────────────────────────

// ServerWelcome is sent after a successful join.
type ServerWelcome struct {
	Type     string           `json:"type"`
	AvatarID string           `json:"avatarId"`
	Room     RoomSnapshot     `json:"room"`
	SpawnX   float64          `json:"spawnX"`
	SpawnY   float64          `json:"spawnY"`
	Avatars  []AvatarSnapshot `json:"avatars"`
}

// ServerAvatarJoin is broadcast when a new avatar enters a room.
type ServerAvatarJoin struct {
	Type   string         `json:"type"`
	Avatar AvatarSnapshot `json:"avatar"`
}

// ServerAvatarLeave is broadcast when an avatar leaves a room.
type ServerAvatarLeave struct {
	Type     string `json:"type"`
	AvatarID string `json:"avatarId"`
}

// ServerAvatarMove is broadcast when an avatar moves.
type ServerAvatarMove struct {
	Type      string  `json:"type"`
	AvatarID  string  `json:"avatarId"`
	X         float64 `json:"x"`
	Y         float64 `json:"y"`
	Direction string  `json:"direction"`
	Moving    bool    `json:"moving"`
}

// ServerRoomChange is sent when an avatar transitions to a new room.
type ServerRoomChange struct {
	Type    string           `json:"type"`
	Room    RoomSnapshot     `json:"room"`
	SpawnX  float64          `json:"spawnX"`
	SpawnY  float64          `json:"spawnY"`
	Avatars []AvatarSnapshot `json:"avatars"`
}

// ServerSnap corrects the client's avatar position.
type ServerSnap struct {
	Type string  `json:"type"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
}

// ServerError reports an error to the client.
type ServerError struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}
