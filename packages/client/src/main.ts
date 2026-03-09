/**
 * Client entry point.
 *
 * Bootstraps the game:
 *   1. Fetch game data from server
 *   2. Preload all tileset images
 *   3. Create PixiJS application
 *   4. Create Connection, Input, SceneManager, HUD, BubbleManager
 *   5. Connect to server and send join
 *   6. Handle window resize
 *
 * For V1: single-player flow with a simple join form.
 */

import { Application } from "pixi.js";
import type { ProjectData } from "@offisims/shared";
import { preloadGameAssets } from "./assets.js";
import { Connection } from "./connection.js";
import { Input } from "./input.js";
import { SceneManager } from "./scene/manager.js";
import { BubbleManager } from "./ui/bubble.js";
import { Hud } from "./ui/hud.js";

// ─── DOM elements ─────────────────────────────────────────────────

const joinScreen = document.getElementById("join-screen") as HTMLDivElement;
const joinForm = document.getElementById("join-form") as HTMLFormElement;
const nameInput = document.getElementById("name-input") as HTMLInputElement;
const charSelect = document.getElementById("char-select") as HTMLSelectElement;
const joinBtn = document.getElementById("join-btn") as HTMLButtonElement;
const joinStatus = document.getElementById("join-status") as HTMLDivElement;

const gameScreen = document.getElementById("game-screen") as HTMLDivElement;
const canvasWrap = document.getElementById("canvas-wrap") as HTMLDivElement;
const bubbleContainer = document.getElementById("bubble-container") as HTMLDivElement;
const hudContainer = document.getElementById("hud-container") as HTMLDivElement;

// ─── Boot ─────────────────────────────────────────────────────────

let gameData: ProjectData | null = null;
let connection: Connection | null = null;

async function boot(): Promise<void> {
  joinStatus.textContent = "Loading game data...";

  try {
    // Fetch game data
    const res = await fetch("/api/game-data");
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    gameData = (await res.json()) as ProjectData;

    // Preload assets
    joinStatus.textContent = "Loading assets...";
    await preloadGameAssets(gameData);

    // Populate character select
    populateCharSelect(gameData);

    joinStatus.textContent = "Ready. Enter your name and join!";
    joinBtn.disabled = false;
  } catch (err) {
    joinStatus.textContent = `Failed to load: ${err}`;
    console.error("[Boot] Failed:", err);
  }
}

function populateCharSelect(data: ProjectData): void {
  charSelect.innerHTML = "";
  if (data.characters.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no characters available)";
    charSelect.appendChild(opt);
    return;
  }
  for (const char of data.characters) {
    const opt = document.createElement("option");
    opt.value = char.id;
    opt.textContent = char.name;
    charSelect.appendChild(opt);
  }
}

// ─── Join ─────────────────────────────────────────────────────────

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  startGame();
});

async function startGame(): Promise<void> {
  if (!gameData) return;

  const name = nameInput.value.trim();
  const characterId = charSelect.value;

  if (!name) {
    joinStatus.textContent = "Please enter a name.";
    return;
  }
  if (!characterId) {
    joinStatus.textContent = "Please select a character.";
    return;
  }

  joinBtn.disabled = true;
  joinStatus.textContent = "Connecting...";

  try {
    // Switch to game screen BEFORE creating PixiJS app so that
    // canvasWrap has non-zero dimensions.
    joinScreen.style.display = "none";
    gameScreen.style.display = "block";

    // Force a synchronous reflow so the browser computes layout.
    // Without this, clientWidth/clientHeight may still be 0.
    const initW = canvasWrap.clientWidth;
    const initH = canvasWrap.clientHeight;

    // Create PixiJS app with explicit dimensions (NOT resizeTo)
    // to avoid a 0-size canvas that kills the WebGL context.
    const app = new Application();
    await app.init({
      width: initW,
      height: initH,
      backgroundColor: 0x1a1a2e,
      antialias: false,
      roundPixels: true,
    });

    const canvas = app.canvas as HTMLCanvasElement;
    canvas.style.imageRendering = "pixelated";
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvasWrap.appendChild(canvas);

    // Create connection
    connection = new Connection();
    const input = new Input();

    // Create scene manager
    const scene = new SceneManager(app, connection, input, gameData);

    // Create HUD
    const hud = new Hud(hudContainer, connection, input);
    scene.setHud(hud);

    // Create bubble manager
    const bubbles = new BubbleManager(
      bubbleContainer,
      scene.getCamera(),
      () => scene.getAvatars(),
    );
    scene.setBubbleManager(bubbles);

    // Handle resize — use ResizeObserver for reliable detection
    // (catches dev tools opening, split-screen, etc., not just window resize)
    const onResize = () => {
      const w = canvasWrap.clientWidth;
      const h = canvasWrap.clientHeight;
      if (w > 0 && h > 0) {
        scene.onResize(w, h);
      }
    };
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(canvasWrap);

    // Connect and join
    connection.onConnect(() => {
      connection!.send({
        type: "join",
        name,
        characterId,
      });
      hud.updateStatus();
    });

    connection.onDisconnect(() => {
      hud.updateStatus();
    });

    // Listen for welcome to set room name in HUD
    connection.on("welcome", (msg: any) => {
      hud.setRoomName(msg.room?.name ?? "");
    });

    // Listen for room-change to update HUD room name
    connection.on("room-change", (msg: any) => {
      hud.setRoomName(msg.room.name);
    });

    // Listen for errors
    connection.on("error", (msg: any) => {
      console.error("[Server Error]", msg.message);
      joinStatus.textContent = `Error: ${msg.message}`;
    });

    connection.connect();
  } catch (err) {
    // Restore join screen on failure
    joinScreen.style.display = "";
    gameScreen.style.display = "none";
    joinStatus.textContent = `Error: ${err}`;
    joinBtn.disabled = false;
    console.error("[StartGame] Failed:", err);
  }
}

// ─── Init ─────────────────────────────────────────────────────────

boot();
