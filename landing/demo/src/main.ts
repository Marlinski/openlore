/**
 * Landing-page hero — the real game client, on the real IRC network.
 *
 * Nothing here is simulated.
 *
 *  - The room is rendered by the game client's own RoomScene, from a real
 *    compiled pack (landing/pack/). Real atlas art, real walkability grid,
 *    real doors, real anchor-Y z-sorting.
 *  - The people are real. The page connects to wss://irc.openlore.xyz/ws with
 *    @marlinski/airc — the same client the game uses — joins the two lobby
 *    channels, and renders one real Avatar per nick it observes. Their
 *    messages are their real messages.
 *  - A real room transition (PART one channel, JOIN the other) is the door
 *    mechanic, so the avatar walks to a door and leaves.
 *
 * Two limits are inherent to the server, not worked around here:
 *
 *  1. aircd does not send 353/RPL_NAMREPLY, only 366. There is no way to
 *     enumerate who is already in a channel, so an avatar can only appear once
 *     that nick is *observed* — joining, parting, or speaking. Someone sitting
 *     silently before you loaded the page stays invisible until they act.
 *  2. IRC carries no positions. A nick is placed at a stable tile derived from
 *     its own name and idles there; it is never walked around at random.
 */

import { Application, Container, TextureSource } from "pixi.js";
import type { Pack, RoomDefinition } from "@openlore/pack";
import { AircClient, type IrcEvent } from "@marlinski/airc";

import { RoomScene } from "../../../game/client/src/scene/room.js";
import {
  Avatar,
  resolveCharacterResources,
  loadCharacterTextures,
  type CharacterResources,
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

const IRC_URL = "wss://irc.openlore.xyz/ws";
const LOBBY = "lobby";
const ROOM_NAME = "main_office";
const OTHER_ROOM = "coffee_room";

const HERE = `#${LOBBY}-${ROOM_NAME}`;
const THERE = `#${LOBBY}-${OTHER_ROOM}`;

/** Characters the pack ships. A nick maps to one deterministically. */
const CHARACTERS = ["amanda", "fiona", "arthur"];

/** Walk speed in tiles/sec, used only for the door walk on a real PART. */
const SPEED = 2.4;

type Tile = { col: number; row: number };

const centreOf = (t: Tile) => ({
  x: t.col * TILE_SIZE + TILE_SIZE / 2,
  y: t.row * TILE_SIZE + TILE_SIZE / 2,
});

function emit(kind: string, nick: string, payload: string, flash = false) {
  window.dispatchEvent(
    new CustomEvent("openlore:irc", { detail: { kind, nick, payload, flash } }),
  );
}

function presence(count: number, connected: boolean) {
  window.dispatchEvent(
    new CustomEvent("openlore:presence", { detail: { count, connected } }),
  );
}

/** Stable hash so a nick always gets the same character and the same tile. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── Pathfinding, used for the walk-to-door on a real PART ─────────

function makeGrid(room: RoomDefinition) {
  const { width, height } = room;
  const walk = room.walkability ?? [];
  const ok = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < width && r < height && walk[r * width + c] === true;

  const all: Tile[] = [];
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++) if (ok(c, r)) all.push({ col: c, row: r });

  function path(from: Tile, to: Tile): Tile[] | null {
    if (!ok(to.col, to.row) || !ok(from.col, from.row)) return null;
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
      for (const n of [
        { col: cur.col + 1, row: cur.row },
        { col: cur.col - 1, row: cur.row },
        { col: cur.col, row: cur.row + 1 },
        { col: cur.col, row: cur.row - 1 },
      ]) {
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

// ── One real person in the room ───────────────────────────────────

interface Person {
  nick: string;
  avatar: Avatar;
  entry: { anchorY: number };
  x: number;
  y: number;
  dir: CharacterDirection;
  moving: boolean;
  /** Set when a real PART/QUIT is walking them out through a door. */
  leaving: Tile[] | null;
  tag: HTMLElement;
  bubble: HTMLElement | null;
  bubbleT: number;
}

