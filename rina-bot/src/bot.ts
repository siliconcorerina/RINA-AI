/**
 * Bot brain — bridges incoming chat messages to the rina-agent backend.
 *
 * Two responsibilities:
 *   1. Enforce the user allowlist before doing any expensive work.
 *   2. Drive the model in a single-turn chat shape, sized for a
 *      messaging channel rather than the agent's full tool-use loop.
 *
 * v0.1 is deliberately *not* the full autonomous agent on every
 * Telegram message. A chat bot that can write files / run shell on
 * incoming DMs is a foot-gun; defaults are read-only and the agent
 * loop is capped at a low step count so quotas stay sane.
 *
 * The full --allow-writes path is opt-in for users who really want
 * RINA AI editing code from their phone — they get the same agent
 * loop as `rina-agent` itself.
 */

import { backendFromSpec, ChatMessage } from "@siliconcorerina/rina-agent/out/backend.js";
import type { BotConfig, ChannelAdapter, IncomingMessage } from "./types.js";

/** Cap on history retained per chat. Old turns are dropped FIFO. */
const HISTORY_LIMIT = 30;

/**
 * Per-chat in-memory state. Persistence (across bot restarts) is not
 * in v0.1 — restart wipes conversations clean. The trade-off is
 * intentional: persisting would mean serialising tool-call ids and
 * worrying about workdir drift; v0.2 can layer that on top.
 */
interface ChatState {
  messages: ChatMessage[];
}

export class BotBrain {
  private readonly sessions = new Map<string, ChatState>();

  constructor(
    private readonly channel: ChannelAdapter,
    private readonly config: BotConfig
  ) {}

  /**
   * Bot's main entry — wires the channel adapter to the agent and
   * blocks until the channel signals shutdown.
   */
  async run(): Promise<void> {
    const banner =
      `[rina-bot] starting on ${this.channel.name} · ` +
      `backend=${this.config.backendSpec} · ` +
      `allowed=${this.config.allowedUserIds.size === 0 ? "ANY (warning!)" : this.config.allowedUserIds.size} · ` +
      `writes=${this.config.allowWrites ? "ON (dangerous)" : "off"}\n`;
    process.stderr.write(banner);
    if (this.config.allowedUserIds.size === 0) {
      process.stderr.write(
        `[rina-bot] WARNING: no TELEGRAM_ALLOWED_USER_IDS set — anyone who DMs the bot can use your API quota.\n` +
          `             Get your user id from @userinfobot, then set TELEGRAM_ALLOWED_USER_IDS=<id>.\n`
      );
    }
    await this.channel.start((msg) => this.handle(msg));
  }

  /**
   * Handle one incoming message. Always replies — silent drops are a
   * worse UX than "sorry, you're not allowed" because users wonder if
   * the bot is broken.
   */
  private async handle(msg: IncomingMessage): Promise<void> {
    if (
      this.config.allowedUserIds.size > 0 &&
      !this.config.allowedUserIds.has(msg.userId)
    ) {
      process.stderr.write(
        `[rina-bot] rejected user ${msg.userId} (${msg.userDisplay}) — not in allowlist\n`
      );
      await this.channel.send(
        msg.chatId,
        `This RINA AI bot is private. Ask the operator to add user id \`${msg.userId}\` to TELEGRAM_ALLOWED_USER_IDS.`
      );
      return;
    }

    process.stderr.write(
      `[rina-bot] ${this.channel.name}/${msg.chatId} (${msg.userDisplay}): ${truncate(msg.text, 80)}\n`
    );

    // Quick built-in commands so the user can see the bot is alive
    // without burning API tokens.
    const trimmed = msg.text.trim().toLowerCase();
    if (trimmed === "/start" || trimmed === "/help") {
      await this.channel.send(msg.chatId, this.helpText());
      return;
    }
    if (trimmed === "/reset" || trimmed === "/clear") {
      this.sessions.delete(msg.chatId);
      await this.channel.send(msg.chatId, "Conversation reset. ✨");
      return;
    }

    // Look up (or initialise) the per-chat conversation state.
    let state = this.sessions.get(msg.chatId);
    if (!state) {
      state = { messages: [{ role: "system", content: this.systemPrompt() }] };
      this.sessions.set(msg.chatId, state);
    }
    state.messages.push({ role: "user", content: msg.text });

    let reply: string;
    try {
      const backend = backendFromSpec(this.config.backendSpec);
      reply = await backend.generate(state.messages, {
        maxTokens: 1024,
        temperature: 0.4,
      });
    } catch (err) {
      reply = `⚠️ Backend error: ${(err as Error).message}`;
    }

    state.messages.push({ role: "assistant", content: reply });

    // Trim old turns once we're over the limit — keep the system
    // prompt + the most recent (HISTORY_LIMIT - 1) messages.
    if (state.messages.length > HISTORY_LIMIT) {
      const system = state.messages.find((m) => m.role === "system");
      const tail = state.messages.slice(-HISTORY_LIMIT + 1);
      state.messages = system ? [system, ...tail] : tail;
    }

    await this.channel.send(msg.chatId, reply);
  }

  private systemPrompt(): string {
    const lang = this.config.language;
    if (lang === "fr") {
      return (
        "Tu es RINA AI, un assistant personnel sympathique répondant via une messagerie. " +
        "Reste concis (quelques phrases par message — c'est un chat, pas un essai). " +
        "Si l'utilisateur a besoin de code, donne-le directement dans un bloc. " +
        "Tu ne peux PAS écrire de fichiers ni lancer de commandes shell depuis ce canal."
      );
    }
    return (
      "You are RINA AI, a friendly personal assistant answering through a messaging channel. " +
      "Stay concise (a few sentences per message — this is chat, not an essay). " +
      "If the user needs code, just paste it in a fenced block. " +
      "You CANNOT write files or run shell commands from this channel."
    );
  }

  private helpText(): string {
    return (
      "👋 I'm RINA AI on Telegram.\n\n" +
      "Just send me a question. I'll reply with help, code snippets, explanations, whatever you need.\n\n" +
      "Built-in commands:\n" +
      "  /start, /help — show this message\n" +
      "  /reset, /clear — wipe the conversation history\n\n" +
      `Backend: ${this.config.backendSpec}\n` +
      "Docs: https://github.com/siliconcorerina/RINA-AI/tree/main/rina-bot"
    );
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
