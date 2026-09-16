/**
 * Landing-page hero — the real game client, driven locally.
 *
 * This is deliberately NOT a mock. It imports the same RoomScene and Avatar
 * classes the game client renders with (game/client/src/scene/), loads a real
 * compiled pack (landing/pack/, vendored from data/game/packs/test-pack), and
 * feeds the avatars the same applyServerPosition() calls the game server would
 * push over the WebSocket at ~15/sec. Real atlas art, real room layout, real
 * walkability grid, real doors, real z-sorting, real character animation.
 *
 * The only thing missing is the network: instead of a Connection, a small
 * local simulation walks the avatars around using BFS over the room's own
 * walkability grid, and emits `openlore:irc` events so the page's IRC panel
 * stays in sync — including the PART/JOIN pair when someone crosses a door.
 */

import { Application, Container, TextureSource } from "pixi.js";
import type { Pack, RoomDefinition } from "@openlore/pack";

import { RoomScene } from "../../../game/client/src/scene/room.js";
import {
  Avatar,
  resolveCharacterResources,
  loadCharacterTextures,
  type TextureCache,
} from "../../../game/client/src/scene/avatar.js";
import { loadImage, getCachedImage } from "../../../game/client/src/assets.js";
import { TILE_SIZE } from "../../../game/client/src/constants.js";
import type {
  AvatarSnapshot,
  CharacterDirection,
} from "../../../game/client/src/protocol.js";

// ── Config ────────────────────────────────────────────────────────

const PACK_URL = "pack/pack.json";
const ATLAS_BASE = "pack/";
const ROOM_NAME = "main_office";

/** Server tick: the real client receives position updates at ~15/sec. */
const TICK_MS = 66;
/** Walk speed in tiles/sec. */
const SPEED = 2.4;

const CAST = [
  { id: "u-amanda", name: "amanda", characterId: "amanda" },
  { id: "u-fiona", name: "fiona", characterId: "fiona" },
  { id: "u-arthur", name: "arthur", characterId: "arthur" },
];

const CHATTER: Record<string, string[]> = {
  amanda: ["standup in 5", "who took my mug", "atlas repacked fine"],
  fiona: ["build's green", "shipping it", "back in a sec"],
  arthur: ["54 resources now", "nice", "coffee run — anyone?"],
};

type Tile = { col: number; row: number };

// ── Small helpers ─────────────────────────────────────────────────

const centreOf = (t: Tile) => ({
  x: t.col * TILE_SIZE + TILE_SIZE / 2,
  y: t.row * TILE_SIZE + TILE_SIZE / 2,
});

function emit(kind: string, nick: string, payload: string, flash = false) {
  window.dispatchEvent(
    new CustomEvent("openlore:irc", { detail: { kind, nick, payload, flash } }),
  );
}

// ── Pathfinding over the room's own walkability grid ──────────────

function makeGrid(room: RoomDefinition) {
  const { width, height } = room;
  const walk = room.walkability ?? [];
  const ok = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < width && r < height && walk[r * width + c] === true;

  const all: Tile[] = [];
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++) if (ok(c, r)) all.push({ col: c, row: r });

  /** Breadth-first path from `from` to `to`, exclusive of `from`. */
  function path(from: Tile, to: Tile): Tile[] | null {
    if (!ok(to.col, to.row)) return null;
    const key = (c: number, r: number) => r * width + c;
    const prev = new Map<number, number>();
    const seen = new Set<number>([key(from.col, from.row)]);
    const q: Tile[] = [from];

    while (q.length) {
      const cur = q.shift()!;
      if (cur.col === to.col && cur.row === to.row) {
        const out: Tile[] = [];
        let k = key(cur.col, cur.row);
        while (k !== key(from.col, from.row)) {
          out.push({ col: k % width, row: Math.floor(k / width) });
          k = prev.get(k)!;
        }
        return out.reverse();
      }
      const nbrs = [
        { col: cur.col + 1, row: cur.row },
        { col: cur.col - 1, row: cur.row },
        { col: cur.col, row: cur.row + 1 },
        { col: cur.col, row: cur.row - 1 },
      ];
      for (const n of nbrs) {
        if (!ok(n.col, n.row)) continue;
        const nk = key(n.col, n.row);
        if (seen.has(nk)) continue;
        seen.add(nk);
        prev.set(nk, key(cur.col, cur.row));
        q.push(n);
      }
    }
    return null;
  }

  return { all, ok, path };
}

