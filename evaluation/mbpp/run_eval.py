"""Evaluation MBPP (Mostly Basic Python Problems) pour RINA AI.

Usage:
    python evaluation/mbpp/run_eval.py \\
        --model siliconcorerina/rina-coder-base \\
        --n-samples 1 \\
        --output results/mbpp.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from evaluation._utils.sandbox import ExecResult, pass_at_k, run_python  # noqa: E402

PROMPT_TEMPLATE = (
    "Tu es un assistant Python. Resous le probleme suivant en ecrivant uniquement le code Python.\n"
    "Probleme:\n{description}\n\n"
    "Tests qui doivent passer:\n{tests}\n\n"
    "Solution Python:\n"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MBPP runner for RINA AI")
    parser.add_argument("--model", required=True)
    parser.add_argument("--n-samples", type=int, default=1)
    parser.add_argument("--max-new-tokens", type=int, default=512)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument(
        "--split", default="test", choices=["train", "validation", "test", "prompt"]
    )
    parser.add_argument("--output", default="results/mbpp.json")
    parser.add_argument("--device", default="auto")
    return parser.parse_args()


def build_test_script(problem: dict, completion: str) -> str:
    parts = [completion, "\n"]
    for assertion in problem["test_list"]:
        parts.append(assertion + "\n")
    return "".join(parts)


def build_prompt(problem: dict) -> str:
    return PROMPT_TEMPLATE.format(
        description=problem["text"],
        tests="\n".join(problem["test_list"]),
    )


def generate_completion(model, tokenizer, prompt: str, args) -> str:
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    outputs = model.generate(
        **inputs,
        max_new_tokens=args.max_new_tokens,
        temperature=args.temperature,
        do_sample=args.temperature > 0,
        pad_token_id=tokenizer.eos_token_id,
    )
    return tokenizer.decode(
        outputs[0][inputs["input_ids"].shape[1] :],
        skip_special_tokens=True,
    )


def main() -> int:
    args = parse_args()

    try:
        from datasets import load_dataset
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError:
        print("Manquant : pip install -r requirements.txt", file=sys.stderr)
        return 1

    print(f"[MBPP] Chargement du dataset mbpp (split={args.split})")
    ds = load_dataset("mbpp", split=args.split)
    if args.limit:
        ds = ds.select(range(min(args.limit, len(ds))))

    print(f"[MBPP] Chargement du modele {args.model}")
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(args.model, device_map=args.device)

    per_problem: list[dict] = []
    for i, problem in enumerate(ds):
        prompt = build_prompt(problem)
        correct = 0
        for _ in range(args.n_samples):
            completion = generate_completion(model, tokenizer, prompt, args)
            script = build_test_script(problem, completion)
            result: ExecResult = run_python(script, timeout=args.timeout)
            if result.passed:
                correct += 1

        per_problem.append(
            {
                "task_id": problem["task_id"],
                "n_samples": args.n_samples,
                "n_correct": correct,
            }
        )
        print(f"[{i + 1}/{len(ds)}] task_id={problem['task_id']} : {correct}/{args.n_samples}")

    metrics = {
        "model": args.model,
        "split": args.split,
        "n_problems": len(ds),
        "n_samples": args.n_samples,
        "pass_at_1": sum(pass_at_k(args.n_samples, p["n_correct"], 1) for p in per_problem)
        / len(per_problem),
    }
    if args.n_samples >= 10:
        metrics["pass_at_10"] = sum(
            pass_at_k(args.n_samples, p["n_correct"], 10) for p in per_problem
        ) / len(per_problem)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"metrics": metrics, "per_problem": per_problem}, indent=2),
        encoding="utf-8",
    )

    print("\n=== Resultats MBPP ===")
    for k, v in metrics.items():
        print(f"  {k}: {v}")
    print(f"Resultats ecrits dans {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
