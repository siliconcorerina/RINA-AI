/**
 * Telegram Bot API adapter.
 *
 * Uses the HTTP Bot API directly — no third-party SDK — because:
 *   - `getUpdates` (long polling) is one fetch call,
 *   - `sendMessage` is one fetch call,
 *   - and we save several MB of node_modules versus the popular wrappers.
 *
 * Long polling is the right default for v0.1: webhooks need a public
 * HTTPS endpoint, which most users running this locally don't have.
 * `getUpdates` works through any NAT/firewall with no setup.
 *
 * Reference: https://core.telegram.org/bots/api
 */

import type { ChannelAdapter, IncomingMessage } from "../types.js";

const API_BASE = "https://api.telegram.org";
/** Long-poll timeout in seconds — the upper end of what Telegram allows. */
const POLL_TIMEOUT_S = 30;
/** Per-message length cap. Telegram itself rejects above ~4096 chars; we
 *  cap at 3900 to leave headroom for the truncation marker. */
const TELEGRAM_MAX_TEXT = 3900;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
  };
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram";
  private offset = 0;
  private running = false;

  constructor(private readonly token: string) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
      // Telegram tokens look like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`.
      // Catching the typo here saves a confusing 401 later.
      throw new Error(
        "TELEGRAM_BOT_TOKEN doesn't look right. Expected format 123456:ABC-DEF... — get one from @BotFather."
      );
    }
  }

  async start(dispatch: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    this.running = true;

    // First call to getMe both validates the token AND surfaces the
    // bot's username, which is useful in the startup log.
    const me = await this.callApi<{ username: string; first_name: string }>("getMe", {});
    process.stderr.write(`[rina-bot] connected to Telegram as @${me.username} (${me.first_name})\n`);

    while (this.running) {
      let updates: TelegramUpdate[] = [];
      try {
        updates = await this.callApi<TelegramUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: POLL_TIMEOUT_S,
          allowed_updates: ["message"],
        });
      } catch (err) {
        // Network blip — back off briefly and retry. Anything fatal
        // (token revoked, 401) we still log and keep trying every
        // few seconds so the user has a chance to fix env and SIGHUP.
        process.stderr.write(`[rina-bot] poll error: ${(err as Error).message}\n`);
        await sleep(2_000);
        continue;
      }

      for (const u of updates) {
        // Always advance the offset so a failing message doesn't get
        // re-delivered forever and block the queue.
        this.offset = Math.max(this.offset, u.update_id + 1);
        const msg = updateToIncoming(u);
        if (msg) {
          try {
            await dispatch(msg);
          } catch (err) {
            process.stderr.write(
              `[rina-bot] dispatch error for chat ${msg.chatId}: ${(err as Error).message}\n`
            );
            // Don't crash the polling loop — try to tell the user
            // something went wrong on their side, then keep going.
            try {
              await this.send(msg.chatId, `⚠️ rina-bot: ${(err as Error).message}`);
            } catch {
              /* best-effort */
            }
          }
        }
      }
    }
  }

  async send(chatId: string, text: string): Promise<void> {
    // Telegram caps message text at 4096 chars. We split into chunks
    // rather than truncate so the model's full reply still reaches
    // the user — chat UIs handle multi-bubble replies cleanly.
    const chunks = chunkText(text, TELEGRAM_MAX_TEXT);
    for (const chunk of chunks) {
      await this.callApi<unknown>("sendMessage", {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      });
    }
  }

  stop(): void {
    this.running = false;
  }

  private async callApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as TelegramApiResponse<T> | null;
    if (!data || !data.ok || data.result === undefined) {
      const desc = data?.description ?? "unknown error";
      throw new Error(`Telegram ${method} → HTTP ${res.status}: ${desc}`);
    }
    return data.result;
  }
}

/**
 * Pull the bits we care about out of a Telegram update. Returns null
 * for updates that aren't direct text messages (channel posts, edited
 * messages, photos without captions, …) so the bot loop can skip them.
 */
export function updateToIncoming(u: TelegramUpdate): IncomingMessage | null {
  const m = u.message;
  if (!m || !m.text || !m.from) {
    return null;
  }
  return {
    chatId: String(m.chat.id),
    userId: String(m.from.id),
    userDisplay: m.from.username || m.from.first_name || `user${m.from.id}`,
    text: m.text,
  };
}

/**
 * Split `text` into chunks of at most `max` characters, breaking on
 * line boundaries when possible. Used to fit replies into Telegram's
 * 4096-char-per-message limit without leaving the user on a cliff.
 */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    // Look for the last newline inside the window so we don't break
    // mid-paragraph. Fall back to a hard cut if there is none.
    const cutAt = remaining.lastIndexOf("\n", max);
    const slice = cutAt > max / 2 ? remaining.slice(0, cutAt) : remaining.slice(0, max);
    chunks.push(slice);
    remaining = remaining.slice(slice.length);
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
