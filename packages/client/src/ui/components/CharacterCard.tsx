/**
 * CharacterCard — right-side slide-out panel for avatar interaction + PM chat.
 */

import { Show, For, createEffect, onMount, onCleanup } from "solid-js";
import type { Input } from "../../input";
import type { Connection } from "../../connection";
import {
  selectedAvatar, closeCharacterCard,
  pmMessages,
} from "../../store";
import type { PmMessage } from "../../store";

interface CharacterCardProps {
  connection: Connection;
  input: Input;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function PmMessageEl(props: { msg: PmMessage }) {
  return (
    <div class={`character-card-pm-msg${props.msg.isSelf ? " self" : ""}`}>
      <div class="character-card-pm-msg-top">
        <span class="character-card-pm-msg-name">{props.msg.name}</span>
        <span class="character-card-pm-msg-time">{formatTime(props.msg.timestamp)}</span>
      </div>
      <div class="character-card-pm-msg-text">{props.msg.text}</div>
    </div>
  );
}

export function CharacterCard(props: CharacterCardProps) {
  let messagesRef!: HTMLDivElement;
  let inputRef!: HTMLInputElement;

  const isOpen = () => selectedAvatar() !== null;
  const avatar = () => selectedAvatar();

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      if (messagesRef) {
        messagesRef.scrollTop = messagesRef.scrollHeight;
      }
    });
  };

  // Auto-scroll when messages change
  createEffect(() => {
    const _len = pmMessages.length;
    scrollToBottom();
  });

  const sendPm = () => {
    const text = inputRef.value.trim();
    const av = avatar();
    if (text && av) {
      props.connection.send({
        type: "private-message",
        targetAvatarId: av.avatarId,
        text,
      });
    }
    inputRef.value = "";
    // Keep focus for quick follow-up
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    sendPm();
  };

  const handleInputKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.code === "Escape") {
      inputRef.blur();
      props.input.setChatOpen(false);
    }
  };

  const handleInputFocus = () => {
    props.input.setChatOpen(true);
  };

  const handleInputBlur = () => {
    props.input.setChatOpen(false);
  };

  // Close on Escape (when not typing)
  const handleWindowKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Escape" && isOpen() && !props.input.chatOpen) {
      closeCharacterCard();
    }
  };

  onMount(() => {
    window.addEventListener("keydown", handleWindowKeyDown);
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleWindowKeyDown);
  });

  return (
    <div class="character-card" classList={{ open: isOpen() }}>
      <div class="character-card-header">
        <div class="character-card-name">{avatar()?.name ?? ""}</div>
        <button class="character-card-close" onClick={closeCharacterCard}>
          {"\u00d7"}
        </button>
      </div>
      <div class="character-card-body">
        {/* Info section */}
        <Show when={avatar()}>
          {(av) => (
            <div class="character-card-info">
              <div class="character-card-info-row">
                <span class="character-card-info-label">Character</span>
                <span class="character-card-info-value">{av().characterId}</span>
              </div>
              <div class="character-card-info-row">
                <span class="character-card-info-label">Status</span>
                <span class="character-card-info-value">Online</span>
              </div>
            </div>
          )}
        </Show>

        {/* PM section */}
        <div class="character-card-pm">
          <div class="character-card-pm-header">Private Messages</div>
          <div class="character-card-pm-messages" ref={messagesRef}>
            <For each={pmMessages}>
              {(msg) => <PmMessageEl msg={msg} />}
            </For>
          </div>
          <Show when={pmMessages.length === 0}>
            <div class="character-card-pm-empty">No messages yet. Say hello!</div>
          </Show>
          <form class="character-card-pm-form" onSubmit={handleSubmit}>
            <input
              ref={inputRef}
              class="character-card-pm-input"
              type="text"
              placeholder="Send a private message..."
              maxLength={200}
              onKeyDown={handleInputKeyDown}
              onFocus={handleInputFocus}
              onBlur={handleInputBlur}
            />
          </form>
        </div>
      </div>
    </div>
  );
}
