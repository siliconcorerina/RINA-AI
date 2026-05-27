# `rina-bot`

> RINA AI on the messaging channels you already use.

v0.1 ships **Telegram** support. More channels (Discord, Slack, WhatsApp)
on the roadmap — same `BotBrain`, swappable `ChannelAdapter`.

---

## Install

```bash
npm install -g @siliconcorerina/rina-bot
```

You also need a model API key. The bot uses the same backend
abstraction as `rina-agent`:

```bash
export DEEPSEEK_API_KEY=sk-...
# or OPENAI_API_KEY / ANTHROPIC_API_KEY / MISTRAL_API_KEY
```

---

## Quick start (Telegram)

### 1. Create a bot with @BotFather

1. Open Telegram, search for **@BotFather**, start a chat.
2. Send `/newbot`.
3. Pick a name (`MyRinaAI`) and username (`my_rina_ai_bot`).
4. Copy the **token** it gives you (`123456:ABC-DEF...`).

### 2. Find your Telegram user id

1. Open Telegram, search for **@userinfobot**, start a chat.
2. It replies with your numeric `Id: 12345678`. Copy that.

### 3. Set env vars and run

```bash
export TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
export TELEGRAM_ALLOWED_USER_IDS=12345678         # comma-separated
export DEEPSEEK_API_KEY=sk-...
rina-bot start
```

On Windows PowerShell:

```powershell
$env:TELEGRAM_BOT_TOKEN = "123456:ABC-DEF..."
$env:TELEGRAM_ALLOWED_USER_IDS = "12345678"
$env:DEEPSEEK_API_KEY = "sk-..."
rina-bot start
```

### 4. DM your bot

Open Telegram, find your bot by its `@username`, send a message.
It replies.

---

## What it does

- **Per-chat memory** — each Telegram conversation keeps its own
  history. Up to ~30 turns retained, oldest dropped first.
- **Built-in commands**:
  - `/start`, `/help` — show the help message
  - `/reset`, `/clear` — wipe the current chat's history
- **Long messages** are auto-split across multiple Telegram bubbles
  (provider limit: 4096 chars/message).
- **Network blips** are tolerated — the bot retries `getUpdates` on
  transient failures instead of crashing.
- **Graceful shutdown** — Ctrl-C or SIGTERM stops polling cleanly.

---

## Safety

A messaging bot is **internet-exposed** — anyone who knows your bot's
username can DM it. The defaults are tuned for that reality:

- **Allowlist**: `TELEGRAM_ALLOWED_USER_IDS` is a comma-separated
  list of user ids that may use the bot. Anyone else gets a polite
  rejection without touching your API quota.
- **No file writes / no shell** by default. The bot is a *chat*
  surface, not the autonomous `rina-agent` surface — the model
  cannot edit files or run commands from a Telegram message.
- **`--allow-writes`** opt-in: if you understand the risk and trust
  every user on your allowlist, this flag wires in the full
  rina-agent tool set. **Don't use it in a group/channel.**

> If `TELEGRAM_ALLOWED_USER_IDS` is empty, the bot prints a loud
> warning and accepts messages from anyone. That's fine for a quick
> demo on a private bot, not for anything beyond.

---

## Configuration

| Flag                | Default                    | Meaning                                   |
|---------------------|----------------------------|-------------------------------------------|
| `--backend SPEC`    | `$RINA_BACKEND` or `deepseek:deepseek-chat` | Provider:model                  |
| `--lang en\|fr`     | `$RINA_LANG` or `en`       | Reply language                            |
| `--workdir, -C DIR` | `cwd`                      | Workdir the agent is scoped to            |
| `--allow-writes`    | off                        | Enable write_file / edit_file / shell     |

### Environment variables

| Variable                     | Required | Meaning                                        |
|------------------------------|----------|------------------------------------------------|
| `TELEGRAM_BOT_TOKEN`         | yes      | From @BotFather                                |
| `TELEGRAM_ALLOWED_USER_IDS`  | rec.     | Comma-separated allowlist of user ids          |
| `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `MISTRAL_API_KEY` | one of | Backend auth |
| `RINA_BACKEND`               | no       | Default `--backend`                            |
| `RINA_LANG`                  | no       | Default `--lang`                               |

---

## Roadmap

- v0.2 — Discord adapter
- v0.3 — Slack adapter (Bolt)
- v0.4 — WhatsApp adapter (whatsapp-web.js, with the usual caveats)
- v0.5 — Persistent per-chat sessions across restarts
- v0.6 — Voice on macOS / iOS (TTS + STT)

---

## License

MIT. See [LICENSE](../LICENSE) at the repo root.

Part of the [RINA AI](https://github.com/siliconcorerina/RINA-AI) project.
