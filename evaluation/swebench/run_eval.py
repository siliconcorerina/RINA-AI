"""SWE-bench runner for RINA AI.

SWE-bench (Jimenez et al., 2024) measures whether a model can resolve a
real GitHub issue end-to-end: given the issue text, produce a patch
that, when applied to the repository at a specific commit, makes the
project's `FAIL_TO_PASS` tests pass without breaking the
`PASS_TO_PASS` ones.

Official grading is heavy: it spins up a Docker container per problem,
installs the project's exact pinned dependencies, applies the candidate
patch, and runs the relevant test suite — minutes per instance, hours
per full run. That doesn't fit cleanly inside a single benchmark
script, so we follow the same two-phase split the official leaderboard
uses:

  1. PREDICTIONS phase (this script): call the backend for each instance,
     extract a unified-diff patch, write a predictions JSON in the exact
     shape `swebench.harness` expects.
  2. GRADING phase (external `swebench` package): run the Docker harness
     against the predictions to get the real "resolved" rate:

         python -m swebench.harness.run_evaluation \\
             --predictions_path results/swebench/predictions.json \\
             --max_workers 4 \\
             --run_id rina-coder-base

Datasets supported (via `--dataset`):
  - lite      (princeton-nlp/SWE-bench_Lite)     ~300 instances, default
  - verified  (princeton-nlp/SWE-bench_Verified) ~500 instances, hand-vetted
  - full      (princeton-nlp/SWE-bench)         ~2.3k instances

Until the predictions are graded for real, we still emit a proxy metric:
`well_formed_rate` — the fraction of generations that parse as a
unified diff. This catches "model returned prose only" failures up
front so you don't burn Docker hours grading nonsense. The proxy is
*also* surfaced as `pass_at_1` so SWE-bench rows show up in the
`evaluation/compare.py` table; the `note` field flags it as a proxy so
nobody confuses it with the real resolved rate.

Usage:
    python evaluation/swebench/run_eval.py \\
        --backend openai:gpt-4o \\
        --dataset lite \\
        --n-samples 1 \\
        --output results/swebench/lite.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from evaluation._utils.backend import Backend, GenerationConfig  # noqa: E402

# Map our CLI shorthand → HuggingFace dataset id. The leaderboard uses
# these three splits and nothing else, so we don't bother accepting raw
# HF ids — it would only invite typos.
DATASETS: dict[str, str] = {
    "lite": "princeton-nlp/SWE-bench_Lite",
    "verified": "princeton-nlp/SWE-bench_Verified",
    "full": "princeton-nlp/SWE-bench",
}


PROMPT_TEMPLATE = """You are an expert software engineer fixing a real GitHub issue.

Repository: {repo}
Base commit: {base_commit}

## Issue
{problem_statement}

{hints_block}

## Your task
Produce a patch in **unified diff format** that resolves the issue
above. The patch must apply cleanly against the repository at the
given base commit.

