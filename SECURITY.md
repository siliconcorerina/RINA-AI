# Politique de securite — RINA AI

## Signaler une vulnerabilite

Si tu decouvres une faille de securite dans RINA AI, **merci de NE PAS ouvrir une issue publique**.

Contacte-nous directement :

- Email : [hello@plateforme-rina.com](mailto:hello@plateforme-rina.com)
- Sujet : `[Security] Description courte`

Nous accusons reception sous **72h** et te tenons informe de la progression.

## Versions supportees

Le projet est en developpement actif. Seule la branche `main` recoit des correctifs de securite pour le moment.

| Version | Supportee |
|---------|-----------|
| `main`  | Oui |
| Releases taggees | Sur demande, au cas par cas |

## Bonnes pratiques pour les utilisateurs

- **Ne jamais commiter de cle API** (`RINA_API_KEY`, token HuggingFace, etc.) dans le code source. Utiliser des variables d environnement ou `SecretStorage` (VS Code).
- Le code genere par un modele de langage peut contenir des bugs ou des failles. **Toujours relire et tester.**
- Les scripts d evaluation (`evaluation/`) executent du code arbitraire dans un sous-processus. **A executer dans un conteneur jetable ou un environnement isole.**

## Divulgation responsable

Nous suivons un modele de divulgation coordonnee :

1. Reception du rapport
2. Validation et reproduction
3. Correctif developpe en prive
4. Publication du correctif + advisory
5. Credit au reporter (sauf demande contraire)
