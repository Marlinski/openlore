/**
 * ChannelPanel — left-side panel for room channel chat.
 *
 * Chat is sent and received via IRC (AircClient), not the game WebSocket.
 */

import { useEffect, useRef } from "preact/hooks";
import type { AircClient } from "@airc/client";
import type { Input } from "../../input";
import type { Connection } from "../../connection";
import {
  channelOpen, toggleChannel,
  channelMessages, roomName, ircRoom,
} from "../../store";
import type { ChannelMessage } from "../../store";

interface ChannelPanelProps {
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

function MessageEl(props: { msg: ChannelMessage }) {
  return (
    <div class={`channel-panel-msg${props.msg.isSelf ? " self" : ""}`}>
      <div class="channel-panel-msg-top">
        <span class="channel-panel-msg-name">{props.msg.name}</span>
        <span class="channel-panel-msg-time">{formatTime(props.msg.timestamp)}</span>
      </div>
      <div class="channel-panel-msg-text">{props.msg.text}</div>
    </div>
  );
}

export function ChannelPanel(props: ChannelPanelProps) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      const el = messagesRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  // Auto-scroll when messages change
  const msgs = channelMessages.value;
  useEffect(() => {
    scrollToBottom();
  }, [msgs.length]);

  // Also scroll when panel opens
  useEffect(() => {
    if (channelOpen.value) scrollToBottom();
  }, [channelOpen.value]);

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
        toggleChannel();
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);

    // Enter key opens panel and focuses chat input
    props.input.onChatOpen(() => {
      if (!channelOpen.value) channelOpen.value = true;
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
    <div class={`channel-panel${channelOpen.value ? " open" : ""}`}>
      <div class="channel-panel-tab" onClick={toggleChannel}>
        <span class="channel-panel-tab-icon">{"\u25B8"}</span>
        <span class="channel-panel-tab-name">{roomName.value}</span>
      </div>
      <div class="channel-panel-content">
        <div class="channel-panel-messages" ref={messagesRef}>
          {channelMessages.value.map((msg, i) => (
            <MessageEl key={i} msg={msg} />
          ))}
        </div>
        <form class="channel-panel-form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            class="channel-panel-input"
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
