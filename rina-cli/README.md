# `rina` — CLI

RINA AI depuis le shell. Pipe-friendly, scriptable, sans éditeur.

```bash
npm install -g @siliconcorerina/rina-cli
export OPENAI_API_KEY=sk-...   # ou ANTHROPIC_API_KEY / MISTRAL_API_KEY / RINA_API_KEY
```

## Commandes

```bash
rina ask "what's the difference between map and flatMap?"

# Lire un fichier
rina explain src/helpers.py
rina refactor src/legacy.py -o src/legacy.refactored.py
rina tests src/util.ts -o src/util.test.ts

# Piper depuis stdin
cat foo.py | rina explain --stdin
git diff main | rina ask "résume ces changements"

# Changer le backend / la langue
rina --backend anthropic:claude-3-5-haiku-latest ask "..."
rina --lang fr explain script.sh

# Variables d'env pour ne pas répéter à chaque appel
export RINA_BACKEND=mistral:codestral-latest
export RINA_LANG=fr
rina ask "explique async/await"
```

## Backends supportés

Même grammaire que côté Python (`evaluation/_utils/backend.py`) et côté LSP server.

| Spec | Provider | Clé d'API requise |
|---|---|---|
| `openai:<model>` | OpenAI Chat Completions | `OPENAI_API_KEY` |
| `anthropic:<model>` | Anthropic Messages | `ANTHROPIC_API_KEY` |
| `mistral:<model>` | Mistral Chat Completions | `MISTRAL_API_KEY` |
| `rina:<base-url>` | API RINA AI (OpenAI-compat, bientôt) | `RINA_API_KEY` |

Les clés viennent **toujours** de l'environnement — jamais d'un argument CLI — pour éviter de les commettre par accident dans un fichier de shell history.

## Cas d'usage

### One-shot questions
```bash
rina ask "what does `np.einsum('ij,jk', a, b)` do?"
```
Rapide, pas besoin d'ouvrir un navigateur.

### Audit de code en batch
```bash
for f in src/**/*.py; do
    rina explain "$f" >> docs/code-audit.md
    echo "" >> docs/code-audit.md
done
```

### Génération de tests à la chaîne
```bash
for f in src/lib/*.ts; do
    rina tests "$f" -o "test/$(basename $f .ts).test.ts"
done
```

### Refactor de fichiers legacy
```bash
rina refactor src/old_module.py -o src/old_module.refactored.py
diff src/old_module.py src/old_module.refactored.py
```

### Pipe avec d'autres outils
```bash
git diff HEAD~10..HEAD | rina ask "résume ces changements en 3 puces"
```

## Pourquoi un CLI en plus d'un LSP server ?

| Besoin | Outil |
|---|---|
| Code dans un éditeur LSP-aware (Neovim, Helix, Zed, Sublime, Emacs, JupyterLab) | [`lsp-server`](../lsp-server/) |
| Code dans VS Code (ou Cursor / Windsurf) | [`vscode-extension`](../vscode-extension/) |
| Shell, scripts, CI, batch | `rina-cli` (vous êtes ici) |

Les trois partagent les **mêmes backends** et les **mêmes prompts** — un `rina explain` produit la même chose qu'un `RINA AI: Explain` dans ton éditeur.

## Développement

```bash
npm install
npm run build       # tsc strict → out/
npm test            # vitest (59 tests)
node out/cli.js --version
```

## Licence

MIT — voir [LICENSE](../LICENSE).
