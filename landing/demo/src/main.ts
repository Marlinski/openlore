/**
 * Landing-page hero — the real game client, on the real servers.
 *
 * Nothing here is simulated. It is the shipping client with its own transport:
 *
 *  - Room rendering is RoomScene from game/client/src/scene/.
 *  - Positions come from the game server over the same Connection class the
 *    bundled client uses, against wss://app.openlore.xyz/ws. Other people move
 *    because the server says they moved; you move because you pressed a key and
 *    your position is pushed back at ~15/sec, so players see you too.
 *  - Chat and presence come from IRC (wss://irc.openlore.xyz/ws) via the same
 *    @marlinski/airc client the game uses.
 *  - Doors go through the server's use-door, and the client issues the matching
 *    IRC PART/JOIN — exactly what the bundled client does.
 *
 * If the game server has no world for LOBBY, the hero degrades to IRC-only:
 * the room still renders from a vendored pack and people still appear and talk,
 * they just stand still, because IRC carries no positions. aircd also has no
 * working NAMES (366 with no 353), so presence is seeded with an explicit WHO.
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
import { Connection } from "../../../game/client/src/connection.js";
import type {
  AvatarSnapshot,
  CharacterDirection,
  ServerWelcomeMessage,
  ServerAvatarJoinMessage,
  ServerAvatarLeaveMessage,
  ServerAvatarMoveMessage,
  ServerRoomChangeMessage,
  ServerSnapMessage,
} from "../../../game/client/src/protocol.js";

// ── Config ────────────────────────────────────────────────────────

/** Overridable with <meta name="openlore-game|openlore-irc" content="..."> so the
 *  page can be pointed at a local stack without a rebuild. */
const meta = (n: string) =>
  document.querySelector<HTMLMetaElement>(`meta[name="${n}"]`)?.content?.trim() || "";
const GAME_ORIGIN = meta("openlore-game") || "https://app.openlore.xyz";
const IRC_URL = meta("openlore-irc") || "wss://irc.openlore.xyz/ws";
const LOBBY = "lobby";
const GAME_CHANNEL = `#${LOBBY}`;

const FALLBACK_PACK = "pack/pack.json";
const FALLBACK_ATLAS = "pack/";
const FALLBACK_ROOM = "main_office";

const CHARACTERS = ["amanda", "fiona", "arthur"];

/** The game client's own movement speed and send rate. */
const MOVE_SPEED = 4 * TILE_SIZE;
const POSITION_SEND_MS = 66;
/** Speed for the scripted walk-out when someone leaves in IRC-only mode. */
const WALK_SPEED = 2.4;

const MOVE_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

type Tile = { col: number; row: number };
const centreOf = (t: Tile) => ({
  x: t.col * TILE_SIZE + TILE_SIZE / 2,
  y: t.row * TILE_SIZE + TILE_SIZE / 2,
});
const ircChannelFor = (roomName: string) => `#${LOBBY}-${roomName}`;

function emit(kind: string, nick: string, payload: string, flash = false) {
  window.dispatchEvent(
    new CustomEvent("openlore:irc", { detail: { kind, nick, payload, flash } }),
  );
}
function presence(count: number, connected: boolean, live: boolean) {
  window.dispatchEvent(
    new CustomEvent("openlore:presence", { detail: { count, connected, live } }),
  );
}
function roomChanged(room: string, channel: string) {
  window.dispatchEvent(
    new CustomEvent("openlore:room", { detail: { room, channel } }),
  );
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ── Walkability helpers ───────────────────────────────────────────

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
        { col: cur.col + 1, row: cur.row }, { col: cur.col - 1, row: cur.row },
        { col: cur.col, row: cur.row + 1 }, { col: cur.col, row: cur.row - 1 },
      ]) {
        if (!ok(n.col, n.row)) continue;
        const nk = key(n.col, n.row);
        if (seen.has(nk)) continue;
        seen.add(nk); prev.set(nk, key(cur.col, cur.row)); q.push(n);
      }
    }
    return null;
  }
  return { all, ok, path };
}

/** Tiles no OBJECT placement covers — walkable is not the same as visible. */
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

