/**
 * Client entry point.
 *
 * Bootstraps the game:
 *   1. Fetch game data from server and preload assets
 *   2. If a session token cookie exists, validate via REST then start game
 *   3. Otherwise show join form — on submit, call POST /api/register
 *   4. Store token as cookie, render GameScreen which handles WebSocket + PixiJS
 */

import { render } from "preact";
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { Pack } from "@offisims/pack";
import { preloadGameAssets } from "./assets";
import {
  screen, joinStatus, joinReady, gameData,
} from "./store";
import { JoinScreen } from "./ui/components/JoinScreen";
import { GameScreen } from "./ui/components/GameScreen";
import "./styles.css";

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

// ─── App component ────────────────────────────────────────────────

function App() {
  const token = signal<string | null>(null);

  /** Start the game screen with a valid token */
  const startGame = (t: string) => {
    token.value = t;
    screen.value = "game";
  };

  /** Session was invalidated by the server — go back to join screen */
  const handleSessionInvalid = () => {
    deleteCookie(COOKIE_NAME);
    token.value = null;
    screen.value = "join";
    joinReady.value = true;
    joinStatus.value = "Session expired. Please join again.";
  };

  /** Handle join form submission */
  const handleJoin = async (name: string, characterId: string) => {
    joinReady.value = false;
    joinStatus.value = "Registering...";

    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, characterId }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Registration failed" }));
        throw new Error(body.error || `Server returned ${res.status}`);
      }

      const { token: newToken } = (await res.json()) as { token: string };
      setCookie(COOKIE_NAME, newToken, COOKIE_MAX_AGE);
      startGame(newToken);
    } catch (err) {
      joinStatus.value = `Error: ${err}`;
      joinReady.value = true;
      console.error("[Register] Failed:", err);
    }
  };

  // Boot sequence — runs once when App mounts
  useEffect(() => {
    (async () => {
      joinStatus.value = "Loading game data...";

      try {
        const res = await fetch("/api/game-data");
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data = (await res.json()) as Pack;
        gameData.value = data;

        joinStatus.value = "Loading assets...";
        await preloadGameAssets(data);

        // Check for existing session token
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

        // No valid token — show join form
        joinStatus.value = "Ready. Enter your name and join!";
        joinReady.value = true;
      } catch (err) {
        joinStatus.value = `Failed to load: ${err}`;
        console.error("[Boot] Failed:", err);
      }
    })();
  }, []);

  return (
    <>
      {screen.value === "join" && (
        <JoinScreen onJoin={handleJoin} />
      )}
      {screen.value === "game" && token.value && gameData.value && (
        <GameScreen
          token={token.value}
          gameData={gameData.value}
          onSessionInvalid={handleSessionInvalid}
        />
      )}
    </>
  );
}

// ─── Mount ────────────────────────────────────────────────────────

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
}
