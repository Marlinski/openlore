/**
 * LorePanel — left-side panel for room channel chat.
 *
 * Chat is sent and received via IRC (AircClient), not the game WebSocket.
 */

import { useEffect, useRef } from "preact/hooks";
import type { AircClient } from "@airc/client";
import type { Input } from "../../input";
import type { Connection } from "../../connection";
import {
  loreOpen, toggleLore,
  loreMessages, roomName, ircRoom,
} from "../../store";
import type { LoreMessage } from "../../store";

interface LorePanelProps {
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

function MessageEl(props: { msg: LoreMessage }) {
  return (
    <div class={`lore-panel-msg${props.msg.isSelf ? " self" : ""}`}>
      <div class="lore-panel-msg-top">
        <span class="lore-panel-msg-name">{props.msg.name}</span>
        <span class="lore-panel-msg-time">{formatTime(props.msg.timestamp)}</span>
      </div>
      <div class="lore-panel-msg-text">{props.msg.text}</div>
    </div>
  );
}

export function LorePanel(props: LorePanelProps) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      const el = messagesRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  // Auto-scroll when messages change
  const msgs = loreMessages.value;
  useEffect(() => {
    scrollToBottom();
  }, [msgs.length]);

  // Also scroll when panel opens
  useEffect(() => {
    if (loreOpen.value) scrollToBottom();
  }, [loreOpen.value]);

  const sendChat = () => {
    const el = inputRef.current;
    if (!el) return;
    const text = el.value.trim();
    if (text && props.irc) {
      const room = ircRoom.value;
      if (room) {
        props.irc.say(room, text);
      }
    }
    el.value = "";
    el.blur();
    props.input.setChatOpen(false);
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    sendChat();
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

  // Tab key toggles the panel, Enter opens panel + focuses input
  useEffect(() => {
    const handleWindowKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Tab" && !props.input.chatOpen) {
        e.preventDefault();
        toggleLore();
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);

    // Enter key opens panel and focuses chat input
    props.input.onChatOpen(() => {
      if (!loreOpen.value) loreOpen.value = true;
      inputRef.current?.focus();
    });

    props.input.onChatClose(() => {
      inputRef.current?.blur();
    });

    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, []);

  return (
    <div class={`lore-panel${loreOpen.value ? " open" : ""}`}>
      <div class="lore-panel-tab" onClick={toggleLore}>
        <span class="lore-panel-tab-icon">{"\u25B8"}</span>
        <span class="lore-panel-tab-name">{roomName.value}</span>
      </div>
      <div class="lore-panel-content">
        <div class="lore-panel-messages" ref={messagesRef}>
          {loreMessages.value.map((msg, i) => (
            <MessageEl key={i} msg={msg} />
          ))}
        </div>
        <form class="lore-panel-form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            class="lore-panel-input"
            type="text"
            placeholder="Type a message..."
            maxLength={200}
            onKeyDown={handleInputKeyDown}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
          />
        </form>
      </div>
    </div>
  );
}
