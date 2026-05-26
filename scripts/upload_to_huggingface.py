#!/usr/bin/env python3
"""
Upload d'un checkpoint RINA AI entraîné vers HuggingFace Hub.

Usage:
    python scripts/upload_to_huggingface.py --model-path outputs/rina-lora/final \\
                                            --repo-id siliconcorerina/rina-coder-base-v1 \\
                                            --message "RINA Coder v1 - LoRA fine-tuned"

Prérequis:
    pip install huggingface-hub torch transformers
    huggingface-cli login   # ou export HF_TOKEN=...
"""

from __future__ import annotations

import argparse
import glob
import os
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Upload RINA AI checkpoint to HuggingFace Hub")
    p.add_argument("--model-path", required=True, help="Chemin local vers le checkpoint (config.json, model.safetensors...)")
    p.add_argument("--repo-id", required=True, help="ID du depot HuggingFace (ex: siliconcorerina/rina-coder-base)")
    p.add_argument("--message", default="Update checkpoint", help="Message de commit")
    p.add_argument("--private", action="store_true", help="Depot prive sur HF")
    p.add_argument("--dry-run", action="store_true", help="Affiche les fichiers sans uploader")
    return p.parse_args()


def get_file_list(model_path: Path) -> list[Path]:
    """Liste tous les fichiers pertinents a uploader."""
    patterns = ["*.json", "*.safetensors", "*.bin", "*.py", "*.txt", "*.model", "*.yaml"]
    files: list[Path] = []
    for pattern in patterns:
        files.extend(model_path.rglob(pattern))
    # Exclure __pycache__
    files = [f for f in files if "__pycache__" not in f.parts]
    return sorted(files)


def main() -> int:
    args = parse_args()
    model_path = Path(args.model_path)

    if not model_path.is_dir():
        print(f"ERREUR : {model_path} n'est pas un dossier valide", file=sys.stderr)
        return 1

    files = get_file_list(model_path)
    total_size = sum(f.stat().st_size for f in files)

    print(f" Depot cible : {args.repo_id}")
    print(f" Dossier local : {model_path}")
    print(f" Fichiers a uploader : {len(files)} ({total_size / 1024 / 1024:.1f} Mo)")
    for f in files:
        rel = f.relative_to(model_path)
        size = f.stat().st_size
        print(f"   {rel} ({size / 1024:.1f} Ko)")

    if args.dry_run:
        print("\n[Dry-run] Aucun fichier uploade.")
        return 0

    try:
        from huggingface_hub import HfApi, create_repo
    except ImportError:
        print("ERREUR : pip install huggingface-hub", file=sys.stderr)
        return 1

    api = HfApi(token=os.environ.get("HF_TOKEN"))

    # Creer le depot si besoin
    try:
        create_repo(
            repo_id=args.repo_id,
            token=os.environ.get("HF_TOKEN"),
            private=args.private,
            exist_ok=True,
        )
        print(f"\n Depot {args.repo_id} pret")
    except Exception as e:
        print(f"AVERTISSEMENT : creation du depot : {e}", file=sys.stderr)

    # Upload
    print(f"\n Upload en cours...")
    try:
        api.upload_folder(
            repo_id=args.repo_id,
            folder_path=str(model_path),
            commit_message=args.message,
            token=os.environ.get("HF_TOKEN"),
            ignore_patterns=["__pycache__/*"],
        )
        print(f" Upload termine !")
        print(f" Voir : https://huggingface.co/{args.repo_id}")
    except Exception as e:
        print(f" ERREUR upload : {e}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
