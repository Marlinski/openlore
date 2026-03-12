package game

import (
	"log"
	"strings"
)

// ─── Avatar lifecycle ────────────────────────────────────────────

// handleJoin handles a client joining the game.
// The token identifies a registered player. If the token maps to a live avatar
// (or one in grace period), the connection reattaches. Otherwise a new avatar
// is spawned.
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
	if timer, ok := w.graceTimers[avatarID]; ok {
		timer.Stop()
		delete(w.graceTimers, avatarID)
		log.Printf("[World %s] %s (%s) reconnected within grace period",
			w.ID, avatar.Name, avatarID)
	} else {
		log.Printf("[World %s] %s (%s) added connection (multi-tab)",
			w.ID, avatar.Name, avatarID)
	}

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

	w.chat.Join(w.defaultRoom, avatar.ID)
	w.chat.Join(globalChannel, avatar.ID)

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
		w.ID, avatar.Name, avatar.ID, w.defaultRoom)
}

// handleDisconnect handles a WebSocket close.
// Removes the connection from the avatar. If it was the last connection,
// starts a grace timer — the avatar stays frozen in the room.
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
			w.ID, avatar.Name, avatarID, len(conns))
		return
	}

	// Last connection gone — freeze and start grace timer
	avatar.Moving = false
	avatar.Family = "idle"

	w.broadcastToRoom(avatar.Room, &ServerAvatarMove{
		Type:      "avatar-move",
		AvatarID:  avatarID,
		X:         avatar.X,
		Y:         avatar.Y,
		Direction: avatar.Direction,
		Moving:    false,
	}, nil)

	log.Printf("[World %s] %s (%s) disconnected, grace period %ds",
		w.ID, avatar.Name, avatarID, disconnectGraceMS/1000)

	w.startGraceTimer(avatarID)
}

// handleLeave handles an explicit leave message.
// Immediately removes the avatar (no grace period).
func (w *World) handleLeave(connID string) {
	avatarID, ok := w.connAvatars[connID]
	if !ok {
		return
	}

	if timer, ok := w.graceTimers[avatarID]; ok {
		timer.Stop()
		delete(w.graceTimers, avatarID)
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

	w.chat.LeaveAll(avatarID)
	delete(w.tokenAvatars, avatar.Token)

	if conns, ok := w.avatarConns[avatarID]; ok {
		for cid := range conns {
			delete(w.connAvatars, cid)
		}
	}
	delete(w.avatarConns, avatarID)
	delete(w.avatars, avatarID)

	log.Printf("[World %s] %s (%s) removed", w.ID, avatar.Name, avatarID)
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
	w.chat.Leave(avatar.Room, avatarID)

	// Enter new room
	avatar.Room = targetRoomName
	avatar.X = spawnX
	avatar.Y = spawnY
	avatar.Moving = false
	avatar.Family = "idle"
	targetRoom.AvatarIDs[avatarID] = struct{}{}
	w.chat.Join(targetRoomName, avatarID)

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

	log.Printf("[World %s] %s transitioned to %q", w.ID, avatar.Name, targetRoomName)
}

// ─── Chat ────────────────────────────────────────────────────────

func (w *World) handleChat(connID, text string) {
	avatarID, ok := w.connAvatars[connID]
	if !ok {
		return
	}
	avatar := w.avatars[avatarID]
	if avatar == nil {
		return
	}
	w.chat.Send(avatar.Room, avatarID, text)
}

func (w *World) handlePrivateMessage(connID, targetAvatarID, text string) {
	senderID, ok := w.connAvatars[connID]
	if !ok {
		return
	}
	sender := w.avatars[senderID]
	if sender == nil {
		return
	}
	if w.avatars[targetAvatarID] == nil {
		w.sendToConn(connID, &ServerError{
			Type:    "error",
			Message: "That player is no longer online.",
		})
		return
	}

	pm := &ServerPrivateMessage{
		Type:         "private-message",
		FromAvatarID: senderID,
		FromName:     sender.Name,
		ToAvatarID:   targetAvatarID,
		Text:         text,
	}

	w.sendToAvatar(targetAvatarID, pm)
	if targetAvatarID != senderID {
		w.sendToAvatar(senderID, pm)
	}
}

// handleChatMessage is called by the ChatProvider when a message is sent to
// a channel. Broadcasts to all members' connections.
func (w *World) handleChatMessage(channel, avatarID, text string) {
	avatar := w.avatars[avatarID]
	if avatar == nil {
		return
	}

	msg := &ServerChatMessage{
		Type:     "chat-message",
		AvatarID: avatarID,
		Name:     avatar.Name,
		Text:     text,
	}

	for _, memberID := range w.chat.GetMembers(channel) {
		if w.avatars[memberID] != nil {
			w.sendToAvatar(memberID, msg)
		}
	}
}
