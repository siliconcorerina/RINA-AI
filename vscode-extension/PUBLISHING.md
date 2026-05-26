# Publier l'extension RINA AI sur le VS Code Marketplace

Guide pas-à-pas pour publier `siliconcore.rina-ai-vscode` sur https://marketplace.visualstudio.com.

## 1. Prérequis (une fois)

### a) Compte publisher

Le publisher `siliconcore` doit exister sur le Marketplace.

1. Aller sur https://marketplace.visualstudio.com/manage
2. Se connecter avec le compte Microsoft lié à Azure DevOps
3. Si le publisher n'existe pas encore : **Create Publisher** → ID `siliconcore`

### b) Personal Access Token (PAT) Azure DevOps

Le PAT autorise `vsce` à publier en ton nom.

1. Aller sur https://dev.azure.com/ → ton organisation
2. Icone utilisateur (en haut a droite) → **Personal access tokens**
3. **+ New Token**
   - **Name** : `vsce-publish-rina`
   - **Organization** : `All accessible organizations`
   - **Expiration** : 1 an (par exemple)
   - **Scopes** : cliquer sur **Custom defined** puis cocher **Marketplace → Publish** (cocher uniquement Publish, pas Manage)
4. **Create** et copier le token (`xxxxxxxx...`) — il ne sera plus visible apres

> Garder ce PAT secret. Si tu le partages par erreur, le revoquer immediatement et en regenerer un.

## 2. Login (une fois par token)

Depuis `vscode-extension/` :

```bash
cd vscode-extension
npx vsce login siliconcore
# Coller le PAT Azure DevOps quand il le demande
```

Si tu vois `siliconcore is now logged in.` → tout est bon.

## 3. Verification avant publication

```bash
# Compile + package en .vsix pour s'assurer que ca marche
npm run compile
npx vsce package --no-dependencies

# Lister le contenu du .vsix
npx vsce ls
```

Verifier que le `.vsix` contient :
- `extension/out/extension.js`
- `extension/package.json`
- `extension/readme.md`
- Pas de `node_modules/`, ni de fichiers sensibles

## 4. Publier

### Version actuelle (telle qu'indiquee dans package.json)

```bash
npx vsce publish --no-dependencies
```

### Bump de version automatique (recommande)

```bash
# patch : 0.0.1 → 0.0.2
npx vsce publish patch --no-dependencies

# minor : 0.0.1 → 0.1.0
npx vsce publish minor --no-dependencies

# major : 0.0.1 → 1.0.0
npx vsce publish major --no-dependencies
```

`vsce publish` met automatiquement a jour `package.json` et cree un commit.

Apres ~5-10 min, l'extension apparait sur :
https://marketplace.visualstudio.com/items?itemName=siliconcore.rina-ai-vscode

## 5. Tester l'installation

Dans VS Code :

1. `Ctrl+Shift+X` (vue Extensions)
2. Rechercher `RINA AI`
3. **Install**
4. `Ctrl+Shift+P` → `RINA AI : Definir la cle API`
5. Tester `RINA AI : Generer du code depuis un prompt`

## 6. Gestion ulterieure

### Lister tes publications
```bash
npx vsce show siliconcore.rina-ai-vscode
```

### Retirer une version (en cas de bug critique)
```bash
npx vsce unpublish siliconcore.rina-ai-vscode@0.0.2
```

### Renouveler le PAT (avant expiration)
Repeter l'etape 1.b puis `npx vsce login siliconcore` avec le nouveau PAT.

## Depannage

| Probleme | Solution |
|----------|----------|
| `Personal Access Token verification failed` | PAT invalide ou expire → en regenerer un avec le bon scope (`Marketplace → Publish`) |
| `Missing publisher name` | Lance `npx vsce login siliconcore` d'abord |
| `repository missing` warning | Deja configure dans `package.json` → ignorer ou ajouter `--allow-missing-repository` |
| `Make sure to edit the README.md before publishing` | Editer `vscode-extension/README.md` pour qu'il ne contienne plus de placeholder par defaut |
| Icone manquante | Ajouter une `icon.png` 128x128 dans le `.vsix` et reference dans `package.json` (`"icon": "icon.png"`) |

## Checklist avant publication

- [ ] `npm run compile` passe sans erreur
- [ ] `npx vsce package` produit un `.vsix` valide
- [ ] README.md de l'extension est a jour (pas de placeholder)
- [ ] `package.json` : version incrementee, description correcte, keywords pertinents
- [ ] Logo ajoute (recommande mais optionnel)
- [ ] Test manuel : installer le `.vsix` localement (`code --install-extension rina-ai-vscode-x.x.x.vsix`) et verifier que les commandes fonctionnent

## Liens utiles

- Documentation officielle vsce : https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- Marketplace manage : https://marketplace.visualstudio.com/manage
- Status page Marketplace : https://aka.ms/vsmarketplacestatus
