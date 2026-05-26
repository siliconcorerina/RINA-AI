# HumanEval — RINA AI

Evaluation des modeles RINA AI sur le benchmark HumanEval (164 problemes de programmation Python).

## Lancement

```bash
pip install -r requirements.txt
pip install datasets

python evaluation/humaneval/run_eval.py \
    --model siliconcorerina/rina-coder-base \
    --n-samples 1 \
    --output results/humaneval.json
```

Pour calculer `pass@10` ou `pass@100`, augmenter `--n-samples` en consequence (et `--temperature` > 0).

## Sortie

Fichier JSON contenant :
- `metrics` : `pass_at_1`, `pass_at_10`, `pass_at_100`
- `per_problem` : detail par tache HumanEval (`task_id`, `n_correct`, traces)

## Securite

Le script execute le code genere via `evaluation/_utils/sandbox.py`. Ce n est pas une sandbox de securite, juste une isolation processus + timeout. **A executer dans un environnement controle (CI, conteneur jetable).**
