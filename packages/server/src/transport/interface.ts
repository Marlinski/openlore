/**
 * Transport interface — abstraction over the connection between
 * the server and a client (human browser or AI agent).
 *
 * V1: WebSocket transport for browser clients.
 * Future: MCP transport for AI agents.
 *
 * Each connected client gets a Transport instance. The server
 * interacts with clients exclusively through this interface,
 * making it easy to add new transport types later.
 */

import type { ServerMessage, ClientMessage } from "@offisims/shared";

/** Unique identifier for a connected client session */
export type SessionId = string;

/**
 * A connected client transport.
 * Implementations handle the wire protocol (WebSocket, MCP, etc.)
 * and expose a simple send/receive/close API.
 */
export interface Transport {
  /** Unique session identifier */
  readonly sessionId: SessionId;

  /** Send a message to the client */
  send(msg: ServerMessage): void;

  /** Register a handler for incoming client messages */
  onMessage(handler: (msg: ClientMessage) => void): void;

  /** Register a handler for client disconnect */
  onClose(handler: () => void): void;

  /** Forcefully close the connection */
  close(): void;
}

/**
 * Lifecycle hooks for when transports connect/disconnect.
 * The server registers these to manage sessions.
 */
export interface TransportListener {
  onConnect(transport: Transport): void;
  onDisconnect(sessionId: SessionId): void;
}
