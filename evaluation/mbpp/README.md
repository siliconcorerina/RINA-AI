# MBPP — RINA AI

Evaluation des modeles RINA AI sur le benchmark MBPP (974 problemes Python simples).

## Lancement

```bash
python evaluation/mbpp/run_eval.py \
    --model siliconcorerina/rina-coder-base \
    --split test \
    --output results/mbpp.json
```

Splits disponibles : `train`, `validation`, `test`, `prompt`.

## Sortie

Fichier JSON avec `metrics` (`pass_at_1`, `pass_at_10`) et `per_problem`.

## Notes

- Le prompt est construit a partir de `text` + `test_list` du dataset MBPP.
- L execution se fait dans `evaluation/_utils/sandbox.py` (subprocess + timeout, **pas une sandbox de securite**).
