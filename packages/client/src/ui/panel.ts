/**
 * CharacterCard — right-side slide-out panel for avatar interaction.
 *
 * Opens when clicking on an avatar. Shows:
 *   - Character name
 *   - Character sprite preview (static idle frame)
 *   - Stub info section (future: tools, reports-to, mission, tasks)
 *   - PM chat area: scrollable message history + chat input
 *
 * Later this panel type will also be used for other interactive entities
 * (computers, coffee machines, MCP servers, etc.).
 *
 * Style: modern, slick UI — distinct from the pixelated game bubbles.
 */

import type { Connection } from "../connection.js";
import type { Input } from "../input.js";

// ─── Types ────────────────────────────────────────────────────────

export interface PmMessage {
  name: string;
  text: string;
  timestamp: number;
  isSelf: boolean;
}

// ─── Constants ────────────────────────────────────────────────────

const MAX_PM_MESSAGES = 200;

// ─── CharacterCard ────────────────────────────────────────────────

export class CharacterCard {
  private panel: HTMLDivElement;
  private header: HTMLDivElement;
  private nameEl: HTMLDivElement;
  private closeBtn: HTMLButtonElement;
  private body: HTMLDivElement;
  private infoSection: HTMLDivElement;
  private pmSection: HTMLDivElement;
  private pmMessages: HTMLDivElement;
  private pmEmpty: HTMLDivElement;
  private pmForm: HTMLFormElement;
  private pmInput: HTMLInputElement;

  private connection: Connection;
  private input: Input;

  /** Currently selected avatar ID, or null if closed */
  private _selectedAvatarId: string | null = null;

  get selectedAvatarId(): string | null {
    return this._selectedAvatarId;
  }

