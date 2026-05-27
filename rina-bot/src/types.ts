/**
 * Shared types for rina-bot.
 *
 * Keep this file tiny — it documents the contract between the
 * channel adapters, the session manager, and the CLI. Anything
 * domain-specific (Telegram update shapes, etc.) lives in the
 * channel module that needs it.
 */

/**
 * A platform-agnostic incoming message handed to the agent bridge.
 * Each channel adapter (Telegram, Discord, …) is responsible for
 * normalising whatever the provider emits into this shape.
 */
export interface IncomingMessage {
  /** Stable, per-conversation key — used to look up the agent session. */
  chatId: string;
  /** Stable, per-author key — used for the user allowlist. */
  userId: string;
  /** Human-readable name for logs only. May be empty. */
  userDisplay: string;
  /** Body of the message — plain text only in v0.1. */
  text: string;
}

/**
 * What the channel adapter must implement to be plugged into the bot.
 *
 * The contract is push-based: the adapter receives a `dispatch`
 * callback at startup and calls it whenever a new message arrives.
 * That keeps the bot loop oblivious to whether the provider uses
 * webhooks, long polling, or websockets.
 */
export interface ChannelAdapter {
  /** Provider name shown in logs ("telegram", "discord", …). */
  readonly name: string;
  /** Start receiving messages. Resolves on graceful shutdown. */
  start(dispatch: (msg: IncomingMessage) => Promise<void>): Promise<void>;
  /** Send a reply back to the same conversation. */
  send(chatId: string, text: string): Promise<void>;
  /** Stop polling / disconnect. Idempotent. */
  stop(): void;
}

/**
 * Full bot configuration. Mirrors the rina-agent convention: every
 * field is required at the type level so the CLI has to provide
 * defaults explicitly.
 */
export interface BotConfig {
  /** Backend spec used for the agent loop, e.g. `deepseek:deepseek-chat`. */
  backendSpec: string;
  /** Workdir the agent is scoped to (files the bot can read). */
  workdir: string;
  /** Hard cap on agent steps per message. */
  maxSteps: number;
  /** Soft cap on response tokens per message. */
  tokenBudget: number;
  /** System-prompt language. */
  language: "en" | "fr";
  /**
   * Comma-separated allowlist of user ids that may DM the bot. Empty
   * string means "anyone" — useful for local testing, dangerous for
   * production. The CLI logs a warning when it's empty.
   */
  allowedUserIds: Set<string>;
  /**
   * When true, the bot also accepts write_file / edit_file / shell
   * tools. Default false because a chat bot is "internet-exposed" and
   * the human isn't sitting at the keyboard to confirm each action.
   */
  allowWrites: boolean;
}
