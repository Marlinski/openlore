/**
 * Room Preview Tool
 *
 * Uses the shared PixiJS renderer to display a room with composites
 * and animated characters. This is the "game-like" renderer that
 * will be reused by the actual game.
 */

import {
  Application,
  Container,
  Sprite,
  Texture,
  Assets,
  AnimatedSprite,
  Rectangle,
} from "pixi.js";
import {
  CompositeDefinition,
  RoomPlan,
  TILE_SIZE,
  getOfficeSinglePath,
  getCharacterPath,
} from "../../src/shared/types";
import { renderRoom, preloadRoomTextures } from "../../src/shared/renderer";

// ─── State ───────────────────────────────────────────────────────────────────

let room: RoomPlan | null = null;
let composites: CompositeDefinition[] = [];
let app: Application | null = null;
let roomContainer: Container | null = null;
let scale = 2;
let showGrid = false;
let showOccupancy = false;

interface PlacedCharacter {
  name: string;
  x: number;
  y: number;
  container: Container;
  idleSprite: AnimatedSprite | null;
}

const characters: PlacedCharacter[] = [];

// ─── PixiJS Init ─────────────────────────────────────────────────────────────

async function initApp() {
  const container = document.getElementById("canvas-container")!;

  if (app) {
    app.destroy(true);
  }

  app = new Application();
  await app.init({
    background: 0x0a0a1a,
    resizeTo: container,
    antialias: false,
    roundPixels: true,
  });

  container.appendChild(app.canvas);
  app.stage.scale.set(scale);
}

// ─── Render Room ─────────────────────────────────────────────────────────────

async function renderCurrentRoom() {
  if (!app || !room) return;

  setStatus("Loading textures...");
  await preloadRoomTextures(room, composites);

  if (roomContainer) {
    app.stage.removeChild(roomContainer);
    roomContainer.destroy({ children: true });
  }

  setStatus("Rendering room...");
  roomContainer = renderRoom(room, composites, {
    showGrid,
    showOccupancy,
    gridColor: 0xffffff,
    gridAlpha: 0.12,
  });

  app.stage.addChild(roomContainer);

  setStatus(
    `Rendering: ${room.name} (${room.width}x${room.height}) with ${room.objects.length} objects`
  );
}

// ─── Character Animation ─────────────────────────────────────────────────────

async function addCharacter(name: string) {
  if (!app || !room) return;

  const idlePath = getCharacterPath(name, "idle");
  setStatus(`Loading character: ${name}...`);

  try {
    const texture = await Assets.load(idlePath);

    // The idle sheet is a single row of frames
    // Each character frame appears to be ~48x48 based on the sprite sheet
    // Let's detect frame size from the texture dimensions
    const texWidth = texture.width;
    const texHeight = texture.height;

    // Characters are roughly 48x48 per frame in a single row
    const frameW = texHeight; // Use height as frame width (square frames)
    const frameH = texHeight;
    const frameCount = Math.floor(texWidth / frameW);

    const frames: Texture[] = [];
    for (let i = 0; i < frameCount; i++) {
      const rect = new Rectangle(i * frameW, 0, frameW, frameH);
      frames.push(new Texture({ source: texture.source, frame: rect }));
    }

    if (frames.length === 0) {
      setStatus(`No frames found for ${name}`);
      return;
    }

    const anim = new AnimatedSprite(frames);
    anim.animationSpeed = 0.08; // Slow breathing
    anim.play();

    // Place character in the center of the room
    const charContainer = new Container();
    charContainer.label = `char_${name}`;

    const cx = Math.floor(room.width / 2) * TILE_SIZE;
    const cy = Math.floor(room.height / 2) * TILE_SIZE;
    charContainer.x = cx;
    charContainer.y = cy;

    // Scale character to roughly 1 tile
    anim.width = TILE_SIZE;
    anim.height = TILE_SIZE;

    charContainer.addChild(anim);

    // Make character draggable
    charContainer.eventMode = "static";
    charContainer.cursor = "grab";

    let dragging = false;
    let dragOffset = { x: 0, y: 0 };

    charContainer.on("pointerdown", (e) => {
      dragging = true;
      const parent = charContainer.parent;
      if (!parent) return;
      const pos = e.getLocalPosition(parent);
      dragOffset.x = pos.x - charContainer.x;
      dragOffset.y = pos.y - charContainer.y;
      charContainer.cursor = "grabbing";
    });

    app!.stage.on("pointermove", (e) => {
      if (!dragging) return;
      const parent = charContainer.parent;
      if (!parent) return;
      const pos = e.getLocalPosition(parent);
      charContainer.x = pos.x - dragOffset.x;
      charContainer.y = pos.y - dragOffset.y;
    });

    app!.stage.on("pointerup", () => {
      dragging = false;
      charContainer.cursor = "grab";
    });

    app!.stage.eventMode = "static";

    if (roomContainer) {
      roomContainer.addChild(charContainer);
    } else {
      app!.stage.addChild(charContainer);
    }

    characters.push({
      name,
      x: cx,
      y: cy,
      container: charContainer,
      idleSprite: anim,
    });

    setStatus(`Added character: ${name} (drag to move)`);
  } catch (e) {
    setStatus(`Failed to load character ${name}: ${e}`);
  }
}

// ─── File Loading ────────────────────────────────────────────────────────────

function loadRoomFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      room = JSON.parse(text);
      await renderCurrentRoom();
    } catch (e) {
      setStatus(`Load error: ${e}`);
    }
  };
  input.click();
}

function loadCompositesFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (Array.isArray(data)) {
        composites = data;
      } else if (data.composites) {
        composites = data.composites;
      }
      setStatus(`Loaded ${composites.length} composites`);
      if (room) await renderCurrentRoom();
    } catch (e) {
      setStatus(`Import error: ${e}`);
    }
  };
  input.click();
}

// Also try loading from localStorage
function loadFromStorage() {
  try {
    const roomRaw = localStorage.getItem("offisims_room");
    if (roomRaw) room = JSON.parse(roomRaw);
  } catch {}

  try {
    const compRaw = localStorage.getItem("offisims_composites");
    if (compRaw) composites = JSON.parse(compRaw);
  } catch {}
}

// ─── Controls ────────────────────────────────────────────────────────────────

document.getElementById("btn-load-room")!.addEventListener("click", loadRoomFile);
document.getElementById("btn-load-composites")!.addEventListener("click", loadCompositesFile);

document.getElementById("show-grid")!.addEventListener("change", async (e) => {
  showGrid = (e.target as HTMLInputElement).checked;
  if (room) await renderCurrentRoom();
});

document.getElementById("show-occupancy")!.addEventListener("change", async (e) => {
  showOccupancy = (e.target as HTMLInputElement).checked;
  if (room) await renderCurrentRoom();
});

document.getElementById("scale-select")!.addEventListener("change", async (e) => {
  scale = parseInt((e.target as HTMLSelectElement).value);
  if (app) {
    app.stage.scale.set(scale);
  }
});

document.getElementById("btn-add-character")!.addEventListener("click", () => {
  const charName = (document.getElementById("char-select") as HTMLSelectElement).value;
  addCharacter(charName);
});

function setStatus(msg: string) {
  document.getElementById("status")!.textContent = msg;
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function main() {
  loadFromStorage();
  await initApp();

  if (room) {
    await renderCurrentRoom();
  } else {
    setStatus("No room loaded. Use 'Load Room' or create one in the Editor first.");
  }
}

main();
