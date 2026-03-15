package game

import (
	"log"
	"strings"
)

// ─── Avatar lifecycle ────────────────────────────────────────────

// handleJoin handles a client joining the game.
// The token identifies a registered player. If the token maps to a live avatar
// (still connected via another tab), the connection reattaches. Otherwise a new
// avatar is spawned.
func (w *World) handleJoin(connID, token string) {
	// Prevent double-join from the same connection
	if _, already := w.connAvatars[connID]; already {
		w.sendToConn(connID, &ServerError{
			Type:    "error",
			Message: "Already joined. Disconnect first.",
		})
		return
	}

	// Try reconnection to existing avatar
	if existingID, ok := w.tokenAvatars[token]; ok {
		if avatar, ok := w.avatars[existingID]; ok {
			w.reconnectAvatar(connID, existingID, avatar)
			return
		}
	}

	// New avatar from player record
	w.spawnAvatar(connID, token)
}

func (w *World) reconnectAvatar(connID, avatarID string, avatar *Avatar) {
	log.Printf("[World %s] %s (%s) added connection (multi-tab)",
		w.Channel, avatar.Name, avatarID)

	w.addConn(connID, avatarID)

	room := w.rooms[avatar.Room]
	w.sendToConn(connID, &ServerWelcome{
		Type:     "welcome",
		AvatarID: avatar.ID,
		Room:     room.ToSnapshot(),
		SpawnX:   avatar.X,
		SpawnY:   avatar.Y,
		Avatars:  w.getAvatarsInRoom(avatar.Room),
	})
}

func (w *World) spawnAvatar(connID, token string) {
	player := w.players.GetByToken(token)
	if player == nil {
		w.sendToConn(connID, &ServerError{
			Type:    "error",
			Message: "Invalid or expired session.",
		})
		return
	}

	room, ok := w.rooms[w.defaultRoom]
	if !ok {
		w.sendToConn(connID, &ServerError{
			Type:    "error",
			Message: "Room \"" + w.defaultRoom + "\" not found.",
		})
		return
	}

	spawnX, spawnY := room.FindSpawnPosition("")
	avatar := newAvatar(token, player.Name, player.CharacterID, w.defaultRoom, spawnX, spawnY)

	w.avatars[avatar.ID] = avatar
	w.tokenAvatars[token] = avatar.ID
	w.addConn(connID, avatar.ID)
	room.AvatarIDs[avatar.ID] = struct{}{}
	w.players_.Add(1)

	w.sendToConn(connID, &ServerWelcome{
		Type:     "welcome",
		AvatarID: avatar.ID,
		Room:     room.ToSnapshot(),
		SpawnX:   spawnX,
		SpawnY:   spawnY,
		Avatars:  w.getAvatarsInRoom(w.defaultRoom),
	})

	w.broadcastToRoom(w.defaultRoom, &ServerAvatarJoin{
		Type:   "avatar-join",
		Avatar: avatar.toSnapshot(),
	}, excludeAvatar(avatar.ID))

	log.Printf("[World %s] %s (%s) joined room %q",
		w.Channel, avatar.Name, avatar.ID, w.defaultRoom)
}

// handleDisconnect handles a WebSocket close.
// Removes the connection from the avatar. If it was the last connection,
// the avatar is removed immediately.
func (w *World) handleDisconnect(connID string) {
	avatarID, ok := w.connAvatars[connID]
	if !ok {
		return
	}
	avatar := w.avatars[avatarID]
	if avatar == nil {
		return
	}

	w.removeConn(connID, avatarID)

	if conns := w.avatarConns[avatarID]; len(conns) > 0 {
		log.Printf("[World %s] %s (%s) lost a connection, %d remaining",
			w.Channel, avatar.Name, avatarID, len(conns))
		return
	}

	// Last connection gone — remove avatar immediately
	log.Printf("[World %s] %s (%s) disconnected, removing",
		w.Channel, avatar.Name, avatarID)

	delete(w.avatarConns, avatarID)
	w.removeAvatar(avatarID)
}

// handleLeave handles an explicit leave message.
// Immediately removes the avatar.
func (w *World) handleLeave(connID string) {
	avatarID, ok := w.connAvatars[connID]
	if !ok {
		return
	}

	// Remove ALL connections for this avatar
	if conns, ok := w.avatarConns[avatarID]; ok {
		for cid := range conns {
			delete(w.connAvatars, cid)
		}
	}
	delete(w.avatarConns, avatarID)

	w.removeAvatar(avatarID)
}

