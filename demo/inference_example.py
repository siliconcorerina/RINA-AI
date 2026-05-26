"""Exemple minimal d'inférence avec un modèle RINA AI.

Usage:
    python demo/inference_example.py --prompt "Écris une fonction Python qui ..."
"""

import argparse
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Démo d'inférence RINA AI",
    )
    parser.add_argument(
        "--model",
        default="siliconcorerina/rina-coder-base",
        help="ID HuggingFace ou chemin local du modèle",
    )
    parser.add_argument(
        "--prompt",
        required=True,
        help="Prompt à envoyer au modèle",
    )
    parser.add_argument(
        "--max-new-tokens",
        type=int,
        default=256,
        help="Nombre maximum de tokens à générer",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.2,
        help="Température d'échantillonnage",
    )
    parser.add_argument(
        "--device",
        default="auto",
        help="Device cible (auto, cpu, cuda, mps)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError:
        print(
            "transformers n'est pas installé. Lance : pip install -r requirements.txt",
            file=sys.stderr,
        )
        return 1

    print(f"[RINA AI] Chargement du modèle : {args.model}")
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        device_map=args.device,
    )

    inputs = tokenizer(args.prompt, return_tensors="pt").to(model.device)

    print("[RINA AI] Génération en cours…")
    outputs = model.generate(
        **inputs,
        max_new_tokens=args.max_new_tokens,
        temperature=args.temperature,
        do_sample=args.temperature > 0,
        pad_token_id=tokenizer.eos_token_id,
    )

    generated = tokenizer.decode(
        outputs[0][inputs["input_ids"].shape[1] :],
        skip_special_tokens=True,
    )

    print("\n=== Sortie RINA AI ===")
    print(generated)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
