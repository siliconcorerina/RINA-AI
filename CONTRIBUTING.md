# Contribuer a RINA AI

Merci de votre interet pour RINA AI. Voici comment participer.

## Avant de commencer

- Lire le [README](README.md) pour comprendre le perimetre du projet
- Parcourir les [issues ouvertes](https://github.com/siliconcorerina/RINA-AI/issues) — beaucoup sont annotees `roadmap`
- Pour une nouveaute majeure, ouvrir d abord une issue de discussion

## Workflow

1. Forker le depot
2. Creer une branche depuis `main` : `git checkout -b feat/ma-feature`
3. Faire les modifications
4. Verifier la CI localement :
   ```bash
   pip install ruff==0.5.0 pytest
   ruff check .
   ruff format --check .
   python -m compileall -q .
   pytest -q
   ```

   Ou, plus simple : installer `pre-commit` une fois et laisser les hooks faire le travail :
   ```bash
   pip install pre-commit
   pre-commit install
   ```
5. Commit avec un message clair (anglais ou francais, peu importe)
6. Ouvrir une Pull Request vers `main`

## Style de code

- Python 3.10+
- Ruff (config dans `pyproject.toml`) — lignes 100 caracteres max
- Docstrings au format Google ou NumPy

## Commits

Format suggere :

```
<type>: <resume court>

<details optionnels>
```

Types : `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.

## Issues

- Bug : decrire le contexte, la version, les etapes de reproduction
- Feature : decrire le besoin et le cas d usage
- Question : commencer par chercher dans les issues existantes

## Contact

- Email : [hello@plateforme-rina.com](mailto:hello@plateforme-rina.com)
- Site : [plateforme-rina.com](https://plateforme-rina.com)
