/**
 * ChannelPanel — left-side panel for room channel chat.
 *
 * Shows:
 *   - Room name as header (clickable to toggle panel open/closed)
 *   - Scrollable channel message history with names + timestamps
 *   - Chat input at the bottom (Enter to send)
 *
 * This is the room's shared channel — all messages sent here are
 * visible to everyone in the room.
 *
 * The panel can be toggled open/closed via Tab key or clicking
 * the room name tab.
 *
 * Style: modern, slick UI matching the dark glass theme.
 */

import type { Connection } from "../connection.js";
import type { Input } from "../input.js";

// ─── Types ────────────────────────────────────────────────────────

export interface ChannelMessage {
  name: string;
  text: string;
  timestamp: number;
  isSelf: boolean;
}

// ─── Constants ────────────────────────────────────────────────────

const MAX_MESSAGES = 200;

// ─── ChannelPanel ─────────────────────────────────────────────────

export class ChannelPanel {
  private panel: HTMLDivElement;
  private tab: HTMLDivElement;
  private tabName: HTMLSpanElement;
  private content: HTMLDivElement;
  private messagesWrap: HTMLDivElement;
  private chatForm: HTMLFormElement;
  private chatInput: HTMLInputElement;

  private connection: Connection;
  private input: Input;

  private _open = false;
  private messages: ChannelMessage[] = [];

  get isOpen(): boolean {
    return this._open;
  }

  constructor(parent: HTMLDivElement, connection: Connection, input: Input) {
    this.connection = connection;
    this.input = input;

    // Build panel DOM
    this.panel = document.createElement("div");
    this.panel.className = "channel-panel";

    // Tab (always visible — room name + toggle)
    this.tab = document.createElement("div");
    this.tab.className = "channel-panel-tab";
    this.tab.addEventListener("click", () => this.toggle());

    this.tabName = document.createElement("span");
    this.tabName.className = "channel-panel-tab-name";
    this.tabName.textContent = "Room";

    const tabIcon = document.createElement("span");
    tabIcon.className = "channel-panel-tab-icon";
    tabIcon.textContent = "\u25B8"; // ▸

    this.tab.appendChild(tabIcon);
    this.tab.appendChild(this.tabName);

    // Content area (slides in)
    this.content = document.createElement("div");
    this.content.className = "channel-panel-content";

    // Messages
    this.messagesWrap = document.createElement("div");
    this.messagesWrap.className = "channel-panel-messages";

    // Chat form
    this.chatForm = document.createElement("form");
    this.chatForm.className = "channel-panel-form";

    this.chatInput = document.createElement("input");
    this.chatInput.className = "channel-panel-input";
    this.chatInput.type = "text";
    this.chatInput.placeholder = "Type a message...";
    this.chatInput.maxLength = 200;
    this.chatForm.appendChild(this.chatInput);

    this.content.appendChild(this.messagesWrap);
    this.content.appendChild(this.chatForm);

    this.panel.appendChild(this.tab);
    this.panel.appendChild(this.content);
    parent.appendChild(this.panel);

    // Wire up events
    this.chatForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.sendChat();
    });

    // Prevent keydown from propagating to the game input system
    this.chatInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.code === "Escape") {
        this.chatInput.blur();
        this.input.setChatOpen(false);
      }
    });

    // When the chat input gains focus, inform the input system
    this.chatInput.addEventListener("focus", () => {
      this.input.setChatOpen(true);
    });

    this.chatInput.addEventListener("blur", () => {
      this.input.setChatOpen(false);
    });

    // Tab key toggles the panel
    window.addEventListener("keydown", (e) => {
      if (e.code === "Tab" && !this.input.chatOpen) {
        e.preventDefault();
        this.toggle();
      }
    });

    // Enter key opens panel and focuses chat input (when not already chatting)
    this.input.onChatOpen(() => {
      if (!this._open) this.openPanel();
      this.chatInput.focus();
    });

    this.input.onChatClose(() => {
      this.chatInput.blur();
    });
  }

  /** Set the room name displayed in the tab */
  setRoomName(name: string): void {
    this.tabName.textContent = name;
  }

  /** Add a channel message */
  addMessage(name: string, text: string, isSelf: boolean): void {
    const entry: ChannelMessage = {
      name,
      text,
      timestamp: Date.now(),
      isSelf,
    };

    this.messages.push(entry);
    while (this.messages.length > MAX_MESSAGES) {
      this.messages.shift();
    }

    this.appendMessageEl(entry);
    this.scrollToBottom();
  }

  /** Toggle panel open/closed */
  toggle(): void {
    if (this._open) {
      this.closePanel();
    } else {
      this.openPanel();
    }
  }

  /** Open the panel */
  openPanel(): void {
    this._open = true;
    this.panel.classList.add("open");
    this.scrollToBottom();
  }

  /** Close the panel */
  closePanel(): void {
    this._open = false;
    this.panel.classList.remove("open");
    this.chatInput.blur();
  }

  /** Clear messages on room change */
  clearMessages(): void {
    this.messages = [];
    this.messagesWrap.innerHTML = "";
  }

  // ─── Private ─────────────────────────────────────────────────

  private sendChat(): void {
    const text = this.chatInput.value.trim();
    if (text) {
      this.connection.send({ type: "chat", text });
    }
    this.chatInput.value = "";
    this.chatInput.blur();
    this.input.setChatOpen(false);
  }

  private appendMessageEl(entry: ChannelMessage): void {
    const msgEl = document.createElement("div");
    msgEl.className = `channel-panel-msg${entry.isSelf ? " self" : ""}`;

    const topRow = document.createElement("div");
    topRow.className = "channel-panel-msg-top";

    const nameSpan = document.createElement("span");
    nameSpan.className = "channel-panel-msg-name";
    nameSpan.textContent = entry.name;

    const timeSpan = document.createElement("span");
    timeSpan.className = "channel-panel-msg-time";
    timeSpan.textContent = this.formatTime(entry.timestamp);

    topRow.appendChild(nameSpan);
    topRow.appendChild(timeSpan);

    const textEl = document.createElement("div");
    textEl.className = "channel-panel-msg-text";
    textEl.textContent = entry.text;

    msgEl.appendChild(topRow);
    msgEl.appendChild(textEl);
    this.messagesWrap.appendChild(msgEl);

    // Trim DOM
    while (this.messagesWrap.children.length > MAX_MESSAGES) {
      this.messagesWrap.removeChild(this.messagesWrap.firstChild!);
    }
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.messagesWrap.scrollTop = this.messagesWrap.scrollHeight;
    });
  }

  private formatTime(ts: number): string {
    const d = new Date(ts);
    const h = d.getHours().toString().padStart(2, "0");
    const m = d.getMinutes().toString().padStart(2, "0");
    return `${h}:${m}`;
  }
}
