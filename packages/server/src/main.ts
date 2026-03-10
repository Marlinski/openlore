/**
 * Offisims Game Server — Entry point
 *
 * Loads game data from JSON, starts HTTP + WebSocket server,
 * and initializes the game world.
 *
 * Usage:
 *   yarn server:dev                    # Dev mode with hot reload
 *   node dist/main.js                  # Production
 *   PORT=3001 GAME_DATA=./my.json node dist/main.js
 */

import fs from "node:fs";
import http from "node:http";
import type { ProjectData } from "@offisims/shared";
import { loadConfig } from "./config.js";
import { createApp } from "./http.js";
import { setupWebSocket } from "./websocket.js";
import { World } from "./game/world.js";
import { MemoryChatProvider } from "./chat/memory.js";
import { MemoryPlayerStore } from "./player.js";

async function main(): Promise<void> {
  const config = loadConfig();

  console.log("[Server] Configuration:");
  console.log(`  Port:      ${config.port}`);
  console.log(`  Data dir:  ${config.dataDir}`);
  console.log(`  Game data: ${config.gameDataPath}`);

  // ─── Load game data ────────────────────────────────────────

  let projectData: ProjectData | null = null;

  if (fs.existsSync(config.gameDataPath)) {
    try {
      const raw = fs.readFileSync(config.gameDataPath, "utf-8");
      projectData = JSON.parse(raw) as ProjectData;
      console.log(`[Server] Loaded game data from ${config.gameDataPath}`);
    } catch (err) {
      console.error(`[Server] Failed to load game data:`, err);
    }
  } else {
    console.warn(
      `[Server] No game data found at ${config.gameDataPath}`,
    );
    console.warn(
      `  Export from the tools app and place at: data/game/game-data.json`,
    );
    // Create empty project data so the server can still start
    projectData = {
      tilesets: [],
      composites: [],
      rooms: [],
      characters: [],
    };
  }

  // ─── Initialize game world ─────────────────────────────────

  const chat = new MemoryChatProvider();
  const playerStore = new MemoryPlayerStore();

  // We need the sendToSession function from the WS layer,
  // but the WS layer needs the World. Break the cycle by
  // creating World with a placeholder, then wiring it up.
  let sendFn: ((sessionId: string, msg: any) => void) | null = null;

  const world = new World(chat, playerStore, (sessionId, msg) => {
    if (sendFn) sendFn(sessionId, msg);
  });

  if (projectData) {
    world.loadGameData(projectData);
  }

  if (config.defaultRoom) {
    world.setDefaultRoom(config.defaultRoom);
  }

  // ─── Start HTTP + WS server ────────────────────────────────

  const app = createApp(world, playerStore, config);
  const httpServer = http.createServer(app);

  const ws = setupWebSocket(httpServer, world);
  sendFn = ws.send;

  httpServer.listen(config.port, () => {
    console.log(`[Server] Listening on http://localhost:${config.port}`);
    console.log(`[Server] WebSocket at ws://localhost:${config.port}/ws`);
    console.log(`[Server] API at http://localhost:${config.port}/api/game-data`);
  });
}

main().catch((err) => {
  console.error("[Server] Fatal error:", err);
  process.exit(1);
});