  constructor(parent: HTMLDivElement, connection: Connection, input: Input) {
    this.connection = connection;
    this.input = input;

    // Build panel DOM
    this.panel = document.createElement("div");
    this.panel.className = "character-card";

    // Header
    this.header = document.createElement("div");
    this.header.className = "character-card-header";

    this.nameEl = document.createElement("div");
    this.nameEl.className = "character-card-name";

    this.closeBtn = document.createElement("button");
    this.closeBtn.className = "character-card-close";
    this.closeBtn.textContent = "\u00d7"; // ×
    this.closeBtn.addEventListener("click", () => this.close());

    this.header.appendChild(this.nameEl);
    this.header.appendChild(this.closeBtn);

    // Body
    this.body = document.createElement("div");
    this.body.className = "character-card-body";

    // Info section (stub for now)
    this.infoSection = document.createElement("div");
    this.infoSection.className = "character-card-info";

    // PM section
    this.pmSection = document.createElement("div");
    this.pmSection.className = "character-card-pm";

    const pmHeader = document.createElement("div");
    pmHeader.className = "character-card-pm-header";
    pmHeader.textContent = "Private Messages";

    this.pmMessages = document.createElement("div");
    this.pmMessages.className = "character-card-pm-messages";

    this.pmEmpty = document.createElement("div");
    this.pmEmpty.className = "character-card-pm-empty";
    this.pmEmpty.textContent = "No messages yet. Say hello!";

    this.pmForm = document.createElement("form");
    this.pmForm.className = "character-card-pm-form";

    this.pmInput = document.createElement("input");
    this.pmInput.className = "character-card-pm-input";
    this.pmInput.type = "text";
    this.pmInput.placeholder = "Send a private message...";
    this.pmInput.maxLength = 200;
    this.pmForm.appendChild(this.pmInput);

    this.pmSection.appendChild(pmHeader);
    this.pmSection.appendChild(this.pmMessages);
    this.pmSection.appendChild(this.pmEmpty);
    this.pmSection.appendChild(this.pmForm);

    this.body.appendChild(this.infoSection);
    this.body.appendChild(this.pmSection);

    this.panel.appendChild(this.header);
    this.panel.appendChild(this.body);
    parent.appendChild(this.panel);

    // Wire up events
    this.pmForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.sendPm();
    });

    // Prevent keydown from propagating to the game input system
    this.pmInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.code === "Escape") {
        this.pmInput.blur();
        this.input.setChatOpen(false);
      }
    });

    // When the PM input gains focus, inform the input system
    this.pmInput.addEventListener("focus", () => {
      this.input.setChatOpen(true);
    });

    this.pmInput.addEventListener("blur", () => {
      this.input.setChatOpen(false);
    });

    // Close on Escape (only if this panel is open and chat input is not focused)
    window.addEventListener("keydown", (e) => {
      if (e.code === "Escape" && this._selectedAvatarId && !this.input.chatOpen) {
        this.close();
      }
    });
  }

  /** Open the card for a specific avatar */
  open(avatarId: string, name: string, characterId: string): void {
    this._selectedAvatarId = avatarId;
    this.nameEl.textContent = name;
    this.panel.classList.add("open");

    // Build info section
    this.infoSection.innerHTML = "";

    const roleRow = document.createElement("div");
    roleRow.className = "character-card-info-row";
    roleRow.innerHTML = `<span class="character-card-info-label">Character</span><span class="character-card-info-value">${characterId}</span>`;
    this.infoSection.appendChild(roleRow);

    const statusRow = document.createElement("div");
    statusRow.className = "character-card-info-row";
    statusRow.innerHTML = `<span class="character-card-info-label">Status</span><span class="character-card-info-value">Online</span>`;
    this.infoSection.appendChild(statusRow);

    // Future: add tools, reports-to, mission, task history, etc.
  }

  /** Close the card and deselect */
  close(): void {
    this._selectedAvatarId = null;
    this.panel.classList.remove("open");
    this.pmInput.blur();
    this.input.setChatOpen(false);
  }

  /** Check if card is open */
  isOpen(): boolean {
    return this._selectedAvatarId !== null;
  }

  /** Close panel on room change */
  clearPanel(): void {
    this.close();
  }

  /** Add a PM message to the display */
  addPmMessage(name: string, text: string, isSelf: boolean): void {
    // Hide empty state
    this.pmEmpty.style.display = "none";

    const msgEl = document.createElement("div");
    msgEl.className = `character-card-pm-msg${isSelf ? " self" : ""}`;

    const topRow = document.createElement("div");
    topRow.className = "character-card-pm-msg-top";

    const nameSpan = document.createElement("span");
    nameSpan.className = "character-card-pm-msg-name";
    nameSpan.textContent = name;

    const timeSpan = document.createElement("span");
    timeSpan.className = "character-card-pm-msg-time";
    timeSpan.textContent = this.formatTime(Date.now());

    topRow.appendChild(nameSpan);
    topRow.appendChild(timeSpan);

    const textEl = document.createElement("div");
    textEl.className = "character-card-pm-msg-text";
    textEl.textContent = text;

    msgEl.appendChild(topRow);
    msgEl.appendChild(textEl);
    this.pmMessages.appendChild(msgEl);

    // Trim DOM
    while (this.pmMessages.children.length > MAX_PM_MESSAGES) {
      this.pmMessages.removeChild(this.pmMessages.firstChild!);
    }

    this.scrollToBottom();
  }

  /** Clear all PM messages from the display and show empty state */
  clearPmMessages(): void {
    this.pmMessages.innerHTML = "";
    this.pmEmpty.style.display = "";
  }

  /** Load PM history when switching to a different avatar's card */
  loadHistory(messages: PmMessage[]): void {
    this.pmMessages.innerHTML = "";
    if (messages.length === 0) {
      this.pmEmpty.style.display = "";
    } else {
      this.pmEmpty.style.display = "none";
      for (const msg of messages) {
        this.appendMessageEl(msg);
      }
      this.scrollToBottom();
    }
  }

  // ─── Private ─────────────────────────────────────────────────

  private sendPm(): void {
    const text = this.pmInput.value.trim();
    if (text && this._selectedAvatarId) {
      this.connection.send({
        type: "private-message",
        targetAvatarId: this._selectedAvatarId,
        text,
      });
    }
    this.pmInput.value = "";
    // Keep focus in the input for quick follow-up messages
  }

  private appendMessageEl(entry: PmMessage): void {
    const msgEl = document.createElement("div");
    msgEl.className = `character-card-pm-msg${entry.isSelf ? " self" : ""}`;

    const topRow = document.createElement("div");
    topRow.className = "character-card-pm-msg-top";

    const nameSpan = document.createElement("span");
    nameSpan.className = "character-card-pm-msg-name";
    nameSpan.textContent = entry.name;

    const timeSpan = document.createElement("span");
    timeSpan.className = "character-card-pm-msg-time";
    timeSpan.textContent = this.formatTime(entry.timestamp);

    topRow.appendChild(nameSpan);
    topRow.appendChild(timeSpan);

    const textEl = document.createElement("div");
    textEl.className = "character-card-pm-msg-text";
    textEl.textContent = entry.text;

    msgEl.appendChild(topRow);
    msgEl.appendChild(textEl);
    this.pmMessages.appendChild(msgEl);
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.pmMessages.scrollTop = this.pmMessages.scrollHeight;
    });
  }

  private formatTime(ts: number): string {
    const d = new Date(ts);
    const h = d.getHours().toString().padStart(2, "0");
    const m = d.getMinutes().toString().padStart(2, "0");
    return `${h}:${m}`;
  }
}
