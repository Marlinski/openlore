/**
 * Hud — on-screen overlay with connection status and zoom controls.
 */

import { connected, zoomLevel, stepZoom } from "../../store";

export function Hud() {
  return (
    <div class="hud-container">
      <div
        class={`hud-status ${connected.value ? "connected" : "disconnected"}`}
      >
        {connected.value ? "Connected" : "Disconnected"}
      </div>
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
    </div>
  );
}
