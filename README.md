<p align="center">
  <img src="assets/logo/rina-ai-logo.svg" alt="RINA AI" width="360"/>
</p>

# RINA AI

[![CI](https://github.com/siliconcorerina/RINA-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/siliconcorerina/RINA-AI/actions/workflows/ci.yml)
[![HuggingFace](https://img.shields.io/badge/%F0%9F%A4%97%20HuggingFace-rina--coder--base-yellow)](https://huggingface.co/siliconcorerina/rina-coder-base)
[![Site](https://img.shields.io/badge/site-rina.technology-blue)](https://www.rina.technology)
[![Contact](https://img.shields.io/badge/contact-hello%40rina.technology-orange)](mailto:hello@rina.technology)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> AI platform and models for code generation, code understanding and coding assistance.

RINA AI is an open-source project that provides language models specialized for code, along with evaluation, demo and fine-tuning tools. The project is led by the team at [www.rina.technology](https://www.rina.technology).

## Table of contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Evaluation](#evaluation)
- [Fine-tuning](#fine-tuning)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)
- [Contact](#contact)

## Models

| Model | HuggingFace | Status |
|--------|-------------|--------|
| RINA Coder Base | [`siliconcorerina/rina-coder-base`](https://huggingface.co/siliconcorerina/rina-coder-base) | Placeholder (weights coming soon) |

## Overview

RINA AI provides a suite of tools built around language models dedicated to code:

- **Inference** — a simple interface to query RINA AI models for code completion, generation and explanation tasks.
- **Evaluation** — scripts to measure performance on public and internal benchmarks.
- **Fine-tuning** — pipelines to adapt the models to a specific domain, language or coding style.
- **Demo** — ready-to-use integration examples.

## Installation

```bash
git clone https://github.com/siliconcorerina/RINA-AI.git
cd RINA-AI
pip install -r requirements.txt
```

Python 3.10+ is recommended.

## Quick start

See the [`demo/`](demo/) folder for inference and integration examples.

```bash
python demo/inference_example.py --prompt "Write a Python function that computes the Fibonacci sequence"
```

## Evaluation

Evaluation scripts live in [`evaluation/`](evaluation/). They cover the standard code generation benchmarks (HumanEval, MBPP, MultiPL-E for Rust/Go/Kotlin) as well as an internal suite, RINA-Bench.

```bash
# HumanEval
python evaluation/humaneval/run_eval.py --model siliconcorerina/rina-coder-base --n-samples 1

# MBPP
python evaluation/mbpp/run_eval.py --model siliconcorerina/rina-coder-base

# MultiPL-E (Rust)
python evaluation/multipl_e/run_eval.py --model siliconcorerina/rina-coder-base --language rs --output results/rs.json

# LiveCodeBench — contest problems updated regularly, low contamination risk
python evaluation/livecodebench/run_eval.py --backend hf:siliconcorerina/rina-coder-base --n-samples 1

# BigCodeBench — practical, multi-library tasks (function-completion or instruction styles)
python evaluation/bigcodebench/run_eval.py --backend hf:siliconcorerina/rina-coder-base --prompt-style complete

# SWE-bench — real GitHub issues, end-to-end patch generation
# (predictions only; run the official swebench harness on the JSON for the resolved rate)
python evaluation/swebench/run_eval.py --backend openai:gpt-4o --dataset lite --output results/swebench/lite.json
```

### SWE-bench — generation phase + official grading

SWE-bench is graded by an official Docker *harness*, which is too heavy
to run in the same script as generation. Our runner therefore focuses
on phase 1 (patch generation) and writes a `predictions.json` file in
the official format. Phase 2 (actual grading via Docker) is then run
with the `swebench` package:

```bash
# 1. Patch generation (RINA, GPT-4, Claude, …)
python evaluation/swebench/run_eval.py \
    --backend openai:gpt-4o \
    --dataset lite \
    --output results/swebench/lite.json
# → also writes results/swebench/predictions.json

# 2. Official Docker grading (actual resolved rate)
pip install swebench
python -m swebench.harness.run_evaluation \
    --predictions_path results/swebench/predictions.json \
    --max_workers 4 \
    --run_id gpt-4o
```

Until grading is done, the runner reports a **proxy** (`well_formed_rate`)
mapped to `pass_at_1` so that SWE-bench shows up in the comparison
table — the `note` field in the JSON clearly states that this is not
the official score.

### Comparing RINA AI with GPT-4 / Claude / Codestral

The new runners accept a *backend spec* that lets you evaluate any
model — local (HuggingFace) or hosted (OpenAI, Anthropic, Mistral).
The `evaluation/compare.py` script orchestrates a multi-model run and
outputs a ready-to-paste Markdown table + CSV:

```bash
# Export the API keys for the competing models you want to test
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
export MISTRAL_API_KEY=...

python evaluation/compare.py \
    --benchmark humaneval \
    --backends hf:siliconcorerina/rina-coder-base \
               openai:gpt-4o-mini \
               anthropic:claude-3-5-haiku-latest \
               mistral:codestral-latest \
    --n-samples 1 \
    --output-dir results/compare/humaneval
```

Supported specs: `hf:<id>`, `openai:<model>`, `anthropic:<model>`,
`mistral:<model>`. The generation helpers live in
[`evaluation/_utils/backend.py`](evaluation/_utils/backend.py).

You can also merge results that have already been computed:

```bash
python evaluation/compare.py --merge results/*.json
```

## Fine-tuning

LoRA / full fine-tuning pipeline in [`finetune/`](finetune/), driven by YAML:

```bash
python finetune/train.py --config finetune/configs/lora_default.yaml
```

Sample data in [`finetune/data/`](finetune/data/).

## VS Code extension

RINA AI VS Code extension (explain, refactor, generate) in [`vscode-extension/`](vscode-extension/). Guides:
- [`vscode-extension/README.md`](vscode-extension/README.md) — installation and usage
- [`vscode-extension/PUBLISHING.md`](vscode-extension/PUBLISHING.md) — publishing to the Marketplace

## LSP server (Neovim, Helix, Zed, Sublime, Emacs, JupyterLab)

A single Language Server Protocol server that brings the same actions
(**Explain / Refactor / Generate tests**) to any LSP-compatible editor.
Code in [`lsp-server/`](lsp-server/), pluggable backends (OpenAI,
Anthropic, Mistral, RINA), tests included (31 vitest tests).

```bash
cd lsp-server && npm install && npm run build
npm install -g .              # exposes the `rina-lsp` binary globally
export OPENAI_API_KEY=sk-...
rina-lsp --stdio              # your editor normally handles this
```

Ready-to-paste guides: [`lsp-server/CONFIGS.md`](lsp-server/CONFIGS.md)
(and drop-in config files in [`lsp-server/editor-configs/`](lsp-server/editor-configs/)).

## `rina` CLI

RINA AI from the shell, pipe-friendly. Code in [`rina-cli/`](rina-cli/) —
same backends and same prompts as the other tools.

```bash
cd rina-cli && npm install && npm run build && npm install -g .
export OPENAI_API_KEY=sk-...

rina ask "what does this regex match: ^[A-Z][a-z]{2,}$"
cat src/legacy.py | rina explain --stdin
rina refactor src/utils.py -o src/utils.refactored.py
rina tests src/parser.ts -o src/parser.test.ts
```

**Editor ↔ tool** summary:

| You code in… | You install… |
|---|---|
| VS Code, Cursor, Windsurf | [`vscode-extension/`](vscode-extension/) |
| Neovim, Helix, Zed, Sublime, Emacs, JupyterLab | [`lsp-server/`](lsp-server/) |
| Shell, scripts, CI | [`rina-cli/`](rina-cli/) |

## Training and publishing the model

- [`finetune/TRAINING_GUIDE.md`](finetune/TRAINING_GUIDE.md) — local or Colab training + HuggingFace upload
- [`notebooks/train_and_upload.ipynb`](notebooks/train_and_upload.ipynb) — turnkey Colab notebook

## Roadmap

- [ ] Release the first RINA Coder checkpoints
- [x] Full benchmark on HumanEval / MBPP / MultiPL-E
- [x] LiveCodeBench + BigCodeBench (with pluggable OpenAI / Anthropic / Mistral backends)
- [x] SWE-bench (patch generation + official format for the Docker harness)
- [ ] Integration with the [www.rina.technology](https://www.rina.technology) platform
- [x] RINA AI VS Code extension
- [x] Multi-editor LSP server (Neovim, Helix, Zed, Sublime, Emacs, JupyterLab)
- [x] `rina` CLI (shell, scripts, CI)
- [ ] Extended multi-language support (Rust, Go, Kotlin)

## Contributing

Contributions are welcome! Open an issue or a pull request. For major changes, please discuss them first in an issue.

## License

This project is released under the MIT license. See [LICENSE](LICENSE) for details.

## Contact

- Website: [www.rina.technology](https://www.rina.technology)
- Email: [hello@rina.technology](mailto:hello@rina.technology)
- GitHub: [github.com/siliconcorerina](https://github.com/siliconcorerina)
