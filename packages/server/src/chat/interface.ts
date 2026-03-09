/**
 * Chat provider interface — abstraction over the messaging backend.
 *
 * V1: In-memory channels (MemoryChatProvider).
 * Future: IRC-backed channels (IrcChatProvider).
 *
 * Design constraints:
 *   - An avatar can be in exactly ONE room channel + the global channel.
 *   - A room maps to a channel (channel name = room name).
 *   - The global channel "#global" exists for broadcast messages.
 *   - When an avatar changes rooms, they leave the old room channel
 *     and join the new one.
 */

/** Handler for incoming chat messages */
export type ChatMessageHandler = (
  channel: string,
  avatarId: string,
  text: string,
) => void;

/**
 * Abstract chat provider interface.
 * Implementations manage channels and message delivery.
 */
export interface ChatProvider {
  /** Create a new channel (idempotent — no-op if already exists) */
  createChannel(name: string): void;

  /** Destroy a channel and remove all members */
  destroyChannel(name: string): void;

  /** Add an avatar to a channel */
  join(channel: string, avatarId: string): void;

  /** Remove an avatar from a channel */
  leave(channel: string, avatarId: string): void;

  /** Remove an avatar from ALL channels */
  leaveAll(avatarId: string): void;

  /** Send a message to a channel (from an avatar) */
  send(channel: string, avatarId: string, text: string): void;

  /** Register a handler for incoming messages */
  onMessage(handler: ChatMessageHandler): void;

  /** Get all avatar IDs currently in a channel */
  getMembers(channel: string): string[];
}