// ── One rendered person ───────────────────────────────────────────

interface Person {
  id: string;            // game avatarId, or the nick in IRC-only mode
  name: string;
  avatar: Avatar;
  entry: { anchorY: number };
  x: number;
  y: number;
  dir: CharacterDirection;
  moving: boolean;
  self: boolean;
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

  // ── 1. Is there a live world? ────────────────────────────────
  let live = false;
  let pack: Pack | null = null;

  try {
    const chans = await fetch(`${GAME_ORIGIN}/api/channels`).then((r) => r.json());
    if (Array.isArray(chans) && chans.some((c) => c.channel === GAME_CHANNEL)) {
      const slug = encodeURIComponent(LOBBY);
      pack = await fetch(`${GAME_ORIGIN}/api/channels/${slug}/game-data`)
        .then((r) => (r.ok ? r.json() : null));
      // The server serves pack assets from /data/packs/{packId}/, the same
      // base assets.ts resolves against — but absolute, since we are on a
      // different origin.
      const packId = pack?.manifest?.id;
      if (pack && packId) {
        const base = `${GAME_ORIGIN}/data/packs/${encodeURIComponent(packId)}`;
        for (const ts of pack.tilesets) {
          if (!/^https?:/.test(ts.path)) ts.path = `${base}/${ts.path}`;
        }
        live = true;
      }
    }
  } catch (err) {
    console.warn("[hero] game server unreachable, falling back to IRC only", err);
  }

  if (!pack) {
    pack = await fetch(FALLBACK_PACK).then((r) => r.json());
    for (const ts of pack!.tilesets) ts.path = FALLBACK_ATLAS + ts.path;
  }

  await Promise.all(
    pack!.tilesets.map((ts) => loadImage(ts.path).catch((e) => console.warn("[hero]", e))),
  );

  // ── 2. Renderer ──────────────────────────────────────────────
  TextureSource.defaultOptions.scaleMode = "nearest";
  const app = new Application();
  await app.init({
    canvas, backgroundAlpha: 0, antialias: false, autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    width: host.clientWidth || 800, height: host.clientHeight || 440,
  });

  const world = new Container();
  app.stage.addChild(world);
  const textureCache: TextureCache = new Map();

  const charRes = new Map<string, CharacterResources>();
  for (const name of CHARACTERS) {
    const res = resolveCharacterResources(name, pack!);
    if (!res.all.length) continue;
    loadCharacterTextures(res, pack!, textureCache, getCachedImage);
    charRes.set(name, res);
  }
  function resourcesFor(characterId: string, key: string): CharacterResources | null {
    const direct = charRes.get(characterId);
    if (direct) return direct;
    const names = [...charRes.keys()];
    if (!names.length) return null;
    return charRes.get(names[hash(key) % names.length]) ?? null;
  }

  let room!: RoomDefinition;
  let scene!: RoomScene;
  let grid!: ReturnType<typeof makeGrid>;
  let spawnPool: Tile[] = [];
  let currentRoom = "";
  let currentIrc = "";

  const people = new Map<string, Person>();
  let me: Person | null = null;
  let myAvatarId = "";
  let myNick = "";

  function layout() {
    const w = host!.clientWidth, h = host!.clientHeight;
    if (!w || !h || !scene) return;
    app.renderer.resize(w, h);
    const s = Math.min(w / scene.pixelWidth, h / scene.pixelHeight);
    world.scale.set(s);
    world.x = Math.round((w - scene.pixelWidth * s) / 2);
    world.y = Math.round((h - scene.pixelHeight * s) / 2);
  }

  function clearPeople() {
    for (const p of people.values()) { p.tag.remove(); p.bubble?.remove(); }
    people.clear();
    me = null;
  }

  function buildRoom(name: string) {
    const next = pack!.rooms.find((r) => r.name === name);
    if (!next) return;
    clearPeople();
    if (scene) { world.removeChild(scene.root); scene.destroy(); }
    room = next;
    scene = new RoomScene(room, pack!, textureCache);
    world.addChild(scene.root);
    grid = makeGrid(room);
    spawnPool = openTilesFor(room, grid);
    currentRoom = room.name;
    currentIrc = ircChannelFor(room.name);
    layout();
    host!.classList.add("ready");
    roomChanged(currentRoom, currentIrc);
  }

