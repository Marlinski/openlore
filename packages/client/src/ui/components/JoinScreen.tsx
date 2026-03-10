/**
 * JoinScreen — registration form shown before joining the game.
 */

import { For } from "solid-js";
import { joinStatus, joinReady, gameData } from "../../store";

interface JoinScreenProps {
  onJoin: (name: string, characterId: string) => void;
}

export function JoinScreen(props: JoinScreenProps) {
  let nameRef!: HTMLInputElement;
  let charRef!: HTMLSelectElement;

  const characters = () => gameData()?.characters ?? [];

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    const name = nameRef.value.trim();
    const characterId = charRef.value;
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
          <For each={characters()} fallback={<option value="">Loading...</option>}>
            {(char) => <option value={char.id}>{char.name}</option>}
          </For>
        </select>
        <button class="join-btn" type="submit" disabled={!joinReady()}>
          Join
        </button>
      </form>
      <div class="join-status">{joinStatus()}</div>
    </div>
  );
}
