#!/usr/bin/env node
/**
 * Split game-data.json into per-file structure.
 *
 * Output layout:
 *   data/game/tilesets.json
 *   data/game/characters.json
 *   data/game/resources/<id>.json
 *   data/game/composites/<id>.json
 *   data/game/rooms/<name>.json
 *   data/game/masks/<id>.json
 *
 * The original game-data.json is NOT deleted.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameDir = path.resolve(__dirname, "../../../data/game");
const srcFile = path.join(gameDir, "game-data.json");

if (!fs.existsSync(srcFile)) {
  console.error("game-data.json not found at", srcFile);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(srcFile, "utf-8"));

function writeJSON(relPath, obj) {
  const full = path.join(gameDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(obj, null, 2) + "\n");
  console.log(`  ${relPath}`);
}

console.log("Splitting game-data.json...\n");

// Tilesets — single array file
if (Array.isArray(data.tilesets)) {
  writeJSON("tilesets.json", data.tilesets);
  console.log(`  → ${data.tilesets.length} tilesets\n`);
}

// Characters — single array file
if (Array.isArray(data.characters)) {
  writeJSON("characters.json", data.characters);
  console.log(`  → ${data.characters.length} characters\n`);
}

// Resources — one file per resource
if (Array.isArray(data.resources)) {
  for (const r of data.resources) {
    writeJSON(`resources/${r.id}.json`, r);
  }
  console.log(`  → ${data.resources.length} resources\n`);
}

// Composites — one file per composite
if (Array.isArray(data.composites)) {
  for (const c of data.composites) {
    writeJSON(`composites/${c.id}.json`, c);
  }
  console.log(`  → ${data.composites.length} composites\n`);
}

// Rooms — one file per room (keyed by name)
if (Array.isArray(data.rooms)) {
  for (const r of data.rooms) {
    writeJSON(`rooms/${r.name}.json`, r);
  }
  console.log(`  → ${data.rooms.length} rooms\n`);
}

// Masks — one file per mask
if (Array.isArray(data.masks)) {
  for (const m of data.masks) {
    writeJSON(`masks/${m.id}.json`, m);
  }
  console.log(`  → ${data.masks.length} masks\n`);
}

console.log("Done! game-data.json was NOT deleted.");
