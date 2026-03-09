/**
 * In-memory chat provider.
 *
 * Simple implementation of ChatProvider for V1.
 * Channels are just Maps of avatar ID sets.
 * Messages are dispatched synchronously to registered handlers.
 *
 * Will be replaced by an IRC-backed provider later.
 */

import type { ChatProvider, ChatMessageHandler } from "./interface.js";

export class MemoryChatProvider implements ChatProvider {
  /** channel name → set of avatar IDs */
  private channels = new Map<string, Set<string>>();
  /** Registered message handlers */
  private handlers: ChatMessageHandler[] = [];

  createChannel(name: string): void {
    if (!this.channels.has(name)) {
      this.channels.set(name, new Set());
    }
  }

  destroyChannel(name: string): void {
    this.channels.delete(name);
  }

  join(channel: string, avatarId: string): void {
    // Auto-create channel if needed
    if (!this.channels.has(channel)) {
      this.createChannel(channel);
    }
    this.channels.get(channel)!.add(avatarId);
  }

  leave(channel: string, avatarId: string): void {
    this.channels.get(channel)?.delete(avatarId);
  }

  leaveAll(avatarId: string): void {
    for (const members of this.channels.values()) {
      members.delete(avatarId);
    }
  }

  send(channel: string, avatarId: string, text: string): void {
    // Only deliver if the sender is in the channel
    const members = this.channels.get(channel);
    if (!members || !members.has(avatarId)) return;

    for (const handler of this.handlers) {
      handler(channel, avatarId, text);
    }
  }

  onMessage(handler: ChatMessageHandler): void {
    this.handlers.push(handler);
  }

  getMembers(channel: string): string[] {
    return [...(this.channels.get(channel) ?? [])];
  }
}
