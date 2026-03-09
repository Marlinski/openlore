/**
 * WebSocket server — handles browser client connections.
 *
 * Each WebSocket connection maps to a Transport instance.
 * Incoming messages are parsed and forwarded to the World.
 * Outgoing ServerMessages are serialized and sent over the wire.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import type { ClientMessage, ServerMessage } from "@offisims/shared";
import { isClientMessage } from "@offisims/shared";
import type { Transport, SessionId } from "./transport/interface.js";
import type { World } from "./game/world.js";

let nextSessionId = 1;

function generateSessionId(): SessionId {
  return `session-${nextSessionId++}`;
}

/**
 * WebSocket transport implementation.
 * Wraps a single WebSocket connection.
 */
class WsTransport implements Transport {
  readonly sessionId: SessionId;
  private ws: WebSocket;
  private messageHandler: ((msg: ClientMessage) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  constructor(ws: WebSocket) {
    this.sessionId = generateSessionId();
    this.ws = ws;

    ws.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (isClientMessage(parsed) && this.messageHandler) {
          this.messageHandler(parsed);
        }
      } catch (err) {
        console.error(
          `[WS] Invalid message from ${this.sessionId}:`,
          err,
        );
      }
    });

    ws.on("close", () => {
      if (this.closeHandler) this.closeHandler();
    });

    ws.on("error", (err) => {
      console.error(`[WS] Error on ${this.sessionId}:`, err.message);
    });
  }

  send(msg: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(handler: (msg: ClientMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * Set up the WebSocket server on top of an existing HTTP server.
 * Returns a send function that the World can use to push messages.
 */
export function setupWebSocket(
  httpServer: HttpServer,
  world: World,
): {
  /** Send a message to a specific session */
  send: (sessionId: SessionId, msg: ServerMessage) => void;
} {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  /** Active transports indexed by session ID */
  const transports = new Map<SessionId, WsTransport>();

  wss.on("connection", (ws) => {
    const transport = new WsTransport(ws);
    transports.set(transport.sessionId, transport);

    console.log(`[WS] Client connected: ${transport.sessionId}`);

    // Route incoming messages to the World
    transport.onMessage((msg) => {
      switch (msg.type) {
        case "join":
          world.handleJoin(
            transport.sessionId,
            msg.name,
            msg.characterId,
            msg.room,
          );
          break;
        case "position":
          world.handlePosition(
            transport.sessionId,
            msg.x,
            msg.y,
            msg.direction,
            msg.moving,
          );
          break;
        case "use-door":
          world.handleUseDoor(transport.sessionId, msg.doorId);
          break;
        case "chat":
          world.handleChat(transport.sessionId, msg.text);
          break;
        case "leave":
          world.handleLeave(transport.sessionId);
          break;
      }
    });

    // Handle disconnect
    transport.onClose(() => {
      console.log(`[WS] Client disconnected: ${transport.sessionId}`);
      world.handleLeave(transport.sessionId);
      transports.delete(transport.sessionId);
    });
  });

  console.log(`[WS] WebSocket server listening on /ws`);

  return {
    send(sessionId: SessionId, msg: ServerMessage) {
      const transport = transports.get(sessionId);
      if (transport) transport.send(msg);
    },
  };
}
