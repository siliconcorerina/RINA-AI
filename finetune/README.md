# Fine-tuning — RINA AI

Pipelines pour adapter un modèle RINA AI à un domaine, un langage ou un style de code spécifique.

## Méthodes supportées

- **Full fine-tuning** — entraînement complet (nécessite plusieurs GPU)
- **LoRA / QLoRA** — adaptation paramètre-efficiente (1 GPU suffit pour la plupart des cas)
- **Instruction tuning** — adaptation au format chat/instruction

## Structure

```
finetune/
├── README.md              # Ce fichier
├── configs/               # Configurations YAML d'exemple
│   └── lora_default.yaml
├── train.py               # (à venir) Point d'entrée d'entraînement
└── data/                  # (à venir) Préparation des données
```

## Format des données

Les jeux de données attendus suivent un format JSONL simple :

```json
{"prompt": "...", "completion": "..."}
{"prompt": "...", "completion": "..."}
```

Ou, pour le format instruction :

```json
{"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
```

## Exécution

```bash
python finetune/train.py --config finetune/configs/lora_default.yaml
```

> Les scripts d'entraînement seront publiés au fur et à mesure. Consulter les issues du dépôt pour le statut.
