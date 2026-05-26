# Changelog

Toutes les modifications notables de RINA AI sont documentees ici.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le projet adhere a [Semantic Versioning](https://semver.org/lang/fr/).

## [Non publie]

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