// removeAvatar cleans up an avatar entirely — room, chat, all maps.
func (w *World) removeAvatar(avatarID string) {
	avatar := w.avatars[avatarID]
	if avatar == nil {
		return
	}

	if room, ok := w.rooms[avatar.Room]; ok {
		delete(room.AvatarIDs, avatarID)
		w.broadcastToRoom(avatar.Room, &ServerAvatarLeave{
			Type:     "avatar-leave",
			AvatarID: avatarID,
		}, nil)
	}

	delete(w.tokenAvatars, avatar.Token)

	if conns, ok := w.avatarConns[avatarID]; ok {
		for cid := range conns {
			delete(w.connAvatars, cid)
		}
	}
	delete(w.avatarConns, avatarID)
	delete(w.avatars, avatarID)
	w.players_.Add(-1)

	log.Printf("[World %s] %s (%s) removed", w.Channel, avatar.Name, avatarID)
}

// ─── Position updates ────────────────────────────────────────────

func (w *World) handlePosition(connID string, x, y float64, direction string, moving bool) {
	avatarID, ok := w.connAvatars[connID]
	if !ok {
		return
	}
	avatar := w.avatars[avatarID]
	if avatar == nil {
		return
	}
	room := w.rooms[avatar.Room]
	if room == nil {
		return
	}

	if !room.IsWalkable(x, y) {
		w.sendSnap(connID, avatar)
		return
	}

	maxX := float64(room.Width * tileSize)
	maxY := float64(room.Height * tileSize)
	if x < 0 || x > maxX || y < 0 || y > maxY {
		w.sendSnap(connID, avatar)
		return
	}

	avatar.X = x
	avatar.Y = y
	avatar.Direction = direction
	avatar.Moving = moving
	if moving {
		avatar.Family = "walk"
	} else {
		avatar.Family = "idle"
	}
	avatar.LastUpdate = nowMillis()

	// Exclude only the sending connection (not the whole avatar) so
	// other tabs of the same avatar still receive the update.
	w.broadcastToRoom(avatar.Room, &ServerAvatarMove{
		Type:      "avatar-move",
		AvatarID:  avatarID,
		X:         x,
		Y:         y,
		Direction: direction,
		Moving:    moving,
	}, excludeConn(connID))
}

func (w *World) sendSnap(connID string, avatar *Avatar) {
	w.sendToConn(connID, &ServerSnap{
		Type: "snap",
		X:    avatar.X,
		Y:    avatar.Y,
	})
}

// ─── Door transitions ────────────────────────────────────────────

func (w *World) handleUseDoor(connID, doorID string) {
	avatarID, ok := w.connAvatars[connID]
	if !ok {
		return
	}
	avatar := w.avatars[avatarID]
	if avatar == nil {
		return
	}
	room := w.rooms[avatar.Room]
	if room == nil {
		return
	}

	door := room.GetDoor(doorID)
	if door == nil {
		w.sendToConn(connID, &ServerError{
			Type:    "error",
			Message: "Door \"" + doorID + "\" not found in room \"" + avatar.Room + "\".",
		})
		return
	}

	if door.Target == "" {
		w.sendToConn(connID, &ServerError{
			Type:    "error",
			Message: "This door is not linked to anywhere.",
		})
		return
	}

	// Parse "roomName#doorId"
	parts := strings.SplitN(door.Target, "#", 2)
	targetRoomName := parts[0]
	targetDoorID := ""
	if len(parts) == 2 {
		targetDoorID = parts[1]
	}

	targetRoom, ok := w.rooms[targetRoomName]
	if !ok {
		w.sendToConn(connID, &ServerError{
			Type:    "error",
			Message: "Target room \"" + targetRoomName + "\" not found.",
		})
		return
	}

	spawnX, spawnY := targetRoom.FindSpawnPosition(targetDoorID)

	// Leave current room
	delete(room.AvatarIDs, avatarID)
	w.broadcastToRoom(avatar.Room, &ServerAvatarLeave{
		Type:     "avatar-leave",
		AvatarID: avatarID,
	}, nil)

	// Enter new room
	avatar.Room = targetRoomName
	avatar.X = spawnX
	avatar.Y = spawnY
	avatar.Moving = false
	avatar.Family = "idle"
	targetRoom.AvatarIDs[avatarID] = struct{}{}

	// Send room change to ALL connections of this avatar
	w.sendToAvatar(avatarID, &ServerRoomChange{
		Type:    "room-change",
		Room:    targetRoom.ToSnapshot(),
		SpawnX:  spawnX,
		SpawnY:  spawnY,
		Avatars: w.getAvatarsInRoom(targetRoomName),
	})

	// Notify others in the new room
	w.broadcastToRoom(targetRoomName, &ServerAvatarJoin{
		Type:   "avatar-join",
		Avatar: avatar.toSnapshot(),
	}, excludeAvatar(avatarID))

	log.Printf("[World %s] %s transitioned to %q", w.Channel, avatar.Name, targetRoomName)
}

// ─── Chat ────────────────────────────────────────────────────────
// Chat is handled entirely by IRC — the game server no longer relays
// chat or private messages. See @airc/client integration in the
// game client (GameScreen.tsx, ChannelPanel.tsx, CharacterCard.tsx).
