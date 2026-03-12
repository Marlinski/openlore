/**
 * WebSocket connection manager.
 *
 * Handles connecting to the game server, sending client messages,
 * and dispatching incoming server messages to registered handlers.
 *
 * Supports automatic reconnection with exponential backoff.
 * On reconnect, fires the connect handler so the caller can re-send
 * the join message (with a token for session reattachment).
 */

import type { ClientMessage, ServerMessage } from "./protocol.js";

/** Handler for a specific server message type */
type MessageHandler<T extends ServerMessage = ServerMessage> = (msg: T) => void;

/** Reconnection config */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const RECONNECT_MULTIPLIER = 2;

export class Connection {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, MessageHandler[]>();
  private connectHandlers: (() => void)[] = [];
  private disconnectHandlers: (() => void)[] = [];
  private _connected = false;
  private _url: string | null = null;

  /** Whether auto-reconnect is enabled */
  private autoReconnect = true;
  /** Current backoff delay */
  private reconnectDelay = RECONNECT_BASE_MS;
  /** Pending reconnect timer */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether we were previously connected (to distinguish first connect from reconnect) */
  private wasConnected = false;

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to the game server.
   * The URL defaults to the same host (works with Vite proxy).
   */
  connect(url?: string): void {
    this._url =
      url ||
      `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;

    this.autoReconnect = true;
    this.doConnect();
  }

  private doConnect(): void {
    if (!this._url) return;

    // Clear any pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.ws = new WebSocket(this._url);

    this.ws.onopen = () => {
      this._connected = true;
      this.reconnectDelay = RECONNECT_BASE_MS; // reset backoff on success
      this.wasConnected = true;
      for (const handler of this.connectHandlers) handler();
    };

    this.ws.onclose = () => {
      this._connected = false;
      this.ws = null;
      for (const handler of this.disconnectHandlers) handler();
      this.scheduleReconnect();
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

  /** Schedule a reconnection attempt with exponential backoff */
  private scheduleReconnect(): void {
    if (!this.autoReconnect || !this.wasConnected) return;

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_MULTIPLIER,
      RECONNECT_MAX_MS,
    );

    console.log(`[Connection] Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  /** Disconnect from the server (disables auto-reconnect) */
  disconnect(): void {
    this.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
