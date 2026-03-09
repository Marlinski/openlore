/**
 * HTTP server — Express routes for the game API and static assets.
 *
 * Endpoints:
 *   GET  /api/game-data     → Full ProjectData JSON
 *   PUT  /api/game-data     → Replace game data (from tools sync)
 *   GET  /api/rooms          → List of room names + metadata
 *   GET  /api/rooms/:name    → Single room definition
 *   GET  /data/*             → Static sprites/character assets
 */

import express from "express";
import fs from "node:fs";
import type { ProjectData } from "@offisims/shared";
import type { World } from "./game/world.js";
import type { ServerConfig } from "./config.js";

export function createApp(world: World, config: ServerConfig): express.Express {
  const app = express();

  // Parse JSON request bodies (for PUT /api/game-data)
  app.use(express.json({ limit: "10mb" }));

  // ─── JSON API ──────────────────────────────────────────────

  /** Full game data (tilesets, composites, rooms, characters) */
  app.get("/api/game-data", (_req, res) => {
    const data = world.getProjectData();
    if (!data) {
      res.status(503).json({ error: "Game data not loaded" });
      return;
    }
    res.json(data);
  });

  /** Replace game data (push from tools) — saves to disk and hot-reloads World */
  app.put("/api/game-data", (req, res) => {
    try {
      const data = req.body as ProjectData;

      // Basic validation
      if (!data || !Array.isArray(data.rooms) || !Array.isArray(data.characters)) {
        res.status(400).json({ error: "Invalid ProjectData: must have rooms and characters arrays" });
        return;
      }

      // Save to disk
      const json = JSON.stringify(data, null, 2);
      fs.writeFileSync(config.gameDataPath, json, "utf-8");
      console.log(`[HTTP] Saved game data to ${config.gameDataPath} (${(json.length / 1024).toFixed(1)} KB)`);

      // Hot-reload the World
      world.loadGameData(data);

      res.json({
        ok: true,
        rooms: data.rooms.length,
        characters: data.characters.length,
        composites: data.composites?.length ?? 0,
        tilesets: data.tilesets?.length ?? 0,
      });
    } catch (err: any) {
      console.error("[HTTP] Failed to update game data:", err);
      res.status(500).json({ error: err.message || "Internal server error" });
    }
  });

  /** List all rooms */
  app.get("/api/rooms", (_req, res) => {
    const data = world.getProjectData();
    if (!data) {
      res.status(503).json({ error: "Game data not loaded" });
      return;
    }
    const rooms = data.rooms.map((r) => ({
      name: r.name,
      width: r.width,
      height: r.height,
      doorCount: r.doors.length,
    }));
    res.json({ rooms });
  });

  /** Single room definition */
  app.get("/api/rooms/:name", (req, res) => {
    const data = world.getProjectData();
    if (!data) {
      res.status(503).json({ error: "Game data not loaded" });
      return;
    }
    const room = data.rooms.find((r) => r.name === req.params.name);
    if (!room) {
      res.status(404).json({ error: `Room "${req.params.name}" not found` });
      return;
    }
    res.json(room);
  });

  // ─── Static assets ─────────────────────────────────────────

  /** Serve /data/* from the data directory (sprites, characters, game JSONs) */
  app.use("/data", express.static(config.dataDir, {
    maxAge: "1h",
    immutable: false,
  }));

  return app;
}
