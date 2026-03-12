/**
 * Keyboard input handler.
 *
 * Tracks which keys are currently pressed and provides a clean API
 * for reading movement direction. WASD and arrow keys are supported.
 *
 * Also handles the chat input toggle (Enter to open, Escape to close).
 */

export type Direction = "up" | "down" | "left" | "right";

export interface MovementVector {
  dx: number;
  dy: number;
}

export class Input {
  private keys = new Set<string>();
  private chatOpenHandlers: (() => void)[] = [];
  private chatCloseHandlers: (() => void)[] = [];
  private doorUseHandlers: (() => void)[] = [];
  private _chatOpen = false;

  get chatOpen(): boolean {
    return this._chatOpen;
  }

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    // Clear keys on blur (tab switch, alt-tab, etc.)
    window.addEventListener("blur", this.onBlur);
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
  }

  /** Get the current movement vector (normalized for diagonals) */
  getMovement(): MovementVector {
    if (this._chatOpen) return { dx: 0, dy: 0 };

    let dx = 0;
    let dy = 0;

    if (this.keys.has("ArrowUp") || this.keys.has("KeyW")) dy -= 1;
    if (this.keys.has("ArrowDown") || this.keys.has("KeyS")) dy += 1;
    if (this.keys.has("ArrowLeft") || this.keys.has("KeyA")) dx -= 1;
    if (this.keys.has("ArrowRight") || this.keys.has("KeyD")) dx += 1;

    // Normalize diagonal
    if (dx !== 0 && dy !== 0) {
      const len = Math.sqrt(dx * dx + dy * dy);
      dx /= len;
      dy /= len;
    }

    return { dx, dy };
  }

  /** Whether any movement key is pressed */
  isMoving(): boolean {
    if (this._chatOpen) return false;
    return (
      this.keys.has("ArrowUp") ||
      this.keys.has("ArrowDown") ||
      this.keys.has("ArrowLeft") ||
      this.keys.has("ArrowRight") ||
      this.keys.has("KeyW") ||
      this.keys.has("KeyA") ||
      this.keys.has("KeyS") ||
      this.keys.has("KeyD")
    );
  }

  /** Register handler for chat open (Enter key) */
  onChatOpen(handler: () => void): void {
    this.chatOpenHandlers.push(handler);
  }

  /** Register handler for chat close (Escape key) */
  onChatClose(handler: () => void): void {
    this.chatCloseHandlers.push(handler);
  }

  /** Register handler for door use (E key) */
  onDoorUse(handler: () => void): void {
    this.doorUseHandlers.push(handler);
  }

  /** Set chat open state (called by HUD when chat is submitted/closed) */
  setChatOpen(open: boolean): void {
    this._chatOpen = open;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Chat toggle
    if (e.code === "Enter" && !this._chatOpen) {
      e.preventDefault();
      this._chatOpen = true;
      for (const h of this.chatOpenHandlers) h();
      return;
    }

    if (e.code === "Escape" && this._chatOpen) {
      e.preventDefault();
      this._chatOpen = false;
      for (const h of this.chatCloseHandlers) h();
      return;
    }

    // Don't capture movement keys when chat is open
    if (this._chatOpen) return;

    // Door use
    if (e.code === "KeyE") {
      e.preventDefault();
      for (const h of this.doorUseHandlers) h();
      return;
    }

    // Prevent arrow keys scrolling the page
    if (
      e.code.startsWith("Arrow") ||
      e.code === "KeyW" ||
      e.code === "KeyA" ||
      e.code === "KeyS" ||
      e.code === "KeyD"
    ) {
      e.preventDefault();
    }

    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
  };
}
