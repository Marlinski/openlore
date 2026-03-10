/**
 * Client entry point.
 *
 * Bootstraps the game:
 *   1. Fetch game data from server and preload assets
 *   2. If a session token cookie exists, skip join screen and reconnect
 *   3. Otherwise show join form — on submit, call POST /api/register
 *      to create a player account and get a token
 *   4. Store token as cookie, connect WebSocket, send join { token }
 *   5. Create PixiJS app, SceneManager, HUD, panels, etc.
 */

import { Application } from "pixi.js";
import type { ProjectData } from "@offisims/shared";
import { preloadGameAssets } from "./assets.js";
import { Connection } from "./connection.js";
import { Input } from "./input.js";
import { SceneManager } from "./scene/manager.js";
import { BubbleManager } from "./ui/bubble.js";
import { Hud } from "./ui/hud.js";
import { CharacterCard } from "./ui/panel.js";
import { ChannelPanel } from "./ui/channel.js";

// ─── Cookie helpers ───────────────────────────────────────────────

const COOKIE_NAME = "offisims_token";
/** Cookie max-age: 24 hours */
const COOKIE_MAX_AGE = 86400;

function getCookie(name: string): string | null {
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string, maxAge: number): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
}

function deleteCookie(name: string): void {
  document.cookie = `${name}=; path=/; max-age=0`;
}

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
let input: Input | null = null;

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

    // Check for existing session token — validate before starting game.
    // We MUST validate the token via REST before calling startGame(),
    // because startGame() creates a PixiJS Application + WebGL context.
    // If the token is stale (e.g. server restarted), letting startGame()
    // run and then tearing it down causes a black screen on the second
    // startGame() call (WebGL context conflicts).
    const existingToken = getCookie(COOKIE_NAME);
    if (existingToken) {
      const sessionRes = await fetch(`/api/session?token=${encodeURIComponent(existingToken)}`);
      if (sessionRes.ok) {
        startGame(existingToken);
        return;
      }
      // Token is invalid — delete cookie and fall through to join form
      deleteCookie(COOKIE_NAME);
    }

    // No token — show join form
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

// ─── Join (registration) ──────────────────────────────────────────

joinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
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
  joinStatus.textContent = "Registering...";

  try {
    // Register via REST API
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, characterId }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Registration failed" }));
      throw new Error(body.error || `Server returned ${res.status}`);
    }

    const { token } = (await res.json()) as { token: string };

    // Store token as cookie
    setCookie(COOKIE_NAME, token, COOKIE_MAX_AGE);

    // Start the game
    startGame(token);
  } catch (err) {
    joinStatus.textContent = `Error: ${err}`;
    joinBtn.disabled = false;
    console.error("[Register] Failed:", err);
  }
});

// ─── Game startup ─────────────────────────────────────────────────

/**
 * Start the game engine and connect to the server.
 * The token identifies the player — used in every join message.
 */
async function startGame(token: string): Promise<void> {
  if (!gameData) return;

  try {
    // Switch to game screen BEFORE creating PixiJS app so that
    // canvasWrap has non-zero dimensions.
    joinScreen.style.display = "none";
    gameScreen.style.display = "block";

    // Read dimensions — use window size as fallback if layout hasn't
    // resolved yet (can happen on first load with CSS @import).
    const initW = canvasWrap.clientWidth || window.innerWidth;
    const initH = canvasWrap.clientHeight || window.innerHeight;

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
    input = new Input();

    // Create scene manager
    const scene = new SceneManager(app, connection, input, gameData);

    // Create HUD (status indicator + zoom controls)
    const hud = new Hud(hudContainer, connection);
    scene.setHud(hud);
    hud.setOnZoomChange((zoom) => scene.setZoom(zoom));

    // Create bubble manager
    const bubbles = new BubbleManager(
      bubbleContainer,
      scene.getCamera(),
      () => scene.getAvatars(),
    );
    scene.setBubbleManager(bubbles);

    // Create character card (right panel — avatar interaction)
    const characterCard = new CharacterCard(gameScreen, connection, input);
    scene.setCharacterCard(characterCard);

    // Create channel panel (left panel — room chat)
    const channelPanel = new ChannelPanel(gameScreen, connection, input);
    scene.setChannelPanel(channelPanel);

    // Handle canvas clicks for avatar interaction
    canvas.addEventListener("click", (e) => {
      if (input?.chatOpen) return;
      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      scene.handleCanvasClick(screenX, screenY);
    });

    // Handle resize
    const onResize = () => {
      const w = canvasWrap.clientWidth;
      const h = canvasWrap.clientHeight;
      if (w > 0 && h > 0) {
        scene.onResize(w, h);
      }
    };
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(canvasWrap);

    // On every (re)connect, send join with the token
    connection.onConnect(() => {
      connection!.send({ type: "join", token });
      hud.updateStatus();
    });

    connection.onDisconnect(() => {
      hud.updateStatus();
    });

    // Listen for welcome — update UI
    connection.on("welcome", (msg: any) => {
      channelPanel.setRoomName(msg.room?.name ?? "");
    });

    // Listen for errors
    connection.on("error", (msg: any) => {
      // If the server rejected our token (invalid/expired session),
      // delete the cookie and silently fall back to the join screen.
      // This should rarely happen now (boot() validates the token via
      // REST first), but it's kept as a safety net. We must fully
      // destroy the PixiJS app so a subsequent startGame() call gets
      // a clean WebGL context.
      if (msg.message === "Invalid or expired session.") {
        deleteCookie(COOKIE_NAME);
        connection!.disconnect();
        connection = null;
        if (input) {
          input.destroy();
          input = null;
        }
        // Tear down PixiJS — destroy textures + context
        try {
          app.destroy(true, { children: true, texture: true });
        } catch (_) {
          /* ignore cleanup errors */
        }
        canvasWrap.innerHTML = "";
        gameScreen.style.display = "none";
        joinScreen.style.display = "";
        populateCharSelect(gameData!);
        joinStatus.textContent = "Ready. Enter your name and join!";
        joinBtn.disabled = false;
        return;
      }

      console.error("[Server Error]", msg.message);
      joinStatus.textContent = `Error: ${msg.message}`;
    });

    // Listen for room-change to update channel panel room name
    connection.on("room-change", (msg: any) => {
      channelPanel.setRoomName(msg.room.name);
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
