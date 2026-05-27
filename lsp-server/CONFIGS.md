# Configuration par éditeur

Pour chaque éditeur, prérequis : `rina-lsp` doit être installé (`npm install -g @siliconcore/rina-lsp-server`) et la variable d'environnement de ton backend doit être positionnée (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, ou `RINA_API_KEY`).

Tous les exemples utilisent `openai:gpt-4o-mini` — remplace par ton backend préféré.

---

## Neovim (nvim-lspconfig)

Ajoute ceci à ton `init.lua` :

```lua
local lspconfig = require("lspconfig")
local configs = require("lspconfig.configs")

if not configs.rina_ai then
  configs.rina_ai = {
    default_config = {
      cmd = { "rina-lsp", "--stdio" },
      filetypes = { "python", "javascript", "typescript", "rust", "go", "java", "cpp", "c", "lua" },
      root_dir = lspconfig.util.find_git_ancestor,
      single_file_support = true,
      init_options = {
        backend = "openai:gpt-4o-mini",
        language = "fr",
        completion = { enabled = true, trigger = "manual" },
      },
    },
  }
end

lspconfig.rina_ai.setup({})
```

Bind un raccourci pour déclencher les code actions :

```lua
vim.keymap.set("v", "<leader>ai", vim.lsp.buf.code_action, { desc = "RINA AI actions" })
```

Sélectionne du code en mode visuel, puis `<leader>ai` ouvre le menu **Explain / Refactor / Generate tests**.

---

## Helix

Édite `~/.config/helix/languages.toml` :

```toml
[language-server.rina-ai]
command = "rina-lsp"
args = ["--stdio"]
[language-server.rina-ai.config]
backend = "openai:gpt-4o-mini"
language = "fr"
completion = { enabled = true, trigger = "manual" }

# Active rina-ai sur Python — duplique le bloc par langage souhaité.
[[language]]
name = "python"
language-servers = ["pylsp", "rina-ai"]
```

Helix charge les multiples LSPs en parallèle. Sélectionne du code, puis `Space + a` ouvre le menu des code actions.

---

## Zed

Édite `~/.config/zed/settings.json` :

```json
{
  "lsp": {
    "rina-ai": {
      "binary": {
        "path": "rina-lsp",
        "arguments": ["--stdio"]
      },
      "initialization_options": {
        "backend": "openai:gpt-4o-mini",
        "language": "fr",
        "completion": { "enabled": true, "trigger": "manual" }
      }
    }
  },
  "languages": {
    "Python": { "language_servers": ["rina-ai", "..."] },
    "TypeScript": { "language_servers": ["rina-ai", "..."] }
  }
}
```

Le `"..."` dit à Zed de garder les autres LSPs par défaut en plus de RINA AI.

---

## Sublime Text (package LSP)

1. Installe le package [LSP](https://packagecontrol.io/packages/LSP) via Package Control.
2. Préférences → LSP → Settings :

```json
{
  "clients": {
    "rina-ai": {
      "enabled": true,
      "command": ["rina-lsp", "--stdio"],
      "selector": "source.python | source.js | source.ts | source.rust | source.go",
      "initializationOptions": {
        "backend": "openai:gpt-4o-mini",
        "language": "fr"
      }
    }
  }
}
```

`Ctrl+Shift+P → LSP: Code Actions` après avoir sélectionné du code.

---

## Emacs (lsp-mode)

Dans ta config Emacs :

```elisp
(with-eval-after-load 'lsp-mode
  (add-to-list 'lsp-language-id-configuration '(python-mode . "python"))
  (lsp-register-client
   (make-lsp-client
    :new-connection (lsp-stdio-connection '("rina-lsp" "--stdio"))
    :activation-fn (lsp-activate-on "python" "javascript" "typescript" "rust" "go")
    :server-id 'rina-ai
    :initialization-options
    (lambda ()
      '(:backend "openai:gpt-4o-mini"
        :language "fr"
        :completion (:enabled t :trigger "manual")))
    :priority -1)))  ; -1 pour cohabiter avec le LSP principal
```

`M-x lsp-execute-code-action` après avoir sélectionné une région.

---

## Emacs (eglot)

Eglot a une syntaxe plus directe :

```elisp
(with-eval-after-load 'eglot
  (add-to-list 'eglot-server-programs
               '((python-mode typescript-mode rust-mode go-mode) .
                 ("rina-lsp" "--stdio"
                  :initializationOptions
                  (:backend "openai:gpt-4o-mini" :language "fr")))))
```

`M-x eglot-code-actions` pour ouvrir le menu.

---

## JupyterLab (jupyterlab-lsp)

1. Installe [jupyterlab-lsp](https://github.com/jupyter-lsp/jupyterlab-lsp) :

```bash
pip install jupyterlab-lsp
```

2. Édite `~/.jupyter/jupyter_server_config.py` (ou crée le fichier) :

```python
c.LanguageServerManager.language_servers = {
    "rina-ai-lsp": {
        "version": 2,
        "argv": ["rina-lsp", "--stdio"],
        "languages": ["python"],
        "mime_types": ["text/x-python"],
        "display_name": "RINA AI",
    }
}
```

3. Relance JupyterLab. Dans un notebook Python, sélectionne du code dans une cellule → clic droit → **Show Code Actions**.

---

## Cursor & autres forks VS Code

L'extension VS Code RINA AI (`vscode-extension/`) marche déjà nativement dans Cursor, Windsurf, et tout autre fork de VS Code. Pas besoin du LSP server — voir [vscode-extension/README.md](../vscode-extension/README.md).

---

## Dépannage

**Le serveur ne démarre pas / l'éditeur affiche "rina-ai server crashed"**
1. Vérifie que `rina-lsp` est dans le `$PATH` : `which rina-lsp`
2. Lance manuellement avec un faux message pour voir l'erreur :
   ```bash
   echo '' | rina-lsp --stdio
   ```
3. Vérifie la variable d'env de ton backend : `echo $OPENAI_API_KEY`

**Les commandes RINA AI ne s'affichent pas dans le menu code actions**
- Tu dois avoir une sélection non vide. Le menu n'est peuplé qu'avec du code sélectionné.

**"Backend init failed" dans les logs LSP**
- Mauvaise spec backend ou clé d'API manquante. Lance le serveur avec `--stdio` en CLI pour voir le message complet.

**Trop de requêtes / facture qui monte**
- Mets `completion.enabled: false` dans `initializationOptions`. Les code actions restent disponibles, mais la complétion auto n'appellera plus le modèle.
