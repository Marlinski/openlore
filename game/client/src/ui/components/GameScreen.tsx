/**
 * GameScreen — the main game view.
 *
 * Mounts the PixiJS canvas, overlay layers, and UI panels.
 * Creates the SceneManager and wires it to the Preact store.
 */

import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { Application } from "pixi.js";
import type { Pack } from "@offisims/pack";
import { Connection } from "../../connection";
import { Input } from "../../input";
import { SceneManager } from "../../scene/manager";
import { Hud } from "./Hud";
import { ChannelPanel } from "./ChannelPanel";
import { CharacterCard } from "./CharacterCard";
import { BubbleOverlay, BubbleManager } from "./BubbleOverlay";
import {
  connected, setOnZoomChange, roomName,
  addChannelMessage, clearChannelMessages,
  openCharacterCard, closeCharacterCard,
  setPmHistory, addPmMessage, clearPmMessages,
  channelOpen, selectedAvatar,
} from "../../store";

interface GameScreenProps {
  token: string;
  gameData: Pack;
  /** Called when the session is invalidated (server rejected token) */
  onSessionInvalid: () => void;
}

export function GameScreen(props: GameScreenProps) {
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const gameScreenRef = useRef<HTMLDivElement>(null);

  // Signals so Preact re-renders children once these are ready
  const connectionSig = signal<Connection | null>(null);
  const inputSig = signal<Input | null>(null);
  const sceneSig = signal<SceneManager | null>(null);

  const appRef = useRef<Application | null>(null);

  useEffect(() => {
    let destroyed = false;

    (async () => {
      const wrap = canvasWrapRef.current;
      if (!wrap) return;

      const initW = wrap.clientWidth || window.innerWidth;
      const initH = wrap.clientHeight || window.innerHeight;

      // Create PixiJS app
      const app = new Application();
      await app.init({
        width: initW,
        height: initH,
        backgroundColor: 0x1a1a2e,
        antialias: false,
        roundPixels: true,
      });

      if (destroyed) {
        app.destroy(true, { children: true, texture: true });
        return;
      }

      appRef.current = app;

      const canvas = app.canvas as HTMLCanvasElement;
      canvas.style.imageRendering = "pixelated";
      canvas.style.display = "block";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      wrap.appendChild(canvas);

      // Create connection + input
      const conn = new Connection();
      const inp = new Input();

      // Create scene manager with store callbacks
      const scn = new SceneManager(app, conn, inp, props.gameData, {
        setRoomName: (name: string) => { roomName.value = name; },
        addChannelMessage,
        clearChannelMessages,
        openCharacterCard,
        closeCharacterCard,
        setPmHistory,
        addPmMessage,
        clearPmMessages,
        getSelectedAvatarId: () => selectedAvatar.value?.avatarId ?? null,
        setChannelOpen: (open: boolean) => { channelOpen.value = open; },
      });

      // Wire zoom
      setOnZoomChange((zoom) => scn.setZoom(zoom));

      // Canvas click for avatar selection
      canvas.addEventListener("click", (e) => {
        if (inp.chatOpen) return;
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        scn.handleCanvasClick(screenX, screenY);
      });

      // Handle resize
      const onResize = () => {
        const w = wrap.clientWidth;
        const h = wrap.clientHeight;
        if (w > 0 && h > 0) scn.onResize(w, h);
      };
      const resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(wrap);

      // Connection lifecycle
      conn.onConnect(() => {
        conn.send({ type: "join", token: props.token });
        connected.value = true;
      });

      conn.onDisconnect(() => {
        connected.value = false;
      });

      // Welcome — update room name
      conn.on("welcome", (msg: any) => {
        roomName.value = msg.room?.name ?? "";
      });

      // Room change — update room name
      conn.on("room-change", (msg: any) => {
        roomName.value = msg.room.name;
      });

      // Error handling
      conn.on("error", (msg: any) => {
        if (msg.message === "Invalid or expired session.") {
          props.onSessionInvalid();
          return;
        }
        console.error("[Server Error]", msg.message);
      });

      // Publish signals — this triggers child component rendering
      connectionSig.value = conn;
      inputSig.value = inp;
      sceneSig.value = scn;

      conn.connect();
    })();

    return () => {
      destroyed = true;
      const conn = connectionSig.value;
      const inp = inputSig.value;

      if (conn) conn.disconnect();
      if (inp) inp.destroy();
      if (appRef.current) {
        try {
          appRef.current.destroy(true, { children: true, texture: true });
        } catch (_) {
          /* ignore cleanup errors */
        }
        appRef.current = null;
      }
    };
  }, []);

  const handleBubbleReady = (manager: BubbleManager) => {
    const scn = sceneSig.value;
    if (scn) scn.setBubbleManager(manager);
  };

  return (
    <div class="game-screen" ref={gameScreenRef}>
      <div class="canvas-wrap" ref={canvasWrapRef} />
      {sceneSig.value && (
        <BubbleOverlay
          camera={sceneSig.value.getCamera()}
          getAvatars={() => sceneSig.value!.getAvatars()}
          onReady={handleBubbleReady}
        />
      )}
      <Hud />
      {connectionSig.value && inputSig.value && (
        <>
          <ChannelPanel connection={connectionSig.value} input={inputSig.value} />
          <CharacterCard connection={connectionSig.value} input={inputSig.value} />
        </>
      )}
    </div>
  );
}
