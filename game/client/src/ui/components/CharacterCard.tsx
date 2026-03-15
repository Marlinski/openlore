/**
 * CharacterCard — right-side slide-out panel for avatar interaction + PM chat.
 *
 * Private messages are sent via IRC (AircClient), not the game WebSocket.
 */

import { useEffect, useRef } from "preact/hooks";
import type { AircClient } from "@airc/client";
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
  irc: AircClient | null;
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
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isOpen = () => selectedAvatar.value !== null;
  const avatar = () => selectedAvatar.value;

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      const el = messagesRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  // Auto-scroll when messages change
  const msgs = pmMessages.value;
  useEffect(() => {
    scrollToBottom();
  }, [msgs.length]);

  const sendPm = () => {
    const el = inputRef.current;
    if (!el) return;
    const text = el.value.trim();
    const av = avatar();
    if (text && av && props.irc) {
      // Send PM via IRC — target is the avatar's name (IRC nick)
      props.irc.say(av.name, text);
    }
    el.value = "";
    // Keep focus for quick follow-up
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    sendPm();
  };

  const handleInputKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.code === "Escape") {
      inputRef.current?.blur();
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
  useEffect(() => {
    const handleWindowKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Escape" && isOpen() && !props.input.chatOpen) {
        closeCharacterCard();
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, []);

  const av = avatar();

  return (
    <div class={`character-card${isOpen() ? " open" : ""}`}>
      <div class="character-card-header">
        <div class="character-card-name">{av?.name ?? ""}</div>
        <button class="character-card-close" onClick={closeCharacterCard}>
          {"\u00d7"}
        </button>
      </div>
      <div class="character-card-body">
        {/* Info section */}
        {av && (
          <div class="character-card-info">
            <div class="character-card-info-row">
              <span class="character-card-info-label">Character</span>
              <span class="character-card-info-value">{av.characterId}</span>
            </div>
            <div class="character-card-info-row">
              <span class="character-card-info-label">Status</span>
              <span class="character-card-info-value">Online</span>
            </div>
          </div>
        )}

        {/* PM section */}
        <div class="character-card-pm">
          <div class="character-card-pm-header">Private Messages</div>
          <div class="character-card-pm-messages" ref={messagesRef}>
            {pmMessages.value.map((msg, i) => (
              <PmMessageEl key={i} msg={msg} />
            ))}
          </div>
          {pmMessages.value.length === 0 && (
            <div class="character-card-pm-empty">No messages yet. Say hello!</div>
          )}
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