  function addPerson(
    id: string, name: string, characterId: string,
    x: number, y: number, self: boolean,
    dir: CharacterDirection = "down",
  ): Person | null {
    const existing = people.get(id);
    if (existing) return existing;
    const res = resourcesFor(characterId, id);
    if (!res) return null;

    const snapshot: AvatarSnapshot = {
      id, name, characterId, room: currentRoom,
      x, y, direction: dir, moving: false, family: "idle",
    };
    const avatar = new Avatar(snapshot, res, pack!, textureCache, self);
    const entry = scene.addAvatarSprite(avatar.sprite, avatar.anchorY);

    const tag = document.createElement("span");
    tag.className = "tag" + (self ? " tag-self" : "");
    tag.textContent = self ? `${name} (you)` : name;
    overlay!.appendChild(tag);

    const p: Person = {
      id, name, avatar, entry, x, y, dir, moving: false, self,
      leaving: null, tag, bubble: null, bubbleT: 0,
    };
    people.set(id, p);
    if (self) me = p;
    updateCount();
    return p;
  }

  function dropPerson(id: string) {
    const p = people.get(id);
    if (!p) return;
    scene.removeAvatarSprite(p.avatar.sprite);
    p.tag.remove();
    p.bubble?.remove();
    people.delete(id);
    if (me === p) me = null;
    updateCount();
  }

  function byName(name: string): Person | undefined {
    for (const p of people.values()) if (p.name === name) return p;
    return undefined;
  }

  function updateCount() { presence(people.size, ircReady, live); }

  function say(name: string, text: string) {
    const p = byName(name);
    if (!p) return;
    p.bubble?.remove();
    const b = document.createElement("span");
    b.className = "bub";
    b.textContent = text;
    overlay!.appendChild(b);
    p.bubble = b;
    p.bubbleT = 4.5;
  }

  buildRoom(live ? (pack!.rooms[0]?.name ?? FALLBACK_ROOM) : FALLBACK_ROOM);
  new ResizeObserver(layout).observe(host);

  // ── 3. Input ─────────────────────────────────────────────────
  const held = new Set<string>();
  let active = false;
  let chatOpen = false;
  let doorArmed = true;

  function setActive(on: boolean) {
    active = on; held.clear();
    host!.classList.toggle("active", on);
  }

