/**
 * Hud — on-screen overlay with zoom controls (top) and status bar (bottom).
 *
 * The status bar shows:
 *   - Two indicator lights: Game WS (connected signal) and IRC WS (ircConnected signal)
 *   - Current channel name and room name
 */

import { connected, ircConnected, zoomLevel, stepZoom, roomName, currentLore } from "../../store";

export function Hud() {
  return (
    <div class="hud-container">
      {/* ── Zoom controls (top center) ── */}
      <div class="hud-zoom">
        <button
          class="hud-zoom-btn"
          title="Zoom out"
          onClick={() => stepZoom(-1)}
        >
          {"\u2212"}
        </button>
        <span class="hud-zoom-label">{zoomLevel()}x</span>
        <button
          class="hud-zoom-btn"
          title="Zoom in"
          onClick={() => stepZoom(1)}
        >
          +
        </button>
      </div>

      {/* ── Status bar (bottom) ── */}
      <div class="status-bar">
        <div class="status-bar-lights">
          <div class="status-bar-light" title="Game WebSocket">
            <span
              class={`status-bar-dot ${connected.value ? "on" : "off"}`}
            />
            <span class="status-bar-light-label">Game</span>
          </div>
          <div class="status-bar-light" title={`IRC WebSocket (${ircConnected.value ? "connected" : "not connected"})`}>
            <span
              class={`status-bar-dot ${ircConnected.value ? "on" : "off"}`}
            />
            <span class="status-bar-light-label">IRC</span>
          </div>
        </div>
        <div class="status-bar-info">
          {currentLore.value && (
            <span class="status-bar-lore">{currentLore.value}</span>
          )}
          {roomName.value && (
            <span class="status-bar-room">{roomName.value}</span>
          )}
        </div>
      </div>
    </div>
  );
}
