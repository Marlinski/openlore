/**
 * LoreBrowser — screen shown after login, before entering a lore.
 *
 * Lists available lores from GET /api/channels, lets the player join one,
 * and provides a minimal create-lore form (name + pack selection).
 */

import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";

// ─── Types ────────────────────────────────────────────────────────

interface LoreMeta {
  channel: string;
  packId: string;
  players: number;
  created: string;
}

interface PackInfo {
  id: string;
  name: string;
}

interface LoreBrowserProps {
  onJoinLore: (channel: string) => void;
}

// ─── Local signals ────────────────────────────────────────────────

const lores = signal<LoreMeta[]>([]);
const packs = signal<PackInfo[]>([]);
const loading = signal(true);
const error = signal<string | null>(null);
const creating = signal(false);

// ─── Component ────────────────────────────────────────────────────

export function LoreBrowser(props: LoreBrowserProps) {
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

      if (!chRes.ok) throw new Error(`Lores: ${chRes.status}`);
      if (!pkRes.ok) throw new Error(`Packs: ${pkRes.status}`);

      lores.value = (await chRes.json()) as LoreMeta[];
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

      const created = (await res.json()) as LoreMeta;
      // Refresh list and auto-join
      await fetchData();
      props.onJoinLore(created.channel);
    } catch (err) {
      error.value = `${err}`;
      creating.value = false;
    }
  };

  return (
    <div class="lore-browser">
      <h1>Lore</h1>

      {error.value && <div class="lore-browser-error">{error.value}</div>}

      {loading.value ? (
        <div class="lore-browser-loading">Loading lores...</div>
      ) : (
        <>
          {/* Lore list */}
          <div class="lore-browser-list">
            {lores.value.length === 0 ? (
              <div class="lore-browser-empty">
                No lores yet. Create one below.
              </div>
            ) : (
              lores.value.map((ch) => (
                <div class="lore-browser-item" key={ch.channel}>
                  <div class="lore-browser-item-info">
                    <span class="lore-browser-item-name">{ch.channel}</span>
                    <span class="lore-browser-item-pack">{ch.packId}</span>
                  </div>
                  <div class="lore-browser-item-meta">
                    <span class="lore-browser-item-players">
                      {ch.players} {ch.players === 1 ? "player" : "players"}
                    </span>
                  </div>
                  <button
                    class="lore-browser-join-btn"
                    onClick={() => props.onJoinLore(ch.channel)}
                  >
                    Join
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Create lore form */}
          {packs.value.length > 0 && (
            <form class="lore-browser-create" onSubmit={handleCreate}>
              <div class="lore-browser-create-title">Create Lore</div>
              <div class="lore-browser-create-row">
                <input
                  ref={nameRef}
                  class="lore-browser-create-input"
                  type="text"
                  placeholder="Lore name (e.g. lobby)"
                  maxLength={30}
                  autocomplete="off"
                />
                <select ref={packRef} class="lore-browser-create-select">
                  {packs.value.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.id}
                    </option>
                  ))}
                </select>
                <button
                  class="lore-browser-create-btn"
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
