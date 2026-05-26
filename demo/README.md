# Démo — RINA AI

Exemples d'utilisation des modèles RINA AI pour des cas concrets : complétion, génération, explication de code.

## Exemples disponibles

| Fichier | Description |
|---------|-------------|
| `inference_example.py` | Inférence simple via `transformers` |
| `chat_example.py`      | *(à venir)* Conversation multi-tour |
| `api_client.py`        | *(à venir)* Client pour l'API plateforme-rina.com |

## Prérequis

```bash
pip install -r ../requirements.txt
```

## Lancer la démo

```bash
python demo/inference_example.py --prompt "Écris une fonction Python qui inverse une chaîne"
```

Pour utiliser un modèle local :

```bash
python demo/inference_example.py \
    --model /chemin/vers/modele \
    --prompt "..."
```

## Plus de démos

Pour des intégrations avancées (extension d'IDE, API REST, agents), voir [plateforme-rina.com](https://plateforme-rina.com).
