"""Evaluation HumanEval pour RINA AI.

Usage:
    python evaluation/humaneval/run_eval.py \\
        --model siliconcorerina/rina-coder-base \\
        --n-samples 1 \\
        --output results/humaneval.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Permet d'importer evaluation._utils lorsqu'on lance le script directement
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from evaluation._utils.sandbox import ExecResult, pass_at_k, run_python  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="HumanEval runner for RINA AI")
    parser.add_argument("--model", required=True, help="HuggingFace ID ou chemin local")
    parser.add_argument("--n-samples", type=int, default=1, help="Echantillons par probleme")
    parser.add_argument("--max-new-tokens", type=int, default=512)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument(
        "--timeout", type=float, default=10.0, help="Timeout d'execution par test (s)"
    )
    parser.add_argument("--limit", type=int, default=None, help="Limiter le nombre de problemes")
    parser.add_argument("--output", default="results/humaneval.json")
    parser.add_argument("--device", default="auto")
    return parser.parse_args()


def build_test_script(problem: dict, completion: str) -> str:
    """Concatene prompt + completion + tests + appel check pour execution."""
    parts = [
        problem["prompt"],
        completion,
        "\n",
        problem["test"],
        f"\ncheck({problem['entry_point']})\n",
    ]
    return "".join(parts)


def generate_completion(model, tokenizer, prompt: str, args) -> str:
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    outputs = model.generate(
        **inputs,
        max_new_tokens=args.max_new_tokens,
        temperature=args.temperature,
        do_sample=args.temperature > 0,
        pad_token_id=tokenizer.eos_token_id,
    )
    text = tokenizer.decode(
        outputs[0][inputs["input_ids"].shape[1] :],
        skip_special_tokens=True,
    )
    # Tronquer a la premiere definition suivante (heuristique simple)
    for stop in ("\ndef ", "\nclass ", "\nif __name__"):
        idx = text.find(stop)
        if idx != -1:
            text = text[:idx]
    return text


def main() -> int:
    args = parse_args()

    try:
        from datasets import load_dataset
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError:
        print("Manquant : pip install -r requirements.txt", file=sys.stderr)
        return 1

    print("[HumanEval] Chargement du dataset openai_humaneval")
    ds = load_dataset("openai_humaneval", split="test")
    if args.limit:
        ds = ds.select(range(min(args.limit, len(ds))))

    print(f"[HumanEval] Chargement du modele {args.model}")
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(args.model, device_map=args.device)

    per_problem: list[dict] = []
    total_correct = 0
    total_attempts = 0

    for i, problem in enumerate(ds):
        correct = 0
        samples_log = []
        for _ in range(args.n_samples):
            completion = generate_completion(model, tokenizer, problem["prompt"], args)
            script = build_test_script(problem, completion)
            result: ExecResult = run_python(script, timeout=args.timeout)
            if result.passed:
                correct += 1
            samples_log.append(
                {
                    "passed": result.passed,
                    "timed_out": result.timed_out,
                    "stderr_tail": result.stderr[-300:],
                }
            )

        per_problem.append(
            {
                "task_id": problem["task_id"],
                "n_samples": args.n_samples,
                "n_correct": correct,
                "samples": samples_log,
            }
        )
        total_correct += correct
        total_attempts += args.n_samples
        print(f"[{i + 1}/{len(ds)}] {problem['task_id']} : " f"{correct}/{args.n_samples} passes")

    metrics = {
        "model": args.model,
        "n_problems": len(ds),
        "n_samples": args.n_samples,
        "pass_at_1": sum(pass_at_k(args.n_samples, p["n_correct"], 1) for p in per_problem)
        / len(per_problem),
    }
    if args.n_samples >= 10:
        metrics["pass_at_10"] = sum(
            pass_at_k(args.n_samples, p["n_correct"], 10) for p in per_problem
        ) / len(per_problem)
    if args.n_samples >= 100:
        metrics["pass_at_100"] = sum(
            pass_at_k(args.n_samples, p["n_correct"], 100) for p in per_problem
        ) / len(per_problem)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"metrics": metrics, "per_problem": per_problem}, indent=2),
        encoding="utf-8",
    )

    print("\n=== Resultats HumanEval ===")
    for k, v in metrics.items():
        print(f"  {k}: {v}")
    print(f"Resultats ecrits dans {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