async function start() {
  const canvas = document.getElementById("game") as HTMLCanvasElement | null;
  const overlay = document.getElementById("overlay");
  const host = canvas?.parentElement;
  if (!canvas || !overlay || !host) return;

  // 1. Real pack.
  const pack: Pack = await fetch(PACK_URL).then((r) => r.json());
  for (const ts of pack.tilesets) ts.path = ATLAS_BASE + ts.path;
  await Promise.all(
    pack.tilesets.map((ts) =>
      loadImage(ts.path).catch((e) => console.warn("[hero]", e)),
    ),
  );

  const room = pack.rooms.find((r) => r.name === ROOM_NAME) ?? pack.rooms[0];
  if (!room) return;

  // 2. Real renderer.
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

  const textureCache: TextureCache = new Map();
  const scene = new RoomScene(room, pack, textureCache);
  world.addChild(scene.root);
  host.classList.add("ready");

  const grid = makeGrid(room);

  // Walkable is not the same as visible: plenty of walkable tiles sit under a
  // desk or a shelf, where an avatar reads as a smear behind furniture. Prefer
  // tiles no OBJECT-layer placement covers, and fall back to any walkable tile.
  const covered = new Set<number>();
  for (const pl of room.placements ?? []) {
    if (pl.layer !== 2 || !pl.region) continue;
    const cols = Math.max(1, Math.round((pl.region.w ?? TILE_SIZE) / TILE_SIZE));
    const rows = Math.max(1, Math.round((pl.region.h ?? TILE_SIZE) / TILE_SIZE));
    for (let c = 0; c < cols; c++)
      for (let r = 0; r < rows; r++)
        covered.add((( pl.gridY ?? 0) + r) * room.width + ((pl.gridX ?? 0) + c));
  }
  const openTiles = grid.all.filter((t) => !covered.has(t.row * room.width + t.col));
  const spawnPool = openTiles.length ? openTiles : grid.all;

  const doorTiles: Tile[] = (room.doors ?? [])
    .map((d) => ({ col: d.col ?? 0, row: d.row ?? 0 }))
    .filter((t) => grid.ok(t.col, t.row));

  // Pre-resolve each character's resources once.
  const charRes = new Map<string, CharacterResources>();
  for (const name of CHARACTERS) {
    const res = resolveCharacterResources(name, pack);
    if (!res.all.length) continue;
    loadCharacterTextures(res, pack, textureCache, getCachedImage);
    charRes.set(name, res);
  }

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

  // 3. People, created only from observed IRC activity.
  const people = new Map<string, Person>();
  let connected = false;
  let selfNick = "";

  function updateCount() {
    presence(people.size, connected);
    host!.classList.toggle("empty", people.size === 0);
  }

  function tileFor(nick: string): Tile {
    const pool = spawnPool.length ? spawnPool : [{ col: 1, row: 1 }];
    return pool[hash(nick) % pool.length];
  }

  function add(nick: string, self: boolean): Person | null {
    const existing = people.get(nick);
    if (existing) return existing;
    const name = CHARACTERS[hash(nick) % CHARACTERS.length];
    const res = charRes.get(name);
    if (!res) return null;

    const p = centreOf(tileFor(nick));
    const snapshot: AvatarSnapshot = {
      id: nick, name: nick, characterId: name, room: room!.name,
      x: p.x, y: p.y, direction: "down", moving: false, family: "idle",
    };
    const avatar = new Avatar(snapshot, res, pack, textureCache, self);
    const entry = scene.addAvatarSprite(avatar.sprite, avatar.anchorY);

    const tag = document.createElement("span");
    tag.className = "tag" + (self ? " tag-self" : "");
    tag.textContent = self ? nick + " (you)" : nick;
    overlay!.appendChild(tag);

    const person: Person = {
      nick, avatar, entry, x: p.x, y: p.y, dir: "down",
      moving: false, leaving: null, tag, bubble: null, bubbleT: 0,
    };
    people.set(nick, person);
    updateCount();
    return person;
  }

  function drop(nick: string) {
    const p = people.get(nick);
    if (!p) return;
    scene.removeAvatarSprite(p.avatar.sprite);
    p.tag.remove();
    if (p.bubble) p.bubble.remove();
    people.delete(nick);
    updateCount();
  }

  /** A real PART/QUIT: walk them to the nearest door, then remove them. */
  function walkOut(nick: string) {
    const p = people.get(nick);
    if (!p) return;
    const from = {
      col: Math.floor(p.x / TILE_SIZE),
      row: Math.floor(p.y / TILE_SIZE),
    };
    let best: Tile[] | null = null;
    for (const d of doorTiles) {
      const route = grid.path(from, d);
      if (route && (!best || route.length < best.length)) best = route;
    }
    if (!best || !best.length) { drop(nick); return; }
    p.leaving = best;
  }

  function say(nick: string, text: string) {
    const p = people.get(nick) ?? add(nick, nick === selfNick);
    if (!p) return;
    if (p.bubble) p.bubble.remove();
    const b = document.createElement("span");
    b.className = "bub";
    b.textContent = text;
    overlay!.appendChild(b);
    p.bubble = b;
    p.bubbleT = 4.5;
  }

  // 4. Frame loop — idle animation, the door walk, and overlay placement.
  app.ticker.add((t) => {
    const dt = t.deltaMS / 1000;

    for (const p of [...people.values()]) {
      if (p.leaving) {
        const target = centreOf(p.leaving[0]);
        const dx = target.x - p.x, dy = target.y - p.y;
        const dist = Math.hypot(dx, dy);
        const step = SPEED * TILE_SIZE * dt;
        if (dist <= step) {
          p.x = target.x; p.y = target.y;
          p.leaving.shift();
          if (!p.leaving.length) { drop(p.nick); continue; }
        } else {
          p.x += (dx / dist) * step;
          p.y += (dy / dist) * step;
          p.dir = Math.abs(dx) > Math.abs(dy)
            ? (dx > 0 ? "right" : "left")
            : (dy > 0 ? "down" : "up");
          p.moving = true;
        }
      }
      p.avatar.family = p.moving ? "walk" : "idle";
      p.avatar.applyServerPosition(p.x, p.y, p.dir, p.moving);
      p.avatar.update(dt);
      p.entry.anchorY = p.avatar.anchorY;
    }

    scene.zSort();

    for (const p of people.values()) {
      if (p.bubble) {
        p.bubbleT -= dt;
        if (p.bubbleT <= 0) { p.bubble.remove(); p.bubble = null; }
      }
      const sx = world.x + p.avatar.x * world.scale.x;
      const sy = world.y + (p.avatar.y - TILE_SIZE * 1.55) * world.scale.y;
      p.tag.style.transform = "translate(" + sx + "px," + sy + "px) translate(-50%,-100%)";
      if (p.bubble) {
        p.bubble.style.transform =
          "translate(" + sx + "px," + (sy - 15) + "px) translate(-50%,-100%)";
      }
    }
  });

  // 5. Real IRC.
  let client: AircClient | null = null;

  function onEvent(e: IrcEvent) {
    switch (e.type) {
      case "registered":
        connected = true;
        selfNick = e.nick;
        add(e.nick, true);
        emit("join", e.nick, HERE);
        updateCount();
        break;

      case "join":
        if (e.nick === selfNick) return;
        if (e.channel === HERE) add(e.nick, false);
        if (e.channel === HERE || e.channel === THERE)
          emit("join", e.nick, e.channel, true);
        break;

      case "part":
        if (e.nick === selfNick) return;
        if (e.channel === HERE) walkOut(e.nick);
        if (e.channel === HERE || e.channel === THERE)
          emit("part", e.nick, e.channel, true);
        break;

      case "quit":
        if (e.nick === selfNick) return;
        walkOut(e.nick);
        emit("part", e.nick, HERE);
        break;

      case "kick":
        walkOut(e.nick);
        emit("part", e.nick, e.channel);
        break;

      case "message": {
        const m = e.message;
        if (!m.target.startsWith("#")) {
          emit("pm", m.from, m.text);
        } else {
          if (m.target === HERE) say(m.from, m.text);
          emit("msg", m.from, m.text);
        }
        break;
      }

      case "disconnected":
        connected = false;
        updateCount();
        break;

      case "reconnected":
        connected = true;
        updateCount();
        break;
    }
  }

  async function connect() {
    if (client) return;
    // A clearly-marked visitor nick, so anyone in the channel can tell this is
    // someone looking at the website rather than a player.
    const nick = "web-" + Math.random().toString(36).slice(2, 8);
    const c = new AircClient({ nick, url: IRC_URL, autoJoin: [HERE, THERE] });
    client = c;
    c.on(onEvent);
    try {
      await c.connect();
    } catch (err) {
      console.warn("[hero] IRC connect failed", err);
      connected = false;
      host!.classList.add("offline");
      if (client === c) client = null;
      updateCount();
    }
  }

  function disconnect() {
    const c = client;
    if (!c) return;
    client = null;
    connected = false;
    for (const nick of [...people.keys()]) drop(nick);
    updateCount();
    c.quit("closed the page").catch(() => {}).finally(() => c.destroy());
  }

  // Hold an IRC session only while the hero is actually on screen. A landing
  // page should not keep a connection open for every idle background tab.
  let visible = false;
  const io = new IntersectionObserver((entries) => {
    visible = entries[0]?.isIntersecting ?? false;
    if (visible && !document.hidden) connect();
    else disconnect();
  }, { threshold: 0.05 });
  io.observe(host);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) disconnect();
    else if (visible) connect();
  });
  window.addEventListener("pagehide", disconnect);

  updateCount();
}

start().catch((e) => {
  console.error("[hero] failed to start", e);
  document.getElementById("game")?.parentElement?.classList.add("failed");
});
