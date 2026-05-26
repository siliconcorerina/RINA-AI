# Guide d'entraînement → HuggingFace

Ce document décrit la procédure pour entraîner et publier les poids du modèle RINA Coder sur HuggingFace Hub, depuis une machine avec GPU ou depuis Google Colab.

## 1. Prérequis (côté compute)

### Machine locale (GPU)
```bash
pip install -r requirements.txt
huggingface-cli login  # token avec write access au repo siliconcorerina/*
```

### Google Colab (recommandé si pas de GPU local)
1. Ouvrir [Google Colab](https://colab.research.google.com/)
2. Runtime → Change runtime type → T4 GPU (gratuit) ou A100 (payant)
3. Cloner et lancer :

```python
!git clone https://github.com/siliconcorerina/RINA-AI.git
%cd RINA-AI
!pip install -r requirements.txt
```

## 2. Entraînement LoRA

```bash
python finetune/train.py --config finetune/configs/lora_default.yaml
```

Pour adapter le modèle de base (ex: `deepseek-ai/deepseek-coder-1.3b-base`), modifier le YAML :

```yaml
model:
  base: deepseek-ai/deepseek-coder-1.3b-base   # modèle de base
  trust_remote_code: false

data:
  train_file: finetune/data/sample_train.jsonl  # remplacer par vos données
  eval_file: finetune/data/sample_eval.jsonl
  max_length: 2048

lora:
  r: 16
  alpha: 32
  dropout: 0.05
  target_modules:
    - q_proj
    - k_proj
    - v_proj
    - o_proj

training:
  output_dir: outputs/rina-lora               # dossier de sortie
  num_train_epochs: 3
  per_device_train_batch_size: 4
  gradient_accumulation_steps: 4
  learning_rate: 2.0e-4
  bf16: true                                    # mettre false si pas de GPU Ampere+

logging:
  report_to: none                               # ou "wandb" si compte Weights & Biases
  run_name: rina-coder-lora-v1
```

### Format des données

Chaque ligne du JSONL doit être :

```json
{"prompt": "def fibonacci(n):\n    ", "completion": "if n <= 1: return n\n    return fibonacci(n-1) + fibonacci(n-2)\n"}
```

Ou format messages :

```json
{"messages": [{"role": "user", "content": "Write a Python function..."}, {"role": "assistant", "content": "def ..."}]}
```

## 3. Fusion LoRA → modèle complet (optionnel)

Si vous voulez exporter le modèle fusionné (sans adapter LoRA séparé) :

```python
from peft import PeftModel
from transformers import AutoModelForCausalLM

base = AutoModelForCausalLM.from_pretrained("deepseek-ai/deepseek-coder-1.3b-base")
model = PeftModel.from_pretrained(base, "outputs/rina-lora/final")
merged = model.merge_and_unload()
merged.save_pretrained("outputs/rina-coder-merged")
```

## 4. Upload vers HuggingFace

```bash
# Upload du modèle LoRA (adaptateur seul)
python scripts/upload_to_huggingface.py \
    --model-path outputs/rina-lora/final \
    --repo-id siliconcorerina/rina-coder-base \
    --message "RINA Coder LoRA v1 - fine-tuned on [dataset]"

# Ou upload du modèle fusionné
python scripts/upload_to_huggingface.py \
    --model-path outputs/rina-coder-merged \
    --repo-id siliconcorerina/rina-coder-base \
    --message "RINA Coder v1 - merged checkpoint"
```

### Alternative : upload manuel

```python
from huggingface_hub import HfApi

api = HfApi()
api.upload_folder(
    folder_path="outputs/rina-lora/final",
    repo_id="siliconcorerina/rina-coder-base",
    commit_message="RINA Coder v1 - LoRA checkpoint",
)
```

## 5. Vérification

Une fois uploadé, tester :

```python
from transformers import pipeline

pipe = pipeline("text-generation", model="siliconcorerina/rina-coder-base")
print(pipe("def fibonacci(n):", max_new_tokens=50)[0]["generated_text"])
```

## 6. Mettre à jour la model card

Après upload, éditer la model card sur [huggingface.co/siliconcorerina/rina-coder-base](https://huggingface.co/siliconcorerina/rina-coder-base) :
- Remplacer "Placeholder" par les métriques réelles (loss, perplexité)
- Ajouter les benchmarks HumanEval/MBPP si disponibles
- Mettre le badge de statut à jour
