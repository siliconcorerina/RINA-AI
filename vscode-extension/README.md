# RINA AI — Extension VS Code

Assistant code RINA AI directement dans VS Code : explication, refactoring, generation.

> Bootstrap initial. Les commandes communiquent avec l API hebergee sur `api.plateforme-rina.com`.

## Installation (developpement)

```bash
cd vscode-extension
npm install
npm run compile
```

Puis dans VS Code : `F5` lance une fenetre Extension Development Host.

## Configuration

Apres installation, lance la palette de commandes (`Ctrl+Shift+P`) et choisis :

- **RINA AI : Definir la cle API** — enregistre la cle dans le `SecretStorage` de VS Code

Ou ouvre les Settings (`Ctrl+,`) et cherche `RINA AI` pour ajuster :
- `rinaAI.baseUrl` (defaut : `https://api.plateforme-rina.com`)
- `rinaAI.model`
- `rinaAI.temperature`
- `rinaAI.maxTokens`

## Commandes

| Commande | Usage |
|----------|-------|
| `RINA AI : Expliquer le code selectionne` | Selection -> clic droit -> "Expliquer" |
| `RINA AI : Refactorer le code selectionne` | Selection -> clic droit -> "Refactorer" |
| `RINA AI : Generer du code depuis un prompt` | Palette -> saisis un prompt |
| `RINA AI : Definir la cle API` | Palette -> colle la cle |

## Publication

```bash
npm install -g @vscode/vsce
vsce package
vsce publish
```

Voir [issue #7](https://github.com/siliconcorerina/RINA-AI/issues/7) pour le suivi.

## Licence

MIT — voir [LICENSE](../LICENSE).
