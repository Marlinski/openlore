/**
 * GameScreen — the main game view.
 *
 * Mounts the PixiJS canvas, overlay layers, and UI panels.
 * Creates the SceneManager and wires it to the Preact store.
 *
 * Maintains two connections:
 *   1. Game WS (Connection) — visual state (avatars, rooms, positions)
 *   2. IRC WS (AircClient)  — chat, PMs, presence
 */

import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { Application } from "pixi.js";
import type { Pack } from "@offisims/pack";
import { AircClient } from "@airc/client";
import type { IrcEvent } from "@airc/client";
import { Connection } from "../../connection";
import { Input } from "../../input";
import { SceneManager } from "../../scene/manager";
import { Hud } from "./Hud";
import { ChannelPanel } from "./ChannelPanel";
import { CharacterCard } from "./CharacterCard";
import { BubbleOverlay, BubbleManager } from "./BubbleOverlay";
import {
  connected, ircConnected, setOnZoomChange, roomName,
  addChannelMessage, clearChannelMessages,
  openCharacterCard, closeCharacterCard,
  setPmHistory, addPmMessage, clearPmMessages,
  channelOpen, selectedAvatar, ircRoom,
} from "../../store";

interface GameScreenProps {
  token: string;
  gameData: Pack;
  /** IRC-style channel name, e.g. "#lobby" */
  channel: string;
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
  const ircSig = signal<AircClient | null>(null);

  const appRef = useRef<Application | null>(null);

  useEffect(() => {
    let destroyed = false;
    let ircClient: AircClient | null = null;

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

      // IRC room transition callback — wired after IRC client is created
      let currentIrcRoom = "";

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
        onRoomTransition: (oldRoom: string, newRoom: string) => {
          if (!ircClient) return;
          const oldIrcCh = `${props.channel}-${oldRoom}`;
          const newIrcCh = `${props.channel}-${newRoom}`;
          ircClient.part(oldIrcCh);
          ircClient.join(newIrcCh);
          currentIrcRoom = newIrcCh;
          ircRoom.value = newIrcCh;
        },
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

      // Welcome — start IRC connection once we know the player name + room
      conn.on("welcome", (msg: any) => {
        roomName.value = msg.room?.name ?? "";

        // Find the local player's name from the avatar list
        const localAvatar = msg.avatars?.find((a: any) => a.id === msg.avatarId);
        const playerName = localAvatar?.name ?? "player";
        const initialRoom = msg.room?.name ?? "";

        // Build IRC room channel: "{channel}-{roomName}"
        // e.g. "#lobby-reception", "#lobby-coffeeroom"
        currentIrcRoom = `${props.channel}-${initialRoom}`;
        ircRoom.value = currentIrcRoom;

        // Create IRC client
        ircClient = new AircClient({
          nick: playerName,
          autoJoin: [currentIrcRoom],
        });

        // Wire IRC events
        const ircListener = (event: IrcEvent) => {
          switch (event.type) {
            case "registered":
              ircConnected.value = true;
              break;

            case "message": {
              const { message: ircMsg } = event;
              const isChannel = ircMsg.target.startsWith("#");
              const isSelf = ircMsg.from === ircClient!.nick();

              if (isChannel) {
                // Channel message → chat panel + speech bubble
                addChannelMessage(ircMsg.from, ircMsg.text, isSelf);
                if (!isSelf) {
                  const avatar = scn.findAvatarByName(ircMsg.from);
                  if (avatar && scn.getBubbleManager()) {
                    scn.getBubbleManager()!.show(avatar.id, avatar.name, ircMsg.text);
                  }
                }
              } else {
                // Private message → PM panel + bubble
                const senderAvatar = scn.findAvatarByName(ircMsg.from);
                if (isSelf) {
                  // Echo of our own PM — add to PM history
                  addPmMessage(ircMsg.from, ircMsg.text, true);
                } else {
                  // Incoming PM from someone else
                  addPmMessage(ircMsg.from, ircMsg.text, false);
                  if (senderAvatar && scn.getBubbleManager()) {
                    scn.getBubbleManager()!.showPm(senderAvatar.id, senderAvatar.name, ircMsg.text);
                  }
                }
              }
              break;
            }

            case "disconnected":
              ircConnected.value = false;
              break;

            case "reconnected":
              ircConnected.value = true;
              break;
          }
        };

        ircClient.on(ircListener);
        ircClient.connect().catch((err) => {
          console.error("[IRC] Connection failed:", err);
        });

        ircSig.value = ircClient;
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

      conn.connect(props.channel);
    })();

    return () => {
      destroyed = true;
      const conn = connectionSig.value;
      const inp = inputSig.value;

      // Disconnect IRC
      if (ircClient) {
        ircConnected.value = false;
        ircClient.quit("leaving");
        ircClient = null;
        ircSig.value = null;
      }

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
          <ChannelPanel
            connection={connectionSig.value}
            input={inputSig.value}
            irc={ircSig.value}
          />
          <CharacterCard
            connection={connectionSig.value}
            input={inputSig.value}
            irc={ircSig.value}
          />
        </>
      )}
    </div>
  );
}
