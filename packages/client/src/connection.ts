/**
 * WebSocket connection manager.
 *
 * Handles connecting to the game server, sending client messages,
 * and dispatching incoming server messages to registered handlers.
 *
 * Designed for easy extensibility — handlers are registered per
 * message type, so new message types can be added without touching
 * existing code.
 */

import type { ClientMessage, ServerMessage } from "@offisims/shared";

/** Handler for a specific server message type */
type MessageHandler<T extends ServerMessage = ServerMessage> = (msg: T) => void;

export class Connection {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, MessageHandler[]>();
  private connectHandlers: (() => void)[] = [];
  private disconnectHandlers: (() => void)[] = [];
  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to the game server.
   * The URL defaults to the same host (works with Vite proxy).
   */
  connect(url?: string): void {
    const wsUrl =
      url ||
      `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this._connected = true;
      for (const handler of this.connectHandlers) handler();
    };

    this.ws.onclose = () => {
      this._connected = false;
      this.ws = null;
      for (const handler of this.disconnectHandlers) handler();
    };

    this.ws.onerror = (err) => {
      console.error("[Connection] Error:", err);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        this.dispatch(msg);
      } catch (err) {
        console.error("[Connection] Failed to parse message:", err);
      }
    };
  }

  /** Disconnect from the server */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Send a message to the server */
  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Register a handler for a specific message type */
  on<T extends ServerMessage>(
    type: T["type"],
    handler: MessageHandler<T>,
  ): void {
    const list = this.handlers.get(type) || [];
    list.push(handler as MessageHandler);
    this.handlers.set(type, list);
  }

  /** Register a handler for connection established */
  onConnect(handler: () => void): void {
    this.connectHandlers.push(handler);
  }

  /** Register a handler for disconnection */
  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  /** Dispatch a server message to registered handlers */
  private dispatch(msg: ServerMessage): void {
    const handlers = this.handlers.get(msg.type);
    if (handlers) {
      for (const handler of handlers) handler(msg);
    }
  }
}
