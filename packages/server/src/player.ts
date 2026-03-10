/**
 * Player store — persistent player identity (survives avatar lifecycle).
 *
 * A PlayerRecord is created at registration (REST API) and persists
 * for the lifetime of the server process (in-memory for now).
 * The token is the player's session cookie — used to authenticate
 * WebSocket connections and reconnect to existing avatars.
 *
 * This is the same whether the player is a human or an AI agent;
 * registration is just an API call.
 */

import { randomUUID } from "node:crypto";

export interface PlayerRecord {
  /** Persistent session token (UUID) — stored in client cookie */
  token: string;
  /** Display name */
  name: string;
  /** Character definition ID (for appearance) */
  characterId: string;
  /** When this player registered */
  createdAt: number;
}

export interface PlayerStore {
  /** Register a new player, returns the created record */
  register(name: string, characterId: string): PlayerRecord;
  /** Look up a player by token, or null if not found */
  getByToken(token: string): PlayerRecord | null;
}

export class MemoryPlayerStore implements PlayerStore {
  private players = new Map<string, PlayerRecord>();

  register(name: string, characterId: string): PlayerRecord {
    const token = randomUUID();
    const record: PlayerRecord = {
      token,
      name,
      characterId,
      createdAt: Date.now(),
    };
    this.players.set(token, record);
    console.log(`[PlayerStore] Registered "${name}" (char: ${characterId})`);
    return record;
  }

  getByToken(token: string): PlayerRecord | null {
    return this.players.get(token) ?? null;
  }
}