Rules:
  * Output ONLY the patch, wrapped in a ```diff fenced block.
  * Use the standard `diff --git a/path b/path` header form.
  * Do not include explanations, just the diff.
"""


# A unified diff is the canonical SWE-bench output format. We pull the
# largest fenced block first, falling back to "anything that looks like
# a diff" in the raw response — some models forget the fence.
CODE_FENCE = re.compile(r"```(?:diff|patch)?\s*\n(.+?)```", re.DOTALL)
DIFF_HEADER = re.compile(r"^(diff --git |--- [ab]?/|\+\+\+ [ab]?/)", re.MULTILINE)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="SWE-bench runner for RINA AI")
    p.add_argument(
        "--backend", required=True, help="Backend spec, e.g. openai:gpt-4o or hf:siliconcorerina/rina-coder-base"
    )
    p.add_argument("--dataset", choices=sorted(DATASETS.keys()), default="lite")
    p.add_argument(
        "--n-samples", type=int, default=1, help="Samples per instance (only the first is kept in predictions)"
    )
    p.add_argument("--max-new-tokens", type=int, default=4096, help="Diffs can be long — default is generous")
    p.add_argument("--temperature", type=float, default=0.2)
    p.add_argument("--limit", type=int, default=None, help="Limit the number of instances (debug)")
    p.add_argument("--include-hints", action="store_true", help="Append the instance's hints_text to the prompt")
    p.add_argument("--output", default="results/swebench/swebench.json", help="Metrics + per-problem JSON")
    p.add_argument(
        "--predictions",
        default=None,
        help="Where to write the SWE-bench-format predictions JSON (default: alongside --output)",
    )
    p.add_argument("--model-name", default=None, help="Override `model_name_or_path` in the predictions file")
    p.add_argument("--device", default="auto")
    return p.parse_args()


def extract_patch(text: str) -> str:
    """Return the most plausible unified diff from a free-form response.

    Strategy: largest ```diff fenced block first (canonical when the
    model follows instructions), then the raw response if it already
    looks like a diff (model forgot the fence). Falls back to empty
    string — surfacing "no patch produced" rather than dumping prose.
    """
    blocks = CODE_FENCE.findall(text)
    if blocks:
        # Pick the largest block — when models emit multiple diffs, the
        # main one is almost always the longest.
        candidate = max(blocks, key=len).strip()
        if is_well_formed_diff(candidate):
            return candidate

    # Maybe the model emitted a raw diff without a fence.
    stripped = text.strip()
    if is_well_formed_diff(stripped):
        return stripped

    return ""


def is_well_formed_diff(text: str) -> bool:
    """Quick syntactic check — does this string look like a unified diff?

    Doesn't try to validate file paths or hunks; just checks for the
    presence of the canonical header lines that `git apply` looks for.
    Cheap proxy to filter out "model returned prose" failures before
    the (expensive) Docker grading step.
    """
    if not text:
        return False
    return bool(DIFF_HEADER.search(text))


def build_prompt(problem: dict, include_hints: bool) -> str:
    hints = problem.get("hints_text") or ""
    if include_hints and hints.strip():
        hints_block = f"## Maintainer hints\n{hints.strip()}\n"
    else:
        hints_block = ""
    return PROMPT_TEMPLATE.format(
        repo=problem.get("repo", "unknown"),
        base_commit=problem.get("base_commit", "HEAD"),
        problem_statement=problem.get("problem_statement", "").strip(),
        hints_block=hints_block,
    )


def main() -> int:
    args = parse_args()
    try:
        from datasets import load_dataset
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("`datasets` is required: pip install datasets") from exc

    dataset_id = DATASETS[args.dataset]
    print(f"[SWE-bench] Loading dataset {dataset_id}…")
    # All three splits share the `test` split name — that's the held-out
    # eval set the leaderboard scores against.
    ds = load_dataset(dataset_id, split="test")

    if args.limit:
        ds = ds.select(range(min(args.limit, len(ds))))

    print(f"[SWE-bench] Loading backend {args.backend}…")
    backend = Backend.from_spec(args.backend)

    config = GenerationConfig(
        max_new_tokens=args.max_new_tokens,
        temperature=args.temperature,
    )

    # `model_name_or_path` is the field the official harness keys on for
    # its report grouping. Defaulting to the backend spec keeps it stable
    # across reruns of the same model.
    model_name = args.model_name or backend.spec

    predictions: list[dict] = []
    per_problem: list[dict] = []

    n_with_patch = 0
    n_well_formed = 0

    for i, instance in enumerate(ds):
        instance_id = instance.get("instance_id") or instance.get("task_id") or f"row-{i}"
        prompt = build_prompt(instance, include_hints=args.include_hints)

        # We keep only the first sample in the predictions file — SWE-bench
        # is graded as a single attempt per instance. Additional samples are
        # logged so users can post-hoc choose a better one if needed.
        chosen_patch = ""
        sample_logs: list[dict] = []
        for s in range(args.n_samples):
            try:
                completion = backend.generate(prompt, config=config)
            except Exception as exc:  # noqa: BLE001 — surface the failure, don't kill the run
                sample_logs.append({"error": str(exc)[:300], "well_formed": False, "n_chars": 0})
                continue

            patch = extract_patch(completion)
            well_formed = is_well_formed_diff(patch)
            sample_logs.append(
                {
                    "well_formed": well_formed,
                    "n_chars": len(patch),
                    "raw_tail": completion[-200:],
                }
            )
            if s == 0:
                chosen_patch = patch

        if chosen_patch:
            n_with_patch += 1
        if is_well_formed_diff(chosen_patch):
            n_well_formed += 1

        predictions.append(
            {
                "instance_id": instance_id,
                "model_name_or_path": model_name,
                "model_patch": chosen_patch,
            }
        )
        per_problem.append(
            {
                "instance_id": instance_id,
                "repo": instance.get("repo"),
                "base_commit": instance.get("base_commit"),
                "n_samples": args.n_samples,
                "samples": sample_logs,
            }
        )

        status = "ok" if is_well_formed_diff(chosen_patch) else ("empty" if not chosen_patch else "malformed")
        print(f"[{i + 1}/{len(ds)}] {instance_id}: {status}")

    n = len(per_problem)
    if n == 0:
        print("No instances graded — exiting.")
        return 1

    well_formed_rate = n_well_formed / n

    # We surface the proxy *as* pass_at_1 so SWE-bench rows still slot
    # into the cross-benchmark comparison table — but the explicit `note`
    # field makes it unambiguous that this is a generation-quality proxy,
    # not the real resolved rate. Once the predictions are graded with
    # the official harness, swap pass_at_1 for the harness's number.
    metrics = {
        "backend": backend.spec,
        "benchmark": f"swebench-{args.dataset}",
        "model_name_or_path": model_name,
        "n_problems": n,
        "n_samples": args.n_samples,
        "n_with_patch": n_with_patch,
        "n_well_formed": n_well_formed,
        "well_formed_rate": well_formed_rate,
        "pass_at_1": well_formed_rate,
        "note": (
            "pass_at_1 above is a generation-quality proxy "
            "(well_formed_rate). Run the official swebench harness "
            "on the predictions JSON for the true resolved rate."
        ),
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"metrics": metrics, "per_problem": per_problem}, indent=2),
        encoding="utf-8",
    )

    pred_path = Path(args.predictions) if args.predictions else out_path.with_name("predictions.json")
    pred_path.parent.mkdir(parents=True, exist_ok=True)
    pred_path.write_text(json.dumps(predictions, indent=2), encoding="utf-8")

    print("\n=== SWE-bench predictions ===")
    for k, v in metrics.items():
        print(f"  {k}: {v}")
    print(f"\nResults JSON:     {out_path}")
    print(f"Predictions JSON: {pred_path}")
    print(
        "\nNext step (real grading, requires Docker):\n"
        f"  python -m swebench.harness.run_evaluation \\\n"
        f"      --predictions_path {pred_path} \\\n"
        f"      --max_workers 4 \\\n"
        f"      --run_id {model_name.replace(':', '_').replace('/', '_')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
