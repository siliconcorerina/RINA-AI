"""BigCodeBench runner for RINA AI.

BigCodeBench (BigCode Project, 2024) is closer to real-world software:
each task requires *practical* programming with standard libraries
(json, requests, pandas, …) and exercises both function-completion and
instruction-following abilities. Two prompt styles are available:

  - Complete  → raw function header + docstring (HumanEval-shaped).
  - Instruct  → "Implement … so that …" natural-language task.

We support both via `--prompt-style`. Default is `instruct` since most
modern assistant models behave better with explicit task descriptions;
RINA Coder Base (a completion-style model) should be evaluated with
`complete`.

Dataset (HuggingFace): bigcode/bigcodebench.

Each row gives a `test` field — a self-contained unittest.TestCase
class whose `class TestCases(unittest.TestCase): ...` runs against the
candidate's solution. We assemble a small harness, exec it under our
existing sandbox, and grade pass@k.

Usage:
    python evaluation/bigcodebench/run_eval.py \\
        --backend openai:gpt-4o \\
        --prompt-style instruct \\
        --n-samples 1 \\
        --output results/bigcodebench_gpt4o.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from evaluation._utils.backend import Backend, GenerationConfig  # noqa: E402
from evaluation._utils.sandbox import ExecResult, pass_at_k, run_python  # noqa: E402

CODE_FENCE = re.compile(r"```(?:python|py)?\s*\n(.+?)```", re.DOTALL)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="BigCodeBench runner for RINA AI")
    p.add_argument("--backend", required=True)
    p.add_argument("--prompt-style", choices=["complete", "instruct"], default="instruct")
    p.add_argument("--subset", choices=["full", "hard"], default="full", help="Which split of BigCodeBench to load")
    p.add_argument("--n-samples", type=int, default=1)
    p.add_argument("--max-new-tokens", type=int, default=2048)
    p.add_argument("--temperature", type=float, default=0.2)
    p.add_argument("--timeout", type=float, default=30.0, help="BCB tests do real I/O; default is generous.")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--output", default="results/bigcodebench.json")
    p.add_argument("--device", default="auto")
    return p.parse_args()


def extract_code(text: str) -> str:
    """Pull the largest Python code block out of a free-form model reply."""
    matches = CODE_FENCE.findall(text)
    if matches:
        return max(matches, key=len).strip()
    return text.strip()


def build_test_script(solution: str, test_source: str, entry_point: str) -> str:
    """Concatenate the candidate's code with the official test class
    and invoke unittest. We exit non-zero on any failure so the sandbox
    classifies the run as 'not passed'."""
    return f"""# AUTO-GENERATED BIGCODEBENCH HARNESS
import sys
import unittest

# --- candidate solution ---
{solution}

# --- official tests ---
{test_source}

if __name__ == "__main__":
    runner = unittest.TextTestRunner(verbosity=0, stream=open(sys.stderr.fileno(), 'w', buffering=1))
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(TestCases)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
"""


def main() -> int:
    args = parse_args()
    try:
        from datasets import load_dataset
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("`datasets` is required: pip install datasets") from exc

    config_name = "v0.1.0_hf" if args.subset == "full" else "v0.1.0_hard_hf"
    print(f"[BigCodeBench] Loading dataset (subset={args.subset})…")
    try:
        ds = load_dataset("bigcode/bigcodebench", config_name, split="v0.1.0", trust_remote_code=True)
    except Exception:
        # Fallback to the default config name BigCodeBench currently ships.
        ds = load_dataset("bigcode/bigcodebench", split="v0.1.0", trust_remote_code=True)

    if args.limit:
        ds = ds.select(range(min(args.limit, len(ds))))

    print(f"[BigCodeBench] Loading backend {args.backend}…")
    backend = Backend.from_spec(args.backend)

    config = GenerationConfig(
        max_new_tokens=args.max_new_tokens,
        temperature=args.temperature,
    )

    per_problem: list[dict] = []
    for i, problem in enumerate(ds):
        # Pick prompt by user's preferred style; fall back to the other
        # if the dataset row doesn't carry it.
        if args.prompt_style == "instruct":
            prompt = problem.get("instruct_prompt") or problem.get("complete_prompt") or ""
        else:
            prompt = problem.get("complete_prompt") or problem.get("instruct_prompt") or ""
        if not prompt:
            continue

        entry_point = problem.get("entry_point", "task_func")
        test_source = problem.get("test", "")
        if not test_source:
            continue

        correct = 0
        sample_logs: list[dict] = []
        for _ in range(args.n_samples):
            try:
                completion = backend.generate(prompt, config=config)
            except Exception as exc:  # noqa: BLE001
                sample_logs.append({"passed": False, "error": str(exc)[:200]})
                continue

            code = extract_code(completion)
            # For "complete" style, the prompt already contains the function
            # header; the model only returns the body. We re-prepend the
            # prompt so the resulting script is valid Python.
            if args.prompt_style == "complete":
                code = prompt + "\n" + code

            script = build_test_script(code, test_source, entry_point)
            result: ExecResult = run_python(script, timeout=args.timeout)
            if result.passed:
                correct += 1
            sample_logs.append(
                {"passed": result.passed, "timed_out": result.timed_out, "stderr_tail": result.stderr[-300:]}
            )

        per_problem.append(
            {
                "task_id": problem.get("task_id"),
                "entry_point": entry_point,
                "n_samples": args.n_samples,
                "n_correct": correct,
                "samples": sample_logs,
            }
        )

        print(f"[{i + 1}/{len(ds)}] {problem.get('task_id')}: {correct}/{args.n_samples}")

    n = len(per_problem)
    if n == 0:
        print("No graded problems — exiting.")
        return 1

    metrics = {
        "backend": backend.spec,
        "benchmark": f"bigcodebench-{args.subset}",
        "prompt_style": args.prompt_style,
        "n_problems": n,
        "n_samples": args.n_samples,
        "pass_at_1": sum(pass_at_k(args.n_samples, p["n_correct"], 1) for p in per_problem) / n,
    }
    if args.n_samples >= 10:
        metrics["pass_at_10"] = sum(pass_at_k(args.n_samples, p["n_correct"], 10) for p in per_problem) / n

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"metrics": metrics, "per_problem": per_problem}, indent=2),
        encoding="utf-8",
    )

    print("\n=== BigCodeBench results ===")
    for k, v in metrics.items():
        print(f"  {k}: {v}")
    print(f"Results written to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
