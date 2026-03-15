/**
 * ChannelBrowser — screen shown after login, before entering a game channel.
 *
 * Lists available channels from GET /api/channels, lets the player join one,
 * and provides a minimal create-channel form (name + pack selection).
 */

import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";

// ─── Types ────────────────────────────────────────────────────────

interface ChannelMeta {
  channel: string;
  packId: string;
  players: number;
  created: string;
}

interface PackInfo {
  id: string;
  name: string;
}

interface ChannelBrowserProps {
  onJoinChannel: (channel: string) => void;
}

// ─── Local signals ────────────────────────────────────────────────

const channels = signal<ChannelMeta[]>([]);
const packs = signal<PackInfo[]>([]);
const loading = signal(true);
const error = signal<string | null>(null);
const creating = signal(false);

// ─── Component ────────────────────────────────────────────────────

export function ChannelBrowser(props: ChannelBrowserProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const packRef = useRef<HTMLSelectElement>(null);

  const fetchData = async () => {
    loading.value = true;
    error.value = null;

    try {
      const [chRes, pkRes] = await Promise.all([
        fetch("/api/channels"),
        fetch("/api/packs"),
      ]);

      if (!chRes.ok) throw new Error(`Channels: ${chRes.status}`);
      if (!pkRes.ok) throw new Error(`Packs: ${pkRes.status}`);

      channels.value = (await chRes.json()) as ChannelMeta[];
      packs.value = (await pkRes.json()) as PackInfo[];
    } catch (err) {
      error.value = `Failed to load: ${err}`;
    } finally {
      loading.value = false;
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    const name = nameRef.current?.value.trim() ?? "";
    const packId = packRef.current?.value ?? "";
    if (!name || !packId) return;

    creating.value = true;
    error.value = null;

    try {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: name, packId }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Create failed" }));
        throw new Error(body.error || `Server returned ${res.status}`);
      }

      const created = (await res.json()) as ChannelMeta;
      // Refresh list and auto-join
      await fetchData();
      props.onJoinChannel(created.channel);
    } catch (err) {
      error.value = `${err}`;
      creating.value = false;
    }
  };

  return (
    <div class="channel-browser">
      <h1>Channels</h1>

      {error.value && <div class="channel-browser-error">{error.value}</div>}

      {loading.value ? (
        <div class="channel-browser-loading">Loading channels...</div>
      ) : (
        <>
          {/* Channel list */}
          <div class="channel-browser-list">
            {channels.value.length === 0 ? (
              <div class="channel-browser-empty">
                No channels yet. Create one below.
              </div>
            ) : (
              channels.value.map((ch) => (
                <div class="channel-browser-item" key={ch.channel}>
                  <div class="channel-browser-item-info">
                    <span class="channel-browser-item-name">{ch.channel}</span>
                    <span class="channel-browser-item-pack">{ch.packId}</span>
                  </div>
                  <div class="channel-browser-item-meta">
                    <span class="channel-browser-item-players">
                      {ch.players} {ch.players === 1 ? "player" : "players"}
                    </span>
                  </div>
                  <button
                    class="channel-browser-join-btn"
                    onClick={() => props.onJoinChannel(ch.channel)}
                  >
                    Join
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Create channel form */}
          {packs.value.length > 0 && (
            <form class="channel-browser-create" onSubmit={handleCreate}>
              <div class="channel-browser-create-title">Create Channel</div>
              <div class="channel-browser-create-row">
                <input
                  ref={nameRef}
                  class="channel-browser-create-input"
                  type="text"
                  placeholder="Channel name (e.g. lobby)"
                  maxLength={30}
                  autocomplete="off"
                />
                <select ref={packRef} class="channel-browser-create-select">
                  {packs.value.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.id}
                    </option>
                  ))}
                </select>
                <button
                  class="channel-browser-create-btn"
                  type="submit"
                  disabled={creating.value}
                >
                  {creating.value ? "Creating..." : "Create"}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
