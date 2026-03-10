/**
 * ChannelPanel — left-side panel for room channel chat.
 */

import { For, createEffect, onMount, onCleanup } from "solid-js";
import type { Input } from "../../input";
import type { Connection } from "../../connection";
import {
  channelOpen, setChannelOpen, toggleChannel,
  channelMessages, roomName,
} from "../../store";
import type { ChannelMessage } from "../../store";

interface ChannelPanelProps {
  connection: Connection;
  input: Input;
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
  let messagesRef!: HTMLDivElement;
  let inputRef!: HTMLInputElement;

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      if (messagesRef) {
        messagesRef.scrollTop = messagesRef.scrollHeight;
      }
    });
  };

  // Auto-scroll when messages change
  createEffect(() => {
    // Access the store to track changes
    const _len = channelMessages.length;
    scrollToBottom();
  });

  // Also scroll when panel opens
  createEffect(() => {
    if (channelOpen()) scrollToBottom();
  });

  const sendChat = () => {
    const text = inputRef.value.trim();
    if (text) {
      props.connection.send({ type: "chat", text });
    }
    inputRef.value = "";
    inputRef.blur();
    props.input.setChatOpen(false);
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    sendChat();
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

  // Tab key toggles the panel
  const handleWindowKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Tab" && !props.input.chatOpen) {
      e.preventDefault();
      toggleChannel();
    }
  };

  onMount(() => {
    window.addEventListener("keydown", handleWindowKeyDown);

    // Enter key opens panel and focuses chat input
    props.input.onChatOpen(() => {
      if (!channelOpen()) setChannelOpen(true);
      inputRef.focus();
    });

    props.input.onChatClose(() => {
      inputRef.blur();
    });
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleWindowKeyDown);
  });

  return (
    <div class="channel-panel" classList={{ open: channelOpen() }}>
      <div class="channel-panel-tab" onClick={toggleChannel}>
        <span class="channel-panel-tab-icon">{"\u25B8"}</span>
        <span class="channel-panel-tab-name">{roomName()}</span>
      </div>
      <div class="channel-panel-content">
        <div class="channel-panel-messages" ref={messagesRef}>
          <For each={channelMessages}>
            {(msg) => <MessageEl msg={msg} />}
          </For>
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
