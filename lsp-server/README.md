# RINA AI — LSP Server

Un seul serveur, tous les éditeurs. Le **Language Server Protocol** standardisé par Microsoft permet à n'importe quel éditeur compatible LSP de bénéficier des actions RINA AI : **explication**, **refactoring** et **génération** de code.

Au lieu de coder une extension par éditeur, on en écrit **une seule** — et Neovim, Helix, Zed, Sublime Text, Emacs, JupyterLab et compagnie la branchent automatiquement.

## Capacités

| LSP capability | Comportement RINA AI |
|---|---|
| `textDocument/codeAction` | Menu d'actions sur sélection : `RINA AI: Explain` / `Refactor` / `Generate tests` |
| `workspace/executeCommand` | Exécution des commandes `rina.explain`, `rina.refactor`, `rina.generateTests` |
| `textDocument/completion` | Complétion fill-in-the-middle au curseur (déclenchement manuel par défaut) |

Les actions appellent un backend d'inférence configurable — même syntaxe que `evaluation/_utils/backend.py` côté Python, donc une seule grammaire à retenir :

| Spec | Description | Clé d'API |
|---|---|---|
| `openai:<model>` | OpenAI Chat Completions | `OPENAI_API_KEY` |
| `anthropic:<model>` | Anthropic Messages | `ANTHROPIC_API_KEY` |
| `mistral:<model>` | Mistral Chat Completions | `MISTRAL_API_KEY` |
| `rina:<base-url>` | API RINA AI (OpenAI-compat, bientôt) | `RINA_API_KEY` |

Les clés sont lues dans l'environnement — **jamais** dans le fichier de config de l'éditeur, pour ne pas qu'elles atterrissent dans Git par accident.

## Installation

### Depuis npm (recommandé)

```bash
npm install -g @siliconcore/rina-lsp-server
```

Le binaire `rina-lsp` est ensuite dans le `$PATH`.

### Depuis le source

```bash
git clone https://github.com/siliconcorerina/RINA-AI.git
cd RINA-AI/lsp-server
npm install
npm run build
# Le binaire est à ./out/server.js
```

## Démarrage rapide

```bash
export OPENAI_API_KEY=sk-...     # ou ANTHROPIC_API_KEY, MISTRAL_API_KEY, etc.
rina-lsp --stdio
```

Le serveur attend des messages LSP sur stdin et répond sur stdout. C'est ton éditeur qui le lance, pas toi directement — voir [CONFIGS.md](CONFIGS.md) pour la commande exacte par éditeur.

## Configuration

Le serveur lit ses options via `initializationOptions` dans le message LSP `initialize` envoyé par le client :

```json
{
  "backend": "openai:gpt-4o-mini",
  "language": "fr",
  "completion": { "enabled": true, "trigger": "manual" },
  "maxTokens": 1024,
  "temperature": 0.2
}
```

| Option | Défaut | Description |
|---|---|---|
| `backend` | `openai:gpt-4o-mini` | Backend d'inférence (voir tableau ci-dessus) |
| `language` | `en` | `en` ou `fr` — langue des prompts système |
| `completion.enabled` | `true` | Active la complétion au curseur |
| `completion.trigger` | `manual` | `manual` (Ctrl+Space) ou `auto` (sur `.`) |
| `maxTokens` | `1024` | Plafond de tokens par réponse |
| `temperature` | `0.2` | Sampling — 0.2 = code déterministe |

## Éditeurs supportés

Configuration prête-à-coller pour chaque éditeur dans [CONFIGS.md](CONFIGS.md) :

- [Neovim](./editor-configs/neovim.lua) (via nvim-lspconfig)
- [Helix](./editor-configs/helix.toml)
- [Zed](./editor-configs/zed.json)
- [Sublime Text](./editor-configs/sublime.json) (via le package LSP)
- [Emacs](./editor-configs/emacs.el) (lsp-mode ou eglot)
- [JupyterLab](./editor-configs/jupyterlab.md) (via jupyterlab-lsp)

## Développement

```bash
npm install
npm run build       # compile TypeScript → out/
npm test            # vitest (31 tests)
npm run test:watch  # mode watch
```

## Architecture

```
lsp-server/
├── src/
│   ├── server.ts      # entry point + LSP handlers
│   ├── backend.ts     # abstraction OpenAI / Anthropic / Mistral / RINA
│   ├── prompts.ts     # builders FR/EN + extraction code fenced
│   └── config.ts      # parsing initializationOptions
├── test/              # vitest (31 tests)
├── editor-configs/    # exemples prêts à coller
└── out/               # compiled output (publié sur npm)
```

## Licence

MIT — voir [LICENSE](../LICENSE).
