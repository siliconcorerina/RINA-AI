<p align="center">
  <img src="assets/logo/rina-ai-logo.svg" alt="RINA AI" width="360"/>
</p>

# RINA AI

[![CI](https://github.com/siliconcorerina/RINA-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/siliconcorerina/RINA-AI/actions/workflows/ci.yml)
[![HuggingFace](https://img.shields.io/badge/%F0%9F%A4%97%20HuggingFace-rina--coder--base-yellow)](https://huggingface.co/siliconcorerina/rina-coder-base)
[![Site](https://img.shields.io/badge/site-plateforme--rina.com-blue)](https://plateforme-rina.com)
[![Contact](https://img.shields.io/badge/contact-hello%40plateforme--rina.com-orange)](mailto:hello@plateforme-rina.com)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> Plateforme et modèles d'IA pour la génération, la compréhension et l'assistance au code.

RINA AI est un projet open-source visant à fournir des modèles de langage spécialisés pour le code, accompagnés d'outils d'évaluation, de démonstration et de fine-tuning. Le projet est porté par l'équipe de [plateforme-rina.com](https://plateforme-rina.com).

## Sommaire

- [Présentation](#présentation)
- [Installation](#installation)
- [Démarrage rapide](#démarrage-rapide)
- [Évaluation](#évaluation)
- [Fine-tuning](#fine-tuning)
- [Feuille de route](#feuille-de-route)
- [Contribuer](#contribuer)
- [Licence](#licence)
- [Contact](#contact)

## Modèles

| Modèle | HuggingFace | Statut |
|--------|-------------|--------|
| RINA Coder Base | [`siliconcorerina/rina-coder-base`](https://huggingface.co/siliconcorerina/rina-coder-base) | Placeholder (poids à venir) |

## Présentation

RINA AI propose une suite d'outils autour de modèles de langage dédiés au code :

- **Inference** — interface simple pour interroger les modèles RINA AI sur des tâches de complétion, génération et explication de code.
- **Évaluation** — scripts pour mesurer les performances sur des benchmarks publics et internes.
- **Fine-tuning** — pipelines pour adapter les modèles à un domaine, un langage ou un style de code spécifique.
- **Démo** — exemples d'intégration prêts à l'emploi.

## Installation

```bash
git clone https://github.com/siliconcorerina/RINA-AI.git
cd RINA-AI
pip install -r requirements.txt
```

Python 3.10+ est recommandé.

## Démarrage rapide

Voir le dossier [`demo/`](demo/) pour des exemples d'inférence et d'intégration.

```bash
python demo/inference_example.py --prompt "Écris une fonction Python qui calcule la suite de Fibonacci"
```

## Évaluation

Les scripts d'évaluation se trouvent dans [`evaluation/`](evaluation/). Ils couvrent les benchmarks standards de génération de code (HumanEval, MBPP, MultiPL-E pour Rust/Go/Kotlin) ainsi qu'une suite interne RINA-Bench.

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

### SWE-bench — phase de génération + grading officiel

SWE-bench est gradé par un *harness* Docker officiel : trop lourd pour
tourner dans le même script que la génération. Notre runner se concentre
donc sur la phase 1 (génération des patches) et écrit un fichier
`predictions.json` au format officiel. La phase 2 (grading réel via
Docker) se lance ensuite avec le paquet `swebench` :

```bash
# 1. Génération des patches (RINA, GPT-4, Claude, …)
python evaluation/swebench/run_eval.py \
    --backend openai:gpt-4o \
    --dataset lite \
    --output results/swebench/lite.json
# → écrit aussi results/swebench/predictions.json

# 2. Grading Docker officiel (résolved rate réel)
pip install swebench
python -m swebench.harness.run_evaluation \
    --predictions_path results/swebench/predictions.json \
    --max_workers 4 \
    --run_id gpt-4o
```

En attendant le grading, le runner publie un **proxy** (`well_formed_rate`)
mappé sur `pass_at_1` pour que SWE-bench apparaisse dans la table de
comparaison — le champ `note` du JSON signale clairement que ce n'est
pas le score officiel.

### Comparer RINA AI à GPT-4 / Claude / Codestral

Les nouveaux runners acceptent un *backend spec* qui permet d'évaluer
n'importe quel modèle — local (HuggingFace) ou hébergé (OpenAI,
Anthropic, Mistral). Le script `evaluation/compare.py` orchestre une
campagne multi-modèles et émet un tableau Markdown + CSV prêt à coller :

```bash
# Exporter les clés API des modèles concurrents que vous voulez tester
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

Specs supportés : `hf:<id>`, `openai:<model>`, `anthropic:<model>`,
`mistral:<model>`. Les helpers de génération vivent dans
[`evaluation/_utils/backend.py`](evaluation/_utils/backend.py).

Vous pouvez aussi merger des résultats déjà calculés :

```bash
python evaluation/compare.py --merge results/*.json
```

## Fine-tuning

Pipeline LoRA / full fine-tuning dans [`finetune/`](finetune/), piloté par YAML :

```bash
python finetune/train.py --config finetune/configs/lora_default.yaml
```

Exemples de données dans [`finetune/data/`](finetune/data/).

## Extension VS Code

Extension VS Code RINA AI (explication, refactoring, génération) dans [`vscode-extension/`](vscode-extension/). Guides :
- [`vscode-extension/README.md`](vscode-extension/README.md) — installation et usage
- [`vscode-extension/PUBLISHING.md`](vscode-extension/PUBLISHING.md) — publication sur le Marketplace

## Entraînement et publication du modèle

- [`finetune/TRAINING_GUIDE.md`](finetune/TRAINING_GUIDE.md) — entraînement local ou Colab + upload HuggingFace
- [`notebooks/train_and_upload.ipynb`](notebooks/train_and_upload.ipynb) — notebook Colab clé-en-main

## Feuille de route

- [ ] Publication des premiers checkpoints RINA Coder
- [x] Benchmark complet sur HumanEval / MBPP / MultiPL-E
- [x] LiveCodeBench + BigCodeBench (avec backends pluggables OpenAI / Anthropic / Mistral)
- [x] SWE-bench (génération de patches + format officiel pour le harness Docker)
- [ ] Intégration avec la plateforme [plateforme-rina.com](https://plateforme-rina.com)
- [ ] Extension VS Code RINA AI
- [ ] Support multi-langage étendu (Rust, Go, Kotlin)

## Contribuer

Les contributions sont les bienvenues ! Ouvrez une issue ou une pull request. Pour les changements importants, merci d'en discuter d'abord via une issue.

## Licence

Ce projet est distribué sous licence MIT. Voir [LICENSE](LICENSE) pour les détails.

## Contact

- Site : [plateforme-rina.com](https://plateforme-rina.com)
- Email : [hello@plateforme-rina.com](mailto:hello@plateforme-rina.com)
- GitHub : [github.com/siliconcorerina](https://github.com/siliconcorerina)
