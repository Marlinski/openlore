/**
 * HUD — on-screen UI overlay for chat input and chat log.
 *
 * The HUD is pure HTML, positioned absolutely over the game canvas.
 * It handles:
 *   - Chat input (Enter to open, Enter to send, Escape to close)
 *   - Chat log (scrollable list of recent messages)
 *   - Connection status indicator
 *   - Room name display
 */

import type { Connection } from "../connection.js";
import type { Input } from "../input.js";

// ─── Constants ────────────────────────────────────────────────────

const MAX_CHAT_MESSAGES = 50;

// ─── Hud ──────────────────────────────────────────────────────────

export class Hud {
  private container: HTMLDivElement;
  private connection: Connection;
  private input: Input;

  private chatLog: HTMLDivElement;
  private chatInput: HTMLInputElement;
  private chatForm: HTMLFormElement;
  private statusEl: HTMLDivElement;
  private roomNameEl: HTMLDivElement;

  constructor(
    container: HTMLDivElement,
    connection: Connection,
    input: Input,
  ) {
    this.container = container;
    this.connection = connection;
    this.input = input;

    // Build HUD elements
    this.statusEl = this.createElement("div", "hud-status");
    this.roomNameEl = this.createElement("div", "hud-room-name");
    this.chatLog = this.createElement("div", "hud-chat-log");
    this.chatForm = document.createElement("form");
    this.chatForm.className = "hud-chat-form";
    this.chatInput = document.createElement("input");
    this.chatInput.className = "hud-chat-input";
    this.chatInput.type = "text";
    this.chatInput.placeholder = "Press Enter to chat...";
    this.chatInput.maxLength = 200;
    this.chatForm.appendChild(this.chatInput);

    container.appendChild(this.statusEl);
    container.appendChild(this.roomNameEl);
    container.appendChild(this.chatLog);
    container.appendChild(this.chatForm);

    // Initially hidden
    this.chatForm.style.display = "none";

    // Wire up input events
    this.input.onChatOpen(() => this.openChat());
    this.input.onChatClose(() => this.closeChat());

    this.chatForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.sendChat();
    });

    // Click on chat input shouldn't propagate to game
    this.chatInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.code === "Escape") {
        this.closeChat();
        this.input.setChatOpen(false);
      }
    });

    this.updateStatus();
  }

  /** Add a chat message to the log */
  addChatMessage(name: string, text: string): void {
    const msgEl = document.createElement("div");
    msgEl.className = "hud-chat-message";

    const nameSpan = document.createElement("span");
    nameSpan.className = "hud-chat-name";
    nameSpan.textContent = name;

    const textSpan = document.createElement("span");
    textSpan.className = "hud-chat-text";
    textSpan.textContent = `: ${text}`;

    msgEl.appendChild(nameSpan);
    msgEl.appendChild(textSpan);
    this.chatLog.appendChild(msgEl);

    // Trim old messages
    while (this.chatLog.children.length > MAX_CHAT_MESSAGES) {
      this.chatLog.removeChild(this.chatLog.firstChild!);
    }

    // Auto-scroll
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  /** Update the room name display */
  setRoomName(name: string): void {
    this.roomNameEl.textContent = name;
  }

  /** Update connection status */
  updateStatus(): void {
    if (this.connection.connected) {
      this.statusEl.textContent = "Connected";
      this.statusEl.classList.remove("disconnected");
      this.statusEl.classList.add("connected");
    } else {
      this.statusEl.textContent = "Disconnected";
      this.statusEl.classList.remove("connected");
      this.statusEl.classList.add("disconnected");
    }
  }

  // ─── Private ─────────────────────────────────────────────────

  private openChat(): void {
    this.chatForm.style.display = "";
    this.chatInput.focus();
  }

  private closeChat(): void {
    this.chatForm.style.display = "none";
    this.chatInput.value = "";
    this.chatInput.blur();
  }

  private sendChat(): void {
    const text = this.chatInput.value.trim();
    if (text) {
      this.connection.send({ type: "chat", text });
    }
    this.closeChat();
    this.input.setChatOpen(false);
  }

  private createElement(tag: string, className: string): HTMLDivElement {
    const el = document.createElement(tag) as HTMLDivElement;
    el.className = className;
    return el;
  }
}
