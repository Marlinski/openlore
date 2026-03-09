/**
 * Server configuration.
 * Reads from environment variables with sensible defaults.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerConfig {
  /** HTTP + WS port */
  port: number;
  /** Path to the data/ directory (sprites, characters, game data) */
  dataDir: string;
  /** Path to the game-data.json file */
  gameDataPath: string;
  /** Server tick rate in ms (for future use — position broadcast interval) */
  tickRate: number;
  /** Default room name to spawn new avatars in */
  defaultRoom: string;
}

export function loadConfig(): ServerConfig {
  // __dirname = packages/server/src → 3 levels up to monorepo root
  const rootDir = path.resolve(__dirname, "../../..");
  const dataDir = process.env.DATA_DIR || path.join(rootDir, "data");

  return {
    port: parseInt(process.env.PORT || "3001", 10),
    dataDir,
    gameDataPath:
      process.env.GAME_DATA || path.join(dataDir, "game", "game-data.json"),
    tickRate: parseInt(process.env.TICK_RATE || "50", 10),
    defaultRoom: process.env.DEFAULT_ROOM || "",
  };
}
