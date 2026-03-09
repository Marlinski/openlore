/**
 * CharacterCard — right-side slide-out panel for avatar interaction.
 *
 * Opens when clicking on an avatar. Shows:
 *   - Character name
 *   - Character sprite preview (static idle frame)
 *   - Stub info section (future: tools, reports-to, mission, tasks)
 *   - PM chat area (future: private messages with this character)
 *
 * Later this panel type will also be used for other interactive entities
 * (computers, coffee machines, MCP servers, etc.).
 *
 * Style: modern, slick UI — distinct from the pixelated game bubbles.
 */

// ─── CharacterCard ────────────────────────────────────────────────

export class CharacterCard {
  private panel: HTMLDivElement;
  private header: HTMLDivElement;
  private nameEl: HTMLDivElement;
  private closeBtn: HTMLButtonElement;
  private body: HTMLDivElement;
  private infoSection: HTMLDivElement;
  private pmSection: HTMLDivElement;
  private pmEmpty: HTMLDivElement;

  /** Currently selected avatar ID, or null if closed */
  private _selectedAvatarId: string | null = null;

  get selectedAvatarId(): string | null {
    return this._selectedAvatarId;
  }

  constructor(parent: HTMLDivElement) {
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

    // PM section (stub for now)
    this.pmSection = document.createElement("div");
    this.pmSection.className = "character-card-pm";

    const pmHeader = document.createElement("div");
    pmHeader.className = "character-card-pm-header";
    pmHeader.textContent = "Private Messages";

    this.pmEmpty = document.createElement("div");
    this.pmEmpty.className = "character-card-pm-empty";
    this.pmEmpty.textContent = "PM coming soon...";

    this.pmSection.appendChild(pmHeader);
    this.pmSection.appendChild(this.pmEmpty);

    this.body.appendChild(this.infoSection);
    this.body.appendChild(this.pmSection);

    this.panel.appendChild(this.header);
    this.panel.appendChild(this.body);
    parent.appendChild(this.panel);

    // Close on Escape (only if this panel is open and chat is not open)
    window.addEventListener("keydown", (e) => {
      if (e.code === "Escape" && this._selectedAvatarId) {
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
  }

  /** Check if card is open */
  isOpen(): boolean {
    return this._selectedAvatarId !== null;
  }

  /** Close panel on room change */
  clearPanel(): void {
    this.close();
  }
}