  host.setAttribute("tabindex", "0");
  host.addEventListener("focus", () => setActive(true));
  host.addEventListener("blur", () => { if (!chatOpen) setActive(false); });
  host.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement)?.closest?.(".chatbar")) return;
    host!.focus();
  });

  const chatbar = document.getElementById("chatbar") as HTMLFormElement | null;
  const chatInput = document.getElementById("chatInput") as HTMLInputElement | null;

  const sentAt: number[] = [];
  function canSend(): boolean {
    const now = Date.now();
    while (sentAt.length && now - sentAt[0] > 30_000) sentAt.shift();
    if (sentAt.length >= 5) return false;
    if (sentAt.length && now - sentAt[sentAt.length - 1] < 1200) return false;
    return true;
  }
  function openChat() {
    if (!chatbar || !chatInput || chatOpen) return;
    chatOpen = true; held.clear();
    chatbar.hidden = false;
    host!.classList.add("chatting");
    chatInput.value = "";
    chatInput.disabled = !ircReady;
    chatInput.placeholder = ircReady ? "say something…" : "not connected";
    chatInput.focus();
  }
  function closeChat() {
    if (!chatbar || !chatOpen) return;
    chatOpen = false; chatbar.hidden = true;
    host!.classList.remove("chatting");
    host!.focus();
  }
  function sendChat() {
    if (!chatInput) return;
    // CR, LF and NUL split an IRC line; anything reaching the wire with them in
    // it can inject commands, so they never get that far.
    const text = chatInput.value.replace(/[\r\n\0]/g, " ").trim().slice(0, 200);
    chatInput.value = "";
    if (!text || !irc || !ircReady) { closeChat(); return; }
    if (!canSend()) { chatInput.placeholder = "easy — slow down a moment"; return; }
    sentAt.push(Date.now());
    irc.say(currentIrc, text);
    closeChat();
  }
  chatbar?.addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });
  chatInput?.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); closeChat(); }
    else if (e.key === "Enter") { e.preventDefault(); sendChat(); }
  });

  window.addEventListener("keydown", (e) => {
    if (!active || chatOpen) return;
    if (e.code === "Enter") { e.preventDefault(); openChat(); return; }
    if (e.code === "Escape") { host!.blur(); return; }
    if (!MOVE_KEYS.has(e.code)) return;
    e.preventDefault();
    held.add(e.code);
  });
  window.addEventListener("keyup", (e) => held.delete(e.code));
  window.addEventListener("blur", () => held.clear());

  function movement() {
    if (chatOpen) return { dx: 0, dy: 0 };
    let dx = 0, dy = 0;
    if (held.has("KeyW") || held.has("ArrowUp")) dy -= 1;
    if (held.has("KeyS") || held.has("ArrowDown")) dy += 1;
    if (held.has("KeyA") || held.has("ArrowLeft")) dx -= 1;
    if (held.has("KeyD") || held.has("ArrowRight")) dx += 1;
    if (dx && dy) { dx /= Math.SQRT2; dy /= Math.SQRT2; }
    return { dx, dy };
  }

  // ── 4. Game server ───────────────────────────────────────────
  const conn = new Connection();
  let sendAcc = 0;

  conn.on<ServerWelcomeMessage>("welcome", (msg) => {
    myAvatarId = msg.avatarId;
    if (msg.room?.name && msg.room.name !== currentRoom) buildRoom(msg.room.name);
    else clearPeople();
    for (const a of msg.avatars ?? []) {
      if (a.id === myAvatarId) continue;
      addPerson(a.id, a.name, a.characterId, a.x, a.y, false, a.direction);
    }
    addPerson(myAvatarId, myNick || "you", CHARACTERS[0], msg.spawnX, msg.spawnY, true);
    if (irc && ircReady) joinIrc(currentIrc);
  });

  conn.on<ServerAvatarJoinMessage>("avatar-join", (msg) => {
    const a = msg.avatar;
    if (!a || a.id === myAvatarId) return;
    addPerson(a.id, a.name, a.characterId, a.x, a.y, false, a.direction);
  });

  conn.on<ServerAvatarLeaveMessage>("avatar-leave", (msg) => {
    if (msg.avatarId !== myAvatarId) dropPerson(msg.avatarId);
  });

  conn.on<ServerAvatarMoveMessage>("avatar-move", (msg) => {
    const p = people.get(msg.avatarId);
    if (!p || p.self) return;
    p.x = msg.x; p.y = msg.y; p.dir = msg.direction; p.moving = msg.moving;
    p.avatar.family = msg.moving ? "walk" : "idle";
    p.avatar.applyServerPosition(msg.x, msg.y, msg.direction, msg.moving);
  });

  conn.on<ServerRoomChangeMessage>("room-change", (msg) => {
    const prevIrc = currentIrc;
    buildRoom(msg.room.name);
    for (const a of msg.avatars ?? []) {
      if (a.id === myAvatarId) continue;
      addPerson(a.id, a.name, a.characterId, a.x, a.y, false, a.direction);
    }
    addPerson(myAvatarId, myNick || "you", CHARACTERS[0], msg.spawnX, msg.spawnY, true);
    doorArmed = false;
    // The server moves the avatar; the client is what tells IRC about it.
    if (irc && ircReady && prevIrc !== currentIrc) {
      irc.part(prevIrc, "through the door");
      joinIrc(currentIrc);
      emit("part", myNick, prevIrc, true);
      emit("join", myNick, currentIrc, true);
    }
  });

  conn.on<ServerSnapMessage>("snap", (msg) => {
    if (!me) return;
    me.x = msg.x; me.y = msg.y;
    me.avatar.applySnap(msg.x, msg.y);
  });

  async function connectGame() {
    if (!live) return;
    try {
      const nick = myNick || ("web-" + Math.random().toString(36).slice(2, 8));
      const res = await fetch(`${GAME_ORIGIN}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nick, characterId: CHARACTERS[hash(nick) % CHARACTERS.length] }),
      });
      if (!res.ok) throw new Error("register failed: " + res.status);
      const { token } = await res.json();
      conn.onConnect(() => conn.send({ type: "join", token }));
      conn.connect(GAME_CHANNEL, GAME_ORIGIN);
    } catch (err) {
      console.warn("[hero] game connect failed, staying IRC-only", err);
      live = false;
      updateCount();
    }
  }

  // ── 5. IRC ───────────────────────────────────────────────────
  let irc: AircClient | null = null;
  let ircReady = false;
  const joined = new Set<string>();

  function joinIrc(ch: string) {
    if (!irc || joined.has(ch)) return;
    joined.add(ch);
    irc.join(ch);
  }

  function onIrc(e: IrcEvent) {
    switch (e.type) {
      case "registered":
        ircReady = true;
        myNick = e.nick;
        if (me) { me.name = e.nick; me.tag.textContent = `${e.nick} (you)`; }
        joinIrc(currentIrc);
        emit("join", e.nick, currentIrc);
        updateCount();
        break;

      case "join":
        if (e.channel !== currentIrc) break;
        if (e.nick === myNick) { irc?.sendLine("WHO " + e.channel); break; }
        if (!live) addIrcOnly(e.nick);
        emit("join", e.nick, e.channel, true);
        break;

      case "raw": {
        // aircd sends no 353, so presence is seeded from an explicit WHO.
        const f = e.line.split(" ");
        if (f[1] !== "352" || f[3] !== currentIrc || !f[7]) break;
        if (!live && f[7] !== myNick) addIrcOnly(f[7]);
        break;
      }

      case "part":
      case "quit": {
        const ch = (e as { channel?: string }).channel;
        if (ch && ch !== currentIrc) break;
        if (e.nick === myNick) break;
        if (!live) walkOut(e.nick);
        emit("part", e.nick, ch ?? currentIrc, true);
        break;
      }

      case "message": {
        const m = e.message;
        if (!m.target.startsWith("#")) { emit("pm", m.from, m.text); break; }
        if (m.target === currentIrc) say(m.from, m.text);
        emit("msg", m.from, m.text);
        break;
      }

      case "disconnected": ircReady = false; updateCount(); break;
      case "reconnected": ircReady = true; updateCount(); break;
    }
  }

  /** IRC-only fallback: no positions exist, so stand them on a stable tile. */
  function addIrcOnly(nick: string) {
    if (people.has(nick)) return;
    const pool = spawnPool.length ? spawnPool : grid.all;
    const t = pool[hash(nick) % pool.length] ?? { col: 1, row: 1 };
    const c = centreOf(t);
    addPerson(nick, nick, CHARACTERS[hash(nick) % CHARACTERS.length], c.x, c.y, false);
  }

  function walkOut(nick: string) {
    const p = people.get(nick);
    if (!p || p.self) return;
    const from = { col: Math.floor(p.x / TILE_SIZE), row: Math.floor(p.y / TILE_SIZE) };
    let best: Tile[] | null = null;
    for (const d of (room.doors ?? [])) {
      const t = { col: d.col ?? 0, row: d.row ?? 0 };
      if (!grid.ok(t.col, t.row)) continue;
      const route = grid.path(from, t);
      if (route && (!best || route.length < best.length)) best = route;
    }
    if (!best?.length) { dropPerson(nick); return; }
    p.leaving = best;
  }

  async function connectIrc() {
    if (irc) return;
    const nick = myNick || ("web-" + Math.random().toString(36).slice(2, 8));
    myNick = nick;
    const c = new AircClient({ nick, url: IRC_URL, autoJoin: [] });
    irc = c;
    c.on(onIrc);
    try { await c.connect(); }
    catch (err) {
      console.warn("[hero] IRC connect failed", err);
      ircReady = false; irc = null;
      updateCount();
    }
  }

  function disconnectAll() {
    closeChat();
    setActive(false);
    conn.disconnect();
    joined.clear();
    const c = irc;
    irc = null; ircReady = false;
    if (!live) clearPeople();
    updateCount();
    c?.quit("closed the page").catch(() => {}).finally(() => c.destroy());
  }

  // ── 6. Frame loop ────────────────────────────────────────────
  app.ticker.add((t) => {
    const dt = t.deltaMS / 1000;

    if (me) {
      const { dx, dy } = active ? movement() : { dx: 0, dy: 0 };
      if (dx || dy) {
        const step = MOVE_SPEED * dt;
        const nx = me.x + dx * step, ny = me.y + dy * step;
        // Axis-separated so you slide along walls, as the bundled client does.
        if (scene.isWalkable(nx, me.y)) me.x = nx;
        if (scene.isWalkable(me.x, ny)) me.y = ny;
        me.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
        me.moving = true;
      } else {
        me.moving = false;
      }

      const door = scene.getDoorAtPosition(me.x, me.y);
      if (!door) doorArmed = true;
      else if (doorArmed && door.id) {
        doorArmed = false;
        if (live && conn.connected) conn.send({ type: "use-door", doorId: door.id });
      }

      me.avatar.family = me.moving ? "walk" : "idle";
      me.avatar.setPosition(me.x, me.y);
      me.avatar.setDirection(me.dir);
      me.avatar.setMoving(me.moving);

      // Push our position at the same rate the bundled client uses.
      sendAcc += t.deltaMS;
      if (live && conn.connected && sendAcc >= POSITION_SEND_MS) {
        sendAcc = 0;
        conn.send({ type: "position", x: me.x, y: me.y, direction: me.dir, moving: me.moving });
      }
    }

    for (const p of [...people.values()]) {
      if (p.self) { p.avatar.update(dt); p.entry.anchorY = p.avatar.anchorY; continue; }
      if (p.leaving) {
        const target = centreOf(p.leaving[0]);
        const dx = target.x - p.x, dy = target.y - p.y;
        const dist = Math.hypot(dx, dy);
        const step = WALK_SPEED * TILE_SIZE * dt;
        if (dist <= step) {
          p.x = target.x; p.y = target.y; p.leaving.shift();
          if (!p.leaving.length) { dropPerson(p.id); continue; }
        } else {
          p.x += (dx / dist) * step; p.y += (dy / dist) * step;
          p.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
          p.moving = true;
        }
        p.avatar.family = "walk";
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
      p.tag.style.transform = `translate(${sx}px,${sy}px) translate(-50%,-100%)`;
      if (p.bubble) {
        p.bubble.style.transform = `translate(${sx}px,${sy - 15}px) translate(-50%,-100%)`;
      }
    }
  });

  // ── 7. Lifecycle ─────────────────────────────────────────────
  let visible = false;
  let started = false;

  async function begin() {
    if (started) return;
    started = true;
    await connectIrc();
    await connectGame();
    if (!live && irc) {
      // Nothing to spawn us from the server, so stand ourselves up.
      const pool = spawnPool.length ? spawnPool : grid.all;
      const t = pool[hash(myNick) % pool.length] ?? { col: 1, row: 1 };
      const c = centreOf(t);
      addPerson(myNick, myNick, CHARACTERS[hash(myNick) % CHARACTERS.length], c.x, c.y, true);
      irc.sendLine("WHO " + currentIrc);
    }
    updateCount();
  }

  const io = new IntersectionObserver((entries) => {
    visible = entries[0]?.isIntersecting ?? false;
    if (visible && !document.hidden) begin();
    else if (started) { disconnectAll(); started = false; }
  }, { threshold: 0.05 });
  io.observe(host);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && started) { disconnectAll(); started = false; }
    else if (visible) begin();
  });
  window.addEventListener("pagehide", () => { if (started) disconnectAll(); });

  updateCount();
}

start().catch((e) => {
  console.error("[hero] failed to start", e);
  document.getElementById("game")?.parentElement?.classList.add("failed");
});
