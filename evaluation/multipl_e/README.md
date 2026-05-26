# MultiPL-E — RINA AI

Evaluation multi-langage des modeles RINA Coder sur les sous-ensembles MultiPL-E (HumanEval transpose dans differents langages).

## Langages supportes par ce runner

| Code | Langage | Toolchain requise |
|------|---------|-------------------|
| `rs` | Rust    | `rustc` |
| `go` | Go      | `go` |
| `kt` | Kotlin  | `kotlinc` + `java` |

## Lancement

```bash
python evaluation/multipl_e/run_eval.py \
    --model siliconcorerina/rina-coder-base \
    --language rs \
    --output results/multipl_e_rs.json
```

## Sortie

Fichier JSON avec `pass_at_1`, le langage, et un detail par probleme (avec la derniere erreur de compilation/execution si echec).

## Notes

- La toolchain de chaque langage doit etre installee et accessible dans le `PATH`.
- Le runner execute du code arbitraire genere par le modele. **A executer dans un conteneur jetable.**
- Datasets utilises : `nuprl/MultiPL-E` (sous-ensemble `humaneval-{rs,go,kt}`).
