/**
 * Client entry point.
 *
 * Bootstraps the game:
 *   1. Show lore browser (always the first screen)
 *   2. Player picks a lore — game data is fetched for that lore
 *   3. If no session token, show JoinScreen (register name + pick character)
 *   4. If session token exists (returning player), skip straight to game
 *   5. Render GameScreen which handles WebSocket + PixiJS
 */

import { render } from "preact";
import { useEffect } from "preact/hooks";
import type { Pack } from "@offisims/pack";
import { preloadGameAssets } from "./assets";
import {
  screen, joinStatus, joinReady, gameData, currentLore, sessionToken,
} from "./store";
import { JoinScreen } from "./ui/components/JoinScreen";
import { LoreBrowser } from "./ui/components/LoreBrowser";
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
  /** Fetch game data for a lore, preload assets, return the pack */
  const loadLoreData = async (channel: string): Promise<Pack> => {
    const chName = channel.startsWith("#") ? channel.slice(1) : channel;
    const res = await fetch(`/api/channels/${encodeURIComponent(chName)}/game-data`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = (await res.json()) as Pack;
    gameData.value = data;
    await preloadGameAssets(data);
    return data;
  };

  /** Enter the game screen */
  const enterGame = () => {
    screen.value = "game";
  };

  /** Session was invalidated by the server — go back to lore browser */
  const handleSessionInvalid = () => {
    deleteCookie(COOKIE_NAME);
    sessionToken.value = null;
    currentLore.value = null;
    gameData.value = null;
    screen.value = "lore";
  };

  /** Handle lore selection from the lore browser */
  const handleJoinLore = async (channel: string) => {
    currentLore.value = channel;

    try {
      await loadLoreData(channel);

      if (sessionToken.value) {
        // Returning player — skip join screen, go straight to game
        enterGame();
      } else {
        // New player — show join screen to register name + pick character
        joinStatus.value = "Enter your name and pick a character!";
        joinReady.value = true;
        screen.value = "join";
      }
    } catch (err) {
      console.error("[JoinLore] Failed:", err);
      currentLore.value = null;
    }
  };

  /** Handle join form submission (registration) */
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
      sessionToken.value = newToken;
      enterGame();
    } catch (err) {
      joinStatus.value = `Error: ${err}`;
      joinReady.value = true;
      console.error("[Register] Failed:", err);
    }
  };

  // Boot sequence — runs once when App mounts
  useEffect(() => {
    (async () => {
      // Check for existing session token
      const existingToken = getCookie(COOKIE_NAME);
      if (existingToken) {
        const sessionRes = await fetch(`/api/session?token=${encodeURIComponent(existingToken)}`);
        if (sessionRes.ok) {
          sessionToken.value = existingToken;
        } else {
          deleteCookie(COOKIE_NAME);
        }
      }

      // Always start on lore browser
      screen.value = "lore";
    })();
  }, []);

  return (
    <>
      {screen.value === "lore" && (
        <LoreBrowser onJoinLore={handleJoinLore} />
      )}
      {screen.value === "join" && (
        <JoinScreen onJoin={handleJoin} />
      )}
      {screen.value === "game" && sessionToken.value && gameData.value && currentLore.value && (
        <GameScreen
          token={sessionToken.value}
          gameData={gameData.value}
          channel={currentLore.value}
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
