/**
 * JoinScreen — registration form shown before joining the game.
 */

import { useRef } from "preact/hooks";
import type { Pack } from "@offisims/pack";
import { joinStatus, joinReady, gameData } from "../../store";

interface JoinScreenProps {
  onJoin: (name: string, characterId: string) => void;
}

/**
 * Derive character list from game data resources.
 * Groups resources tagged "entity:character" by their "name:xxx" tag.
 */
function deriveCharacterList(data: Pack | null): { id: string; name: string }[] {
  if (!data?.resources) return [];
  const groups = new Map<string, boolean>();
  for (const r of data.resources) {
    if (!r.tags.includes("entity:character")) continue;
    const nameTag = r.tags.find((t) => t.startsWith("name:"));
    if (nameTag) {
      const id = nameTag.slice(5); // strip "name:" prefix
      if (!groups.has(id)) groups.set(id, true);
    }
  }
  return Array.from(groups.keys())
    .sort()
    .map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }));
}

export function JoinScreen(props: JoinScreenProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const charRef = useRef<HTMLSelectElement>(null);

  const characters = () => deriveCharacterList(gameData.value);

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    const name = nameRef.current?.value.trim() ?? "";
    const characterId = charRef.current?.value ?? "";
    if (!name || !characterId) return;
    props.onJoin(name, characterId);
  };

  return (
    <div class="join-screen">
      <h1>Offisims</h1>
      <form class="join-form" onSubmit={handleSubmit}>
        <label for="name-input">Your Name</label>
        <input
          ref={nameRef}
          id="name-input"
          type="text"
          placeholder="Enter your name..."
          maxLength={20}
          autocomplete="off"
        />
        <label for="char-select">Character</label>
        <select ref={charRef} id="char-select">
          {characters().length === 0
            ? <option value="">Loading...</option>
            : characters().map((char) => (
                <option key={char.id} value={char.id}>{char.name}</option>
              ))
          }
        </select>
        <button class="join-btn" type="submit" disabled={!joinReady.value}>
          Join
        </button>
      </form>
      <div class="join-status">{joinStatus.value}</div>
    </div>
  );
}