// ── Local actor: drives one real Avatar ───────────────────────────

interface Actor {
  avatar: Avatar;
  /** z-sort entry returned by RoomScene.addAvatarSprite, updated each frame. */
  entry: { sprite: unknown; anchorY: number };
  /** True when the current path ends on a door tile. */
  usingDoor: boolean;
  x: number;
  y: number;
  dir: CharacterDirection;
  moving: boolean;
  path: Tile[];
  wait: number;
  away: number;
  tag: HTMLElement;
  bubble: HTMLElement | null;
  bubbleT: number;
}

// ── Boot ──────────────────────────────────────────────────────────

async function start() {
  const canvas = document.getElementById("game") as HTMLCanvasElement | null;
  const overlay = document.getElementById("overlay");
  const host = canvas?.parentElement;
  if (!canvas || !overlay || !host) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // 1. Load the real pack.
  const pack: Pack = await fetch(PACK_URL).then((r) => r.json());

  // 2. Resolve tileset image paths against the vendored atlas directory, the
  //    same rewrite preloadGameAssets() does against /data/packs/{id}/.
  for (const ts of pack.tilesets) ts.path = ATLAS_BASE + ts.path;
  await Promise.all(
    pack.tilesets.map((ts) =>
      loadImage(ts.path).catch((e) => console.warn("[demo]", e)),
    ),
  );

  const room = pack.rooms.find((r) => r.name === ROOM_NAME) ?? pack.rooms[0];
  if (!room) return;

  // 3. Real PixiJS application. Nearest-neighbour everywhere — this is 48px
  //    pixel art and must never be smoothed.
  TextureSource.defaultOptions.scaleMode = "nearest";
  const app = new Application();
  await app.init({
    canvas,
    backgroundAlpha: 0,
    antialias: false,
    autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    width: host.clientWidth || 800,
    height: host.clientHeight || 440,
  });

  const world = new Container();
  app.stage.addChild(world);

  // 4. The real room renderer, from the real pack.
  const textureCache: TextureCache = new Map();
  const scene = new RoomScene(room, pack, textureCache);
  world.addChild(scene.root);

  // 5. Real avatars with real character sprites.
  const grid = makeGrid(room);
  const spawn = [...grid.all].sort(() => Math.random() - 0.5);
  const actors: Actor[] = [];

  CAST.forEach((c, i) => {
    const res = resolveCharacterResources(c.characterId, pack);
    if (!res.all.length) return;
    loadCharacterTextures(res, pack, textureCache, getCachedImage);

    const tile = spawn[i % spawn.length];
    const p = centreOf(tile);
    const snapshot: AvatarSnapshot = {
      id: c.id,
      name: c.name,
      characterId: c.characterId,
      room: room.name,
      x: p.x,
      y: p.y,
      direction: "down",
      moving: false,
      family: "idle",
    };
    const avatar = new Avatar(snapshot, res, pack, textureCache, false);
    const entry = scene.addAvatarSprite(avatar.sprite, avatar.anchorY);

    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = c.name;
    overlay.appendChild(tag);

    actors.push({
      avatar, entry, usingDoor: false,
      x: p.x, y: p.y, dir: "down", moving: false,
      path: [], wait: 0.6 + i * 1.3, away: 0, tag, bubble: null, bubbleT: 0,
    });
    emit("join", c.name, `#lobby-${room.name}`);
  });

  emit("msg", "amanda", "standup in 5");

  // 6. Camera — letterbox the room inside the view, as the real client does.
  function layout() {
    const w = host!.clientWidth, h = host!.clientHeight;
    if (!w || !h) return;
    app.renderer.resize(w, h);
    const s = Math.min(w / scene.pixelWidth, h / scene.pixelHeight);
    world.scale.set(s);
    world.x = Math.round((w - scene.pixelWidth * s) / 2);
    world.y = Math.round((h - scene.pixelHeight * s) / 2);
  }
  layout();
  new ResizeObserver(layout).observe(host);

  // 7. Local simulation — stands in for the game server.
  const doorTiles: Tile[] = (room.doors ?? []).map((d) => ({
    col: d.col ?? 0, row: d.row ?? 0,
  }));

  function retarget(a: Actor) {
    const useDoor = doorTiles.length > 0 && Math.random() < 0.22;
    const pool = useDoor ? doorTiles : grid.all;
    const dest = pool[Math.floor(Math.random() * pool.length)];
    const from = { col: Math.floor(a.x / TILE_SIZE), row: Math.floor(a.y / TILE_SIZE) };
    const p = grid.path(from, dest);
    if (p && p.length) {
      a.path = p;
      a.usingDoor = useDoor;
    } else {
      a.wait = 1;
    }
  }

  function tick(dt: number) {
    for (const a of actors) {
      if (a.away > 0) {
        a.away -= dt;
        if (a.away <= 0) {
          a.tag.style.display = "";
          a.avatar.sprite.visible = true;
          emit("part", a.avatar.name, "#lobby-coffee_room", true);
          emit("join", a.avatar.name, `#lobby-${room.name}`, true);
        }
        continue;
      }
      if (a.wait > 0) {
        a.wait -= dt;
        if (a.moving) { a.moving = false; push(a); }
        if (a.wait <= 0) retarget(a);
        continue;
      }
      if (!a.path.length) {
        a.wait = 1.4 + Math.random() * 3.2;
        if (Math.random() < 0.5) say(a);
        continue;
      }

      const target = centreOf(a.path[0]);
      const dx = target.x - a.x, dy = target.y - a.y;
      const dist = Math.hypot(dx, dy);
      const step = SPEED * TILE_SIZE * dt;

      if (dist <= step) {
        a.x = target.x; a.y = target.y;
        a.path.shift();
        if (!a.path.length && a.usingDoor) {
          // Crossed a door. This is the whole mechanic.
          a.usingDoor = false;
          a.away = 6;
          a.moving = false;
          a.tag.style.display = "none";
          a.avatar.sprite.visible = false;
          if (a.bubble) { a.bubble.remove(); a.bubble = null; }
          emit("part", a.avatar.name, `#lobby-${room.name}`, true);
          emit("join", a.avatar.name, "#lobby-coffee_room", true);
        }
      } else {
        a.x += (dx / dist) * step;
        a.y += (dy / dist) * step;
        a.dir = Math.abs(dx) > Math.abs(dy)
          ? (dx > 0 ? "right" : "left")
          : (dy > 0 ? "down" : "up");
        a.moving = true;
      }
      push(a);
    }
  }

  /** Exactly what the server sends: position, direction, moving. */
  function push(a: Actor) {
    a.avatar.family = a.moving ? "walk" : "idle";
    a.avatar.applyServerPosition(a.x, a.y, a.dir, a.moving);
  }

  function say(a: Actor) {
    const lines = CHATTER[a.avatar.name] ?? ["hey"];
    const text = lines[Math.floor(Math.random() * lines.length)];
    if (a.bubble) a.bubble.remove();
    const b = document.createElement("span");
    b.className = "bub";
    b.textContent = text;
    overlay!.appendChild(b);
    a.bubble = b;
    a.bubbleT = 3.4;
    emit("msg", a.avatar.name, text);
  }

  /** Project world coords to overlay pixels for nametags and bubbles. */
  function syncOverlay(dt: number) {
    for (const a of actors) {
      if (a.bubble) {
        a.bubbleT -= dt;
        if (a.bubbleT <= 0) { a.bubble.remove(); a.bubble = null; }
      }
      if (a.away > 0) continue;
      // The sprite spans y-1.5*TILE .. y+0.5*TILE, so the head top sits at
      // y-1.5*TILE. Park the nametag just above it, and the bubble above that.
      const sx = world.x + a.avatar.x * world.scale.x;
      const sy = world.y + (a.avatar.y - TILE_SIZE * 1.55) * world.scale.y;
      a.tag.style.transform = `translate(${sx}px,${sy}px) translate(-50%,-100%)`;
      if (a.bubble) {
        a.bubble.style.transform =
          `translate(${sx}px,${sy - 15}px) translate(-50%,-100%)`;
      }
    }
  }

  // 8. Drive it. Rendering runs on Pixi's ticker; the "server" ticks at 15/sec.
  let acc = 0;
  app.ticker.add((t) => {
    const dt = t.deltaMS / 1000;
    if (!reduced && !document.hidden) {
      acc += t.deltaMS;
      while (acc >= TICK_MS) { tick(TICK_MS / 1000); acc -= TICK_MS; }
    }
    for (const a of actors) a.avatar.update(dt);
    for (const a of actors) a.entry.anchorY = a.avatar.anchorY;
    scene.zSort();
    syncOverlay(dt);
  });

  host.classList.add("ready");
}

start().catch((e) => {
  console.error("[demo] failed to start", e);
  document.getElementById("game")?.parentElement?.classList.add("failed");
});
