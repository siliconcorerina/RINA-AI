# RINA AI dans JupyterLab

JupyterLab supporte LSP via l'extension [jupyterlab-lsp](https://github.com/jupyter-lsp/jupyterlab-lsp).

## Prérequis

```bash
pip install jupyterlab jupyterlab-lsp
npm install -g @siliconcorerina/rina-lsp-server
export OPENAI_API_KEY=sk-...   # ou ANTHROPIC_API_KEY / MISTRAL_API_KEY / RINA_API_KEY
```

## Configuration

Crée (ou édite) `~/.jupyter/jupyter_server_config.py` :

```python
# RINA AI LSP — enregistre rina-lsp comme language server pour Python.
# Le binaire `rina-lsp` doit être dans le PATH du processus jupyter-server.

c.LanguageServerManager.language_servers = {
    "rina-ai-lsp": {
        "version": 2,
        "argv": ["rina-lsp", "--stdio"],
        "languages": ["python"],
        "mime_types": ["text/x-python"],
        "display_name": "RINA AI",
        # Optional: tune the backend here. JupyterLab forwards this as
        # initializationOptions to the LSP server.
        "config_schema": {
            "default_settings": {
                "backend": "openai:gpt-4o-mini",
                "language": "fr",
                "completion": {"enabled": True, "trigger": "manual"},
            }
        },
    }
}
```

## Usage

1. Lance JupyterLab : `jupyter lab`
2. Ouvre un notebook Python
3. Dans une cellule, sélectionne du code
4. **Clic droit → Show Code Actions** (ou la palette de commandes)
5. Choisis **RINA AI: Explain / Refactor / Generate tests**

## Vérifier que le LSP est attaché

Menu **Help → Show Language Servers** : tu dois voir `rina-ai-lsp` dans la liste avec un état "running".

## Notes spécifiques notebook

- Les notebooks sont gradés cellule par cellule par jupyterlab-lsp. Les actions RINA AI s'appliquent au contenu de la cellule courante.
- Pour générer des tests sur une fonction, sélectionne la définition complète (depuis `def` jusqu'à la dernière ligne du corps).
- La complétion auto (`completion.trigger = "auto"`) peut être bruyante dans un contexte notebook — préfère `manual` (Ctrl+Espace).

## Dépannage

**Le serveur n'apparaît pas dans la liste des LSP**
- Vérifie que `rina-lsp` est dans le PATH du processus Python qui lance JupyterLab.
- Sur macOS, JupyterLab lancé via une icône peut ignorer le PATH de ton shell. Lance-le depuis un terminal : `jupyter lab`.

**Erreur "Backend init failed" dans les logs jupyter-server**
- Variable d'env manquante ou backend mal écrit. Vérifie `echo $OPENAI_API_KEY` dans le même shell qui lance JupyterLab.
