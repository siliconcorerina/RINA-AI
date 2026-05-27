# Changelog

Toutes les modifications notables de RINA AI sont documentees ici.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le projet adhere a [Semantic Versioning](https://semver.org/lang/fr/).

## [Non publie]

### Ajoute

#### Evaluation
- Backend pluggable `evaluation/_utils/backend.py` — specs `hf:`, `openai:`, `anthropic:`, `mistral:`, `deepseek:` partagees avec le LSP server et le CLI
- Backend DeepSeek (V3, R1, Coder) — OpenAI-compatible via `deepseek:<model>`, cle `DEEPSEEK_API_KEY`
- LiveCodeBench runner — problemes de concours, faible contamination
- BigCodeBench runner — taches multi-bibliotheques, styles `complete` et `instruct`
- SWE-bench runner — generation de patches au format predictions officiel (grading externe via le harness Docker `swebench`)
- `evaluation/compare.py` — orchestrateur multi-modeles, modes RUN et MERGE, sorties Markdown + CSV
- Tests : `tests/test_backend.py` (13), `tests/test_compare.py` (10), `tests/test_swebench.py` (12)

#### Outils developpeur
- `lsp-server/` — implementation Language Server Protocol en TypeScript pour Neovim, Helix, Zed, Sublime Text, Emacs (lsp-mode + eglot) et JupyterLab. 3 actions exposees : Explain / Refactor / Generate tests. Backends pluggables, prompts FR/EN. Configs prets-a-coller dans `editor-configs/`. 31 tests vitest.
- `rina-cli/` — CLI shell pipe-friendly. Verbes : `ask`, `explain`, `refactor`, `tests`. Memes backends + prompts que le LSP server. 59 tests vitest.
- Compatibilite Cursor / Windsurf documentee pour l'extension VS Code existante

#### CI
- Job `lsp-server` : build TypeScript strict + tests vitest
- Job `rina-cli` : build + tests + smoke test du binaire (`--version`, `--help`)

### Corrige
- Plusieurs warnings ruff (UP037, I001, F541, F401) introduits par les commits initiaux des nouveaux runners

## [0.1.0] — 2026-05-26

### Ajoute

#### Structure projet
- Bootstrap du depot : `README`, `LICENSE` (MIT), `.gitignore`, `requirements.txt`, `pyproject.toml`
- Logo SVG vectoriel RINA AI dans `assets/logo/`
- `CONTRIBUTING.md` et `SECURITY.md`
- CI GitHub Actions : ruff lint + verification de structure + compilation Python

#### Evaluation
- `evaluation/_utils/sandbox.py` : sandbox subprocess + calcul de `pass@k`
- `evaluation/humaneval/run_eval.py` : runner HumanEval (`pass@1`, `pass@10`, `pass@100`)
- `evaluation/mbpp/run_eval.py` : runner MBPP avec splits configurables
- `evaluation/multipl_e/run_eval.py` : runner multi-langage Rust / Go / Kotlin

#### Fine-tuning
- `finetune/train.py` : script LoRA / full FT pilote par YAML
- `finetune/configs/lora_default.yaml` : configuration LoRA d exemple
- `finetune/data/sample_*.jsonl` : jeux d exemple format prompt/completion + messages

#### Demos
- `demo/inference_example.py` : inference simple via `transformers`
- `demo/chat_example.py` : REPL chat multi-tour avec streaming
- `demo/api_client.py` : client REST + streaming SSE pour `api.plateforme-rina.com`

#### Extension VS Code
- Bootstrap `vscode-extension/` (TypeScript, VS Code 1.85+)
- Commandes : `explain`, `refactor`, `generate`, `setApiKey`
- Settings : `rinaAI.baseUrl`, `rinaAI.model`, `rinaAI.temperature`, `rinaAI.maxTokens`
- Stockage de la cle API dans `SecretStorage` natif VS Code

#### HuggingFace
- Repo modele `siliconcorerina/rina-coder-base` cree (public)
- Model card initiale avec metadata YAML, usage, limitations, citation

[Non publie]: https://github.com/siliconcorerina/RINA-AI/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/siliconcorerina/RINA-AI/releases/tag/v0.1.0
