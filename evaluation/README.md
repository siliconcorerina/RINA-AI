# Évaluation — RINA AI

Ce dossier contient les scripts et configurations pour évaluer les modèles RINA AI sur différents benchmarks de génération de code.

## Benchmarks prévus

- **HumanEval** — génération de fonctions Python à partir de docstrings
- **MBPP** — résolution de problèmes simples de programmation Python
- **MultiPL-E** — évaluation multi-langage
- **RINA-Bench** *(interne)* — suite d'évaluation propre à RINA AI

## Structure

```
evaluation/
├── README.md              # Ce fichier
├── humaneval/             # Scripts HumanEval (à venir)
├── mbpp/                  # Scripts MBPP (à venir)
└── rina_bench/            # Benchmark interne (à venir)
```

## Utilisation type

```bash
python evaluation/humaneval/run_eval.py \
    --model <chemin_ou_id_huggingface> \
    --output results/humaneval.json
```

## Métriques

Les scripts produisent par défaut :
- `pass@1`, `pass@10`, `pass@100`
- Temps moyen de génération par échantillon
- Tokens générés par seconde

> Les scripts seront publiés progressivement. Suivez les issues du dépôt pour le statut.
