/**
 * GameScreen — the main game view.
 *
 * Mounts the PixiJS canvas, overlay layers, and UI panels.
 * Creates the SceneManager and wires it to the Solid store.
 */

import { onMount, onCleanup, createSignal, Show } from "solid-js";
import { Application } from "pixi.js";
import type { ProjectData } from "@offisims/shared";
import { Connection } from "../../connection";
import { Input } from "../../input";
import { SceneManager } from "../../scene/manager";
import { Hud } from "./Hud";
import { ChannelPanel } from "./ChannelPanel";
import { CharacterCard } from "./CharacterCard";
import { BubbleOverlay, BubbleManager } from "./BubbleOverlay";
import {
  setConnected, setOnZoomChange, setRoomName,
  addChannelMessage, clearChannelMessages,
  openCharacterCard, closeCharacterCard,
  setPmHistory, addPmMessage, clearPmMessages,
  setChannelOpen,
  selectedAvatar,
} from "../../store";

interface GameScreenProps {
  token: string;
  gameData: ProjectData;
  /** Called when the session is invalidated (server rejected token) */
  onSessionInvalid: () => void;
}

export function GameScreen(props: GameScreenProps) {
  let canvasWrapRef!: HTMLDivElement;
  let gameScreenRef!: HTMLDivElement;

  // Signals so Solid re-renders children once these are ready
  const [connection, setConnectionSig] = createSignal<Connection | null>(null);
  const [input, setInputSig] = createSignal<Input | null>(null);
  const [scene, setSceneSig] = createSignal<SceneManager | null>(null);

  let app: Application | null = null;

  onMount(async () => {
    const initW = canvasWrapRef.clientWidth || window.innerWidth;
    const initH = canvasWrapRef.clientHeight || window.innerHeight;

    // Create PixiJS app
    app = new Application();
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
    canvasWrapRef.appendChild(canvas);

    // Create connection + input
    const conn = new Connection();
    const inp = new Input();

    // Create scene manager with store callbacks
    const scn = new SceneManager(app, conn, inp, props.gameData, {
      setRoomName,
      addChannelMessage,
      clearChannelMessages,
      openCharacterCard,
      closeCharacterCard,
      setPmHistory,
      addPmMessage,
      clearPmMessages,
      getSelectedAvatarId: () => selectedAvatar()?.avatarId ?? null,
      setChannelOpen,
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
      const w = canvasWrapRef.clientWidth;
      const h = canvasWrapRef.clientHeight;
      if (w > 0 && h > 0) scn.onResize(w, h);
    };
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(canvasWrapRef);

    // Connection lifecycle
    conn.onConnect(() => {
      conn.send({ type: "join", token: props.token });
      setConnected(true);
    });

    conn.onDisconnect(() => {
      setConnected(false);
    });

    // Welcome — update room name
    conn.on("welcome", (msg: any) => {
      setRoomName(msg.room?.name ?? "");
    });

    // Room change — update room name
    conn.on("room-change", (msg: any) => {
      setRoomName(msg.room.name);
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
    setConnectionSig(conn);
    setInputSig(inp);
    setSceneSig(scn);

    conn.connect();
  });

  onCleanup(() => {
    const conn = connection();
    const inp = input();

    if (conn) {
      conn.disconnect();
    }
    if (inp) {
      inp.destroy();
    }
    if (app) {
      try {
        app.destroy(true, { children: true, texture: true });
      } catch (_) {
        /* ignore cleanup errors */
      }
      app = null;
    }
  });

  const handleBubbleReady = (manager: BubbleManager) => {
    const scn = scene();
    if (scn) scn.setBubbleManager(manager);
  };

  return (
    <div class="game-screen" ref={gameScreenRef}>
      <div class="canvas-wrap" ref={canvasWrapRef} />
      <Show when={scene()}>
        {(scn) => (
          <BubbleOverlay
            camera={scn().getCamera()}
            getAvatars={() => scn().getAvatars()}
            onReady={handleBubbleReady}
          />
        )}
      </Show>
      <Hud />
      <Show when={connection() && input()}>
        <ChannelPanel connection={connection()!} input={input()!} />
        <CharacterCard connection={connection()!} input={input()!} />
      </Show>
    </div>
  );
}
