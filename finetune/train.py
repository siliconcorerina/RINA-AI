"""Script d'entrainement LoRA / full fine-tuning pour RINA AI.

Usage:
    python finetune/train.py --config finetune/configs/lora_default.yaml

Le YAML pilote tout (modele, donnees, hyperparametres, LoRA, logging).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="RINA AI fine-tuning entry point")
    p.add_argument("--config", required=True, help="Chemin vers le YAML de config")
    p.add_argument("--dry-run", action="store_true", help="Valider la config sans entrainer")
    return p.parse_args()


def load_yaml(path: Path) -> dict[str, Any]:
    try:
        import yaml
    except ImportError as e:
        print("PyYAML manquant : pip install pyyaml", file=sys.stderr)
        raise SystemExit(1) from e
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def format_example(example: dict, tokenizer, max_length: int) -> dict:
    """Convertit un example {prompt, completion} ou {messages: [...]} en input_ids."""
    if "messages" in example:
        text = tokenizer.apply_chat_template(
            example["messages"], tokenize=False, add_generation_prompt=False
        )
    elif "prompt" in example and "completion" in example:
        text = example["prompt"] + example["completion"]
    else:
        raise ValueError(
            "Chaque exemple doit avoir soit (prompt + completion), soit messages[]"
        )

    enc = tokenizer(
        text,
        max_length=max_length,
        truncation=True,
        padding=False,
        return_tensors=None,
    )
    enc["labels"] = enc["input_ids"].copy()
    return enc


def main() -> int:
    args = parse_args()
    cfg = load_yaml(Path(args.config))

    # Validation minimale du schema
    for required in ("model", "data", "training"):
        if required not in cfg:
            print(f"Cle manquante dans la config : {required}", file=sys.stderr)
            return 1

    if args.dry_run:
        print("Config OK :")
        print(json.dumps(cfg, indent=2, ensure_ascii=False))
        return 0

    try:
        import torch
        from datasets import load_dataset
        from transformers import (
            AutoModelForCausalLM,
            AutoTokenizer,
            DataCollatorForLanguageModeling,
            Trainer,
            TrainingArguments,
        )
    except ImportError:
        print("Manquant : pip install -r requirements.txt", file=sys.stderr)
        return 1

    model_cfg = cfg["model"]
    data_cfg = cfg["data"]
    train_cfg = cfg["training"]
    lora_cfg = cfg.get("lora")

    print(f"[RINA-Train] Chargement du tokenizer : {model_cfg['base']}")
    tokenizer = AutoTokenizer.from_pretrained(
        model_cfg["base"],
        trust_remote_code=model_cfg.get("trust_remote_code", False),
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    print(f"[RINA-Train] Chargement du modele")
    model = AutoModelForCausalLM.from_pretrained(
        model_cfg["base"],
        torch_dtype=torch.bfloat16 if train_cfg.get("bf16") else torch.float32,
        trust_remote_code=model_cfg.get("trust_remote_code", False),
    )

    if lora_cfg:
        try:
            from peft import LoraConfig, TaskType, get_peft_model
        except ImportError:
            print("peft manquant : pip install peft", file=sys.stderr)
            return 1

        peft_config = LoraConfig(
            r=lora_cfg.get("r", 16),
            lora_alpha=lora_cfg.get("alpha", 32),
            lora_dropout=lora_cfg.get("dropout", 0.05),
            target_modules=lora_cfg.get("target_modules"),
            bias="none",
            task_type=TaskType.CAUSAL_LM,
        )
        model = get_peft_model(model, peft_config)
        model.print_trainable_parameters()

    print("[RINA-Train] Chargement des donnees")
    data_files: dict[str, str] = {"train": data_cfg["train_file"]}
    if data_cfg.get("eval_file"):
        data_files["validation"] = data_cfg["eval_file"]
    raw = load_dataset("json", data_files=data_files)

    max_length = int(data_cfg.get("max_length", 2048))
    tokenized = raw.map(
        lambda ex: format_example(ex, tokenizer, max_length),
        remove_columns=raw["train"].column_names,
        desc="Tokenization",
    )

    training_args = TrainingArguments(
        output_dir=train_cfg["output_dir"],
        num_train_epochs=train_cfg.get("num_train_epochs", 3),
        per_device_train_batch_size=train_cfg.get("per_device_train_batch_size", 4),
        gradient_accumulation_steps=train_cfg.get("gradient_accumulation_steps", 1),
        learning_rate=float(train_cfg.get("learning_rate", 2e-4)),
        warmup_ratio=float(train_cfg.get("warmup_ratio", 0.03)),
        lr_scheduler_type=train_cfg.get("lr_scheduler_type", "cosine"),
        logging_steps=int(train_cfg.get("logging_steps", 10)),
        save_strategy=train_cfg.get("save_strategy", "epoch"),
        eval_strategy=train_cfg.get("evaluation_strategy", "no"),
        bf16=bool(train_cfg.get("bf16", False)),
        report_to=cfg.get("logging", {}).get("report_to", "none"),
        run_name=cfg.get("logging", {}).get("run_name"),
    )

    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tokenized["train"],
        eval_dataset=tokenized.get("validation"),
        tokenizer=tokenizer,
        data_collator=collator,
    )

    print("[RINA-Train] Demarrage de l entrainement")
    trainer.train()

    print(f"[RINA-Train] Sauvegarde dans {train_cfg['output_dir']}")
    trainer.save_model(train_cfg["output_dir"])
    tokenizer.save_pretrained(train_cfg["output_dir"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
