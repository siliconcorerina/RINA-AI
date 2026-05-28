# @siliconcorerina/rina-orchestrator

Multi-agent task orchestrator powered by **RINA AI**.

Decomposes a free-form goal into atomic steps, dispatches each to a
specialised sub-agent, and streams the live trace back to the
caller. v0.1 ships a **Browser sub-agent** (Playwright-backed) that
drives a real Chromium and reads the DOM through an LLM-friendly
tool surface.

```
┌──────────┐
│  Goal    │  free-form user intent
└────┬─────┘
     ▼
┌──────────────────────────────────────────────────┐
│  Orchestrator Core                                │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ Planner  │→ │ Dispatcher │  │ State Manager│  │
│  └──────────┘  └─────┬──────┘  └──────────────┘  │
└──────────────────────┼───────────────────────────┘
                       ▼
              ┌─────────────────┐
              │  Sub-Agents     │
              │  ─ Browser      │  ← v0.1
              │  ─ Code (todo)  │
              │  ─ Answer (todo)│
              └─────────────────┘
```

## Install

```bash
npm install -g @siliconcorerina/rina-orchestrator

# Playwright needs to download its Chromium build the first time.
npx playwright install chromium
```

## Quick start

```bash
export DEEPSEEK_API_KEY=sk-…    # or OPENAI_API_KEY / ANTHROPIC_API_KEY / MISTRAL_API_KEY

rina-orchestrator "Trouve le prix du Bitcoin sur coingecko.com et donne-le-moi"
```

Output (truncated):

```
📋 Plan (3 étapes):
  1. [browser] Ouvre https://www.coingecko.com
  2. [browser] Lis la page et note le prix actuel du Bitcoin (BTC).
  3. [browser] Retourne le prix exact comme résultat final.

▶ Étape s1…
   → navigate https://www.coingecko.com
   → read_page
✓ Étape s1 (2 tours): OK, page chargée…

▶ Étape s2…
   → read_page
✓ Étape s2 (1 tour): Le prix du Bitcoin est 68 742 USD…

▶ Étape s3…
✓ Étape s3 (1 tour): 68 742 USD

🎉 Terminé.

Résultat:
68 742 USD
```

## Library use

```ts
import { runGoal } from "@siliconcorerina/rina-orchestrator";
import { backendFromSpec } from "@siliconcorerina/rina-agent/out/backend.js";

const backend = backendFromSpec("deepseek:deepseek-chat");
const { summary, plan, events } = await runGoal(
  backend,
  "Find the latest release version of React from reactjs.org",
  {
    onEvent: (e) => console.log(e.type, e),
    browser: { headless: true },
    maxSteps: 6,
  }
);

console.log(summary);
```

## CLI flags

| Flag | Description |
|---|---|
| `--backend <spec>` | `provider:model`. Default `deepseek:deepseek-chat`. Supports `openai`, `anthropic`, `mistral`, `deepseek`, `rina`. |
| `--headed` | Open a visible Chromium window. Default headless. |
| `--max-steps <N>` | Cap on planner step count, 1..12. Default 6. |
| `--json` | Emit NDJSON events on stdout — one event per line — instead of the pretty trace. Good for piping. |

## Backends

Reuses [@siliconcorerina/rina-agent](https://www.npmjs.com/package/@siliconcorerina/rina-agent)'s
`backendFromSpec`. The planner + browser agent both require **native
function-calling**, so all four cloud providers work:

- `deepseek:deepseek-chat` — recommended default (function-calling, cheap).
- `openai:gpt-4o-mini`
- `anthropic:claude-3-5-haiku-latest`
- `mistral:codestral-latest`

Set the matching `<PROVIDER>_API_KEY` env var.

## Browser agent tool surface

The browser sub-agent exposes nine verbs to the LLM. The model picks
one per turn; we forbid free-form replies (the system prompt makes
this explicit + the SDK retries when the model strays).

| Tool | Effect |
|---|---|
| `navigate(url)` | Open URL, return cleaned page snapshot + interactive refs. |
| `read_page()` | Re-snapshot the current page. Call after click/type. |
| `click(ref)` | Click element identified by a `[N]` ref. |
| `type(ref, text)` | Fill a textbox. |
| `press(key)` | Single keystroke (Enter, Escape, Tab…). |
| `scroll(direction)` | "down" or "up" by ~800px. |
| `back()` | history.back(). |
| `wait(ms)` | Pause up to 10s. Use sparingly. |
| `done(summary)` | Terminate the step with the final result. |

Page snapshots are capped at 8 KB of cleaned text + 40 interactive
elements — enough for the LLM to identify what's on screen without
blowing context.

## What's NOT in v0.1

- **Code agent** — recognised by the planner but not implemented.
  Will reuse rina-agent's tool surface.
- **Answer agent** — same.
- **Vision** — no screenshots. DOM-only navigation. Vision-tuned
  models (Claude 3.5, GPT-4o) gain nothing here yet; a v0.2 will
  add an optional `screenshot()` tool.
- **Parallel steps** — strict sequential execution. A DAG executor
  is on the roadmap.
- **Sandboxing** — the browser runs in your local machine's context.
  Don't ask it to log into your bank account.

## Roadmap

- [ ] Code sub-agent (reuses rina-agent under the hood).
- [ ] Optional vision (screenshot + Claude/GPT-4o).
- [ ] HTTP bridge in rina-ai-pro so the mobile app can trigger runs.
- [ ] Replay UI: feed an `events[]` array and re-render the trace.

## License

MIT. © Silicon Core.
