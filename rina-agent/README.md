# `rina-agent`

> Autonomous shell agent for RINA AI — reads files, writes code, runs commands.

Same multi-backend abstraction as `rina-cli` and `rina-lsp`: works with
**OpenAI**, **Anthropic**, **Mistral**, **DeepSeek** out of the box.

⚠️ **An LLM that can execute shell commands is one hallucination away from
deleting your files.** Read the [Safety](#safety) section before using
`--yolo`.

---

## Install

```bash
git clone https://github.com/siliconcorerina/RINA-AI.git
cd RINA-AI/rina-agent
npm install
npm run build
npm install -g .
```

Set an API key for at least one provider:

```bash
export DEEPSEEK_API_KEY=sk-...   # cheapest option
# or OPENAI_API_KEY / ANTHROPIC_API_KEY / MISTRAL_API_KEY
```

---

## Usage

```bash
# Plain prompt
rina-agent "add a /health endpoint to server.ts that returns 200 OK"

# Scope to a specific directory (the agent cannot escape it)
rina-agent --workdir ./my-repo "ajoute des tests unitaires pour utils.py" --lang fr

# Read-only exploration — refuses every write_file and shell call
rina-agent --read-only "explain the architecture of this codebase"

# Use a stronger model for tricky tasks
rina-agent --backend deepseek:deepseek-reasoner --max-steps 40 \
  "find why the integration test in test/api.test.ts is flaky and fix it"

# Pipe the task from somewhere else
echo "rename every UserDTO to User everywhere in src/" | rina-agent --stdin
```

`rina-agent --help` lists every flag.

---

## How it works

1. The agent receives the task and a system prompt describing five tools.
2. It loops: ask the model what to do → parse a `<tool>{...}</tool>` JSON
   block from the response → execute it → feed the result back → repeat.
3. Termination happens when the model calls `finish`, or when the step
   limit / token budget is reached.

### Tools available to the model

| Tool         | Purpose                                                   |
|--------------|-----------------------------------------------------------|
| `read_file`  | Read a file relative to `--workdir`.                      |
| `write_file` | Create/overwrite a file. **Asks for your confirmation.**  |
| `list_files` | Non-recursive directory listing.                          |
| `shell`      | Run a shell command. **Asks for your confirmation.**      |
| `finish`     | Signal task complete with a one-paragraph summary.        |

---

## Safety

`rina-agent` defaults to the smallest possible blast radius. You have to
opt in to anything dangerous.

### Built-in protections (always on)

- **Path scoping** — every read/write/list is anchored to `--workdir`.
  `../`, absolute paths, and sneaky compounds all return a hard error
  instead of touching the filesystem.
- **Command blacklist** — these are rejected even with `--yolo`:
  - `rm -rf /`, `rm -rf ~`, `rm -rf $HOME/...`
  - `sudo`, `su -`
  - `mkfs`, `dd if=... of=/dev/...`, `format`, `diskpart`
  - `curl|sh`, `wget|bash` (any network-to-shell pipe)
  - Classic fork bomb `:(){ :|:& };:`
  - `shred`, `wipe`, `srm`
- **Step limit** — default **25** tool calls, configurable via `--max-steps`.
- **Token budget** — default **100,000** response tokens, configurable via
  `--budget`.
- **Shell timeout** — 60 s per command.

### Opt-in flags

| Flag           | Effect                                                                  |
|----------------|-------------------------------------------------------------------------|
| `--yolo`       | Skip the interactive Y/n confirmation. The blacklist still applies.     |
| `--read-only`  | Reject every `write_file` and `shell` call up-front. Safe for exploration. |

### What you'll see

Before each shell command:

```
Run shell: `npm test` [Y/n]
```

Before each file write:

```
── OVERWRITE /path/to/file.ts (430 → 612 bytes) ──
import { foo } from './foo';
...
── end ──
Write to src/utils.ts? [Y/n]
```

---

## Backends

| Spec                                | Provider          | Env var              |
|-------------------------------------|-------------------|----------------------|
| `openai:gpt-4o-mini`                | OpenAI            | `OPENAI_API_KEY`     |
| `openai:gpt-4o`                     | OpenAI            | `OPENAI_API_KEY`     |
| `anthropic:claude-3-5-haiku-latest` | Anthropic         | `ANTHROPIC_API_KEY`  |
| `anthropic:claude-3-7-sonnet-latest`| Anthropic         | `ANTHROPIC_API_KEY`  |
| `mistral:codestral-latest`          | Mistral           | `MISTRAL_API_KEY`    |
| `deepseek:deepseek-chat`            | DeepSeek (V3)     | `DEEPSEEK_API_KEY`   |
| `deepseek:deepseek-reasoner`        | DeepSeek (R1)     | `DEEPSEEK_API_KEY`   |
| `rina:https://api.example.com/v1`   | RINA (future)     | `RINA_API_KEY`       |

For tricky tasks, `deepseek:deepseek-reasoner` and `anthropic:claude-3-7-sonnet-latest`
are usually worth the extra cost. For simple edits, `gpt-4o-mini` or
`deepseek:deepseek-chat` are 10–100× cheaper.

---

## Environment

| Variable             | Effect                                                |
|----------------------|-------------------------------------------------------|
| `RINA_BACKEND`       | Default value for `--backend`.                        |
| `RINA_LANG`          | Default value for `--lang` (`en` or `fr`).            |
| `*_API_KEY`          | Provider credentials (see backends table).            |

---

## Limitations (v0)

- **No native function-calling yet.** The protocol is prompt-based
  (`<tool>{...}</tool>`). This works across all four providers but is
  marginally less reliable than native tool calls. v1 will switch where
  the provider supports it.
- **Non-recursive `list_files`.** The model can do depth manually via
  `shell`/`find`. A recursive variant might land in v1.
- **Single-shot only.** No `--continue` flag yet; each run starts a new
  conversation.
- **No Docker sandbox.** Path scoping + blacklist + confirmation are
  the only barriers between the model and your machine. For high-trust
  scenarios (CI agents, untrusted models) run under a container.

---

## License

MIT. See [LICENSE](../LICENSE) at the repo root.

Part of the [RINA AI](https://github.com/siliconcorerina/RINA-AI) project.
