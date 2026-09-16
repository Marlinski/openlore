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
 *  - You can walk. Click the room and use WASD or the arrow keys. Movement uses
 *    the client's own speed and axis-separated collision against the real
 *    walkability grid, and stepping onto a door really does PART one channel
 *    and JOIN the other — people in the channel see you move rooms.
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
const channelFor = (roomName: string) => `#${LOBBY}-${roomName}`;

/** Characters the pack ships. A nick maps to one deterministically. */
const CHARACTERS = ["amanda", "fiona", "arthur"];

/** Walk speed in tiles/sec for the scripted walk-out on a real PART. */
const SPEED = 2.4;

/** The game client's own movement speed (scene/manager.ts MOVE_SPEED). */
const MOVE_SPEED = 4 * TILE_SIZE;

const MOVE_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

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

function roomChanged(roomName: string, channel: string) {
  window.dispatchEvent(
    new CustomEvent("openlore:room", { detail: { room: roomName, channel } }),
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

  if (!pack.rooms.some((r) => r.name === ROOM_NAME)) return;

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

  // Pre-resolve each character's resources once.
  const charRes = new Map<string, CharacterResources>();
  for (const name of CHARACTERS) {
    const res = resolveCharacterResources(name, pack);
    if (!res.all.length) continue;
    loadCharacterTextures(res, pack, textureCache, getCachedImage);
    charRes.set(name, res);
  }

  // ── Mutable room state — a door swaps all of this out ──────────
  let room!: RoomDefinition;
  let scene!: RoomScene;
  let grid!: ReturnType<typeof makeGrid>;
  let spawnPool: Tile[] = [];
  let doorTiles: Tile[] = [];
  let currentRoom = "";
  let currentChannel = "";

  /** Walkable is not the same as visible: plenty of walkable tiles sit under a
   *  desk, where an avatar reads as a smear behind furniture. Prefer tiles no
   *  OBJECT-layer placement covers. */
  function openTilesFor(r: RoomDefinition, g: ReturnType<typeof makeGrid>): Tile[] {
    const covered = new Set<number>();
    for (const pl of r.placements ?? []) {
      if (pl.layer !== 2 || !pl.region) continue;
      const cols = Math.max(1, Math.round((pl.region.w ?? TILE_SIZE) / TILE_SIZE));
      const rows = Math.max(1, Math.round((pl.region.h ?? TILE_SIZE) / TILE_SIZE));
      for (let c = 0; c < cols; c++)
        for (let rr = 0; rr < rows; rr++)
          covered.add(((pl.gridY ?? 0) + rr) * r.width + ((pl.gridX ?? 0) + c));
    }
    const open = g.all.filter((t) => !covered.has(t.row * r.width + t.col));
    return open.length ? open : g.all;
  }

  function layout() {
    const w = host!.clientWidth, h = host!.clientHeight;
    if (!w || !h || !scene) return;
    app.renderer.resize(w, h);
    const sc = Math.min(w / scene.pixelWidth, h / scene.pixelHeight);
    world.scale.set(sc);
    world.x = Math.round((w - scene.pixelWidth * sc) / 2);
    world.y = Math.round((h - scene.pixelHeight * sc) / 2);
  }

  // ── People ─────────────────────────────────────────────────────
  const people = new Map<string, Person>();
  /** Membership learned from observed events, per channel. */
  const known = new Map<string, Set<string>>([[HERE, new Set()], [THERE, new Set()]]);
  let me: Person | null = null;
  let connected = false;
  let selfNick = "";

  function updateCount() {
    presence(people.size, connected);
  }

  function tileFor(nick: string): Tile {
    const pool = spawnPool.length ? spawnPool : [{ col: 1, row: 1 }];
    return pool[hash(nick) % pool.length];
  }

  function add(nick: string, self: boolean, at?: { x: number; y: number }): Person | null {
    const existing = people.get(nick);
    if (existing) return existing;
    const name = CHARACTERS[hash(nick) % CHARACTERS.length];
    const res = charRes.get(name);
    if (!res) return null;

    const p = at ?? centreOf(tileFor(nick));
    const snapshot: AvatarSnapshot = {
      id: nick, name: nick, characterId: name, room: currentRoom,
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
    if (self) me = person;
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
    if (me === p) me = null;
    updateCount();
  }

  /** Swap the rendered room. Rebuilds the scene and repopulates from `known`. */
  function buildRoom(name: string, placeMeAt?: { x: number; y: number }) {
    const next = pack.rooms.find((r) => r.name === name);
    if (!next) return;

    for (const nick of [...people.keys()]) {
      const p = people.get(nick)!;
      p.tag.remove();
      if (p.bubble) p.bubble.remove();
      people.delete(nick);
    }
    me = null;

    if (scene) { world.removeChild(scene.root); scene.destroy(); }

    room = next;
    scene = new RoomScene(room, pack, textureCache);
    world.addChild(scene.root);
    grid = makeGrid(room);
    spawnPool = openTilesFor(room, grid);
    doorTiles = (room.doors ?? [])
      .map((d) => ({ col: d.col ?? 0, row: d.row ?? 0 }))
      .filter((t) => grid.ok(t.col, t.row));
    currentRoom = room.name;
    currentChannel = channelFor(room.name);
    layout();
    host!.classList.add("ready");
    roomChanged(currentRoom, currentChannel);

    if (selfNick) add(selfNick, true, placeMeAt);
    for (const nick of known.get(currentChannel) ?? []) {
      if (nick !== selfNick) add(nick, false);
    }
    updateCount();
  }

  buildRoom(ROOM_NAME);
  new ResizeObserver(layout).observe(host);

  /** A real PART/QUIT: walk them to the nearest door, then remove them. */
  function walkOut(nick: string) {
    const p = people.get(nick);
    if (!p || p === me) return;
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

  // ── Your own movement ──────────────────────────────────────────
  // Focus-gated: the client's Input class binds to window and swallows WASD and
  // the arrow keys outright, which would stop a visitor scrolling the page. So
  // keys are only captured once you click into the room, and released on blur.
  const held = new Set<string>();
  let active = false;
  /** Re-armed once you step off a door, so arriving does not bounce you back. */
  let doorArmed = true;

  function setActive(on: boolean) {
    active = on;
    held.clear();
    host!.classList.toggle("active", on);
  }

  host.setAttribute("tabindex", "0");
  host.addEventListener("focus", () => setActive(true));
  host.addEventListener("blur", () => setActive(false));
  host.addEventListener("pointerdown", () => host!.focus());

  window.addEventListener("keydown", (e) => {
    if (!active) return;
    if (e.code === "Escape") { host!.blur(); return; }
    if (!MOVE_KEYS.has(e.code)) return;
    e.preventDefault();
    held.add(e.code);
  });
  window.addEventListener("keyup", (e) => { held.delete(e.code); });
  window.addEventListener("blur", () => held.clear());

  function movement(): { dx: number; dy: number } {
    let dx = 0, dy = 0;
    if (held.has("KeyW") || held.has("ArrowUp")) dy -= 1;
    if (held.has("KeyS") || held.has("ArrowDown")) dy += 1;
    if (held.has("KeyA") || held.has("ArrowLeft")) dx -= 1;
    if (held.has("KeyD") || held.has("ArrowRight")) dx += 1;
    if (dx && dy) { const l = Math.SQRT2; dx /= l; dy /= l; }
    return { dx, dy };
  }

  /** Walking onto a door really does PART one channel and JOIN the other. */
  function tryDoor() {
    if (!me || !doorArmed) return;
    const door = scene.getDoorAtPosition(me.x, me.y);
    if (!door) { doorArmed = true; return; }
    const target = door.target ?? "";
    const [targetRoom, targetDoorId] = target.split("#");
    if (!targetRoom || !pack.rooms.some((r) => r.name === targetRoom)) return;

    const from = currentChannel;
    const to = channelFor(targetRoom);
    doorArmed = false;

    const next = pack.rooms.find((r) => r.name === targetRoom)!;
    const arrival = next.doors?.find((d) => d.id === targetDoorId);
    const at = arrival
      ? centreOf({ col: arrival.col ?? 0, row: arrival.row ?? 0 })
      : undefined;

    known.get(from)?.delete(selfNick);
    buildRoom(targetRoom, at);
    if (!known.has(to)) known.set(to, new Set());
    known.get(to)!.add(selfNick);

    if (client && connected) {
      client.part(from, "through the door");
      client.join(to);
      emit("part", selfNick, from, true);
      emit("join", selfNick, to, true);
    }
  }

  function moveMe(dt: number) {
    if (!me) return;
    const { dx, dy } = active ? movement() : { dx: 0, dy: 0 };
    if (!dx && !dy) { me.moving = false; return; }

    const step = MOVE_SPEED * dt;
    // Axis-separated, so you slide along a wall instead of sticking to it —
    // the same check scene/manager.ts makes for the local avatar.
    const nx = me.x + dx * step;
    const ny = me.y + dy * step;
    if (scene.isWalkable(nx, me.y)) me.x = nx;
    if (scene.isWalkable(me.x, ny)) me.y = ny;

    me.dir = Math.abs(dx) > Math.abs(dy)
      ? (dx > 0 ? "right" : "left")
      : (dy > 0 ? "down" : "up");
    me.moving = true;

    if (!scene.getDoorAtPosition(me.x, me.y)) doorArmed = true;
    else tryDoor();
  }

  // ── Frame loop ─────────────────────────────────────────────────
  app.ticker.add((t) => {
    const dt = t.deltaMS / 1000;
    moveMe(dt);

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
      if (p === me) {
        // Your own avatar is authoritative locally — no interpolation lag.
        p.avatar.setPosition(p.x, p.y);
        p.avatar.setDirection(p.dir);
        p.avatar.setMoving(p.moving);
      } else {
        p.avatar.applyServerPosition(p.x, p.y, p.dir, p.moving);
      }
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

  // ── Real IRC ───────────────────────────────────────────────────
  let client: AircClient | null = null;

  function onEvent(e: IrcEvent) {
    switch (e.type) {
      case "registered":
        connected = true;
        selfNick = e.nick;
        known.get(currentChannel)?.add(e.nick);
        add(e.nick, true);
        emit("join", e.nick, currentChannel);
        updateCount();
        break;

      case "join":
        if (e.nick === selfNick) return;
        if (!known.has(e.channel)) known.set(e.channel, new Set());
        known.get(e.channel)!.add(e.nick);
        if (e.channel === currentChannel) add(e.nick, false);
        emit("join", e.nick, e.channel, true);
        break;

      case "part":
        if (e.nick === selfNick) return;
        known.get(e.channel)?.delete(e.nick);
        if (e.channel === currentChannel) walkOut(e.nick);
        emit("part", e.nick, e.channel, true);
        break;

      case "quit":
        if (e.nick === selfNick) return;
        for (const set of known.values()) set.delete(e.nick);
        walkOut(e.nick);
        emit("part", e.nick, currentChannel);
        break;

      case "kick":
        known.get(e.channel)?.delete(e.nick);
        if (e.channel === currentChannel) walkOut(e.nick);
        emit("part", e.nick, e.channel);
        break;

      case "message": {
        const m = e.message;
        if (!m.target.startsWith("#")) {
          emit("pm", m.from, m.text);
        } else {
          if (m.target === currentChannel) say(m.from, m.text);
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
    const c = new AircClient({ nick, url: IRC_URL, autoJoin: [currentChannel] });
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
    for (const set of known.values()) set.clear();
    for (const nick of [...people.keys()]) drop(nick);
    selfNick = "";
    updateCount();
    c.quit("closed the page").catch(() => {}).finally(() => c.destroy());
  }

  // Hold an IRC session only while the hero is actually on screen. A landing
  // page should not keep a connection open for every idle background tab.
  let visible = false;
  const io = new IntersectionObserver((entries) => {
    visible = entries[0]?.isIntersecting ?? false;
    if (visible && !document.hidden) connect();
    else { setActive(false); disconnect(); }
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
