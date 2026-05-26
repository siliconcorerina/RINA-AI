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
```

## Fine-tuning

Pipeline LoRA / full fine-tuning dans [`finetune/`](finetune/), piloté par YAML :

```bash
python finetune/train.py --config finetune/configs/lora_default.yaml
```

Exemples de données dans [`finetune/data/`](finetune/data/).

## Extension VS Code

Le bootstrap d'une extension VS Code RINA AI (explication, refactoring, génération) est dans [`vscode-extension/`](vscode-extension/).

## Feuille de route

- [ ] Publication des premiers checkpoints RINA Coder
- [ ] Benchmark complet sur HumanEval / MBPP
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
