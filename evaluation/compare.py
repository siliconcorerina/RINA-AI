"""Cross-model comparison runner.

Given a list of backend specs and a benchmark, runs them all (or merges
already-computed result JSONs) and emits a comparison table — Markdown
to stdout for the README, CSV alongside it for further analysis.

Two modes:

  1. RUN MODE — execute each backend against a benchmark:

         python evaluation/compare.py \\
             --benchmark humaneval \\
             --backends hf:siliconcorerina/rina-coder-base \\
                        openai:gpt-4o-mini \\
                        anthropic:claude-3-5-haiku-latest \\
                        mistral:codestral-latest \\
             --n-samples 1 \\
             --output-dir results/compare/humaneval

  2. MERGE MODE — combine existing result files into a single table:

         python evaluation/compare.py --merge results/compare/humaneval/*.json

In both cases the output is a Markdown table you can paste into the
README, plus a `comparison.csv` for further analysis.
"""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

# Map benchmark name → (script path, CLI flag for the model/backend spec).
# Legacy runners (HumanEval, MBPP, MultiPL-E) use `--model`; the new ones
# (LiveCodeBench, BigCodeBench) use `--backend`. Encoding the flag here
# avoids forcing all runners to accept both names.
BENCHMARKS: dict[str, tuple[Path, str]] = {
    "humaneval":      (REPO_ROOT / "evaluation" / "humaneval"      / "run_eval.py", "--model"),
    "mbpp":           (REPO_ROOT / "evaluation" / "mbpp"           / "run_eval.py", "--model"),
    "livecodebench":  (REPO_ROOT / "evaluation" / "livecodebench"  / "run_eval.py", "--backend"),
    "bigcodebench":   (REPO_ROOT / "evaluation" / "bigcodebench"   / "run_eval.py", "--backend"),
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Cross-model benchmark comparison for RINA AI")
    p.add_argument("--benchmark", choices=sorted(BENCHMARKS.keys()), help="Benchmark to run (run mode)")
    p.add_argument("--backends", nargs="+", help="One or more backend specs (run mode)")
    p.add_argument("--n-samples", type=int, default=1)
    p.add_argument("--limit", type=int, default=None, help="Optional per-backend problem limit")
    p.add_argument("--output-dir", default="results/compare", help="Where individual run JSONs are saved")
    p.add_argument("--merge", nargs="+", help="Result JSON paths to merge (merge mode)")
    p.add_argument("--csv", default=None, help="Optional explicit CSV output path")
    p.add_argument("--markdown", default=None, help="Optional explicit Markdown output path")
    return p.parse_args()


def safe_filename(spec: str) -> str:
    """Backend specs contain ':' and '/' which aren't filesystem-friendly.
    Replace with '-' for use as a path component."""
    return spec.replace(":", "_").replace("/", "_").replace("\\", "_")


def run_one(benchmark: str, backend_spec: str, output_dir: Path, n_samples: int, limit: int | None) -> Path:
    """Invoke the benchmark's run_eval.py as a subprocess for isolation.

    Subprocess means a crash in one backend (OOM, KeyboardInterrupt) doesn't
    take down the whole comparison run — and Python's HF model cache is
    freed between backends instead of accumulating.
    """
    script, spec_flag = BENCHMARKS[benchmark]
    output_dir.mkdir(parents=True, exist_ok=True)
    out_file = output_dir / f"{safe_filename(backend_spec)}.json"

    cmd: list[str] = [
        sys.executable, str(script),
        spec_flag, backend_spec,
        "--n-samples", str(n_samples),
        "--output", str(out_file),
    ]
    if limit is not None:
        cmd += ["--limit", str(limit)]

    print(f"\n=== {benchmark} :: {backend_spec} ===")
    print("  " + " ".join(cmd))
    result = subprocess.run(cmd, cwd=str(REPO_ROOT), check=False)
    if result.returncode != 0:
        print(f"  ⚠ Returned exit code {result.returncode}")
    return out_file


def load_metrics(path: Path) -> dict:
    """Extract the metrics block from one result file, robust to either
    `{ "metrics": {...} }` (new) or a flat shape (legacy HumanEval JSON)."""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  ⚠ Couldn't parse {path}: {exc}")
        return {}
    return doc.get("metrics") or doc


def render_markdown(rows: list[dict]) -> str:
    """Pretty Markdown table; columns are chosen so a reader can scan the
    'who's best at what' question in one glance."""
    if not rows:
        return "_No results._"

    headers = ["Backend", "Benchmark", "Problems", "Samples", "pass@1"]
    has_p10 = any(r.get("pass_at_10") is not None for r in rows)
    has_p100 = any(r.get("pass_at_100") is not None for r in rows)
    if has_p10:
        headers.append("pass@10")
    if has_p100:
        headers.append("pass@100")

    lines = ["| " + " | ".join(headers) + " |"]
    lines.append("|" + "|".join("---" for _ in headers) + "|")

    # Sort: descending by pass@1 so the highest score is on top.
    rows_sorted = sorted(rows, key=lambda r: r.get("pass_at_1") or -1, reverse=True)
    for r in rows_sorted:
        cells = [
            r.get("backend") or r.get("model") or "?",
            r.get("benchmark") or "?",
            str(r.get("n_problems") or "?"),
            str(r.get("n_samples") or "?"),
            f"{(r.get('pass_at_1') or 0) * 100:.1f}%",
        ]
        if has_p10:
            v = r.get("pass_at_10")
            cells.append(f"{v * 100:.1f}%" if v is not None else "—")
        if has_p100:
            v = r.get("pass_at_100")
            cells.append(f"{v * 100:.1f}%" if v is not None else "—")
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def write_csv(rows: list[dict], path: Path) -> None:
    """One row per (backend, benchmark) — easy to feed into pandas later."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ["backend", "benchmark", "n_problems", "n_samples", "pass_at_1", "pass_at_10", "pass_at_100"]
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for r in rows:
            writer.writerow({
                "backend":      r.get("backend") or r.get("model") or "",
                "benchmark":    r.get("benchmark") or "",
                "n_problems":   r.get("n_problems") or "",
                "n_samples":    r.get("n_samples") or "",
                "pass_at_1":    r.get("pass_at_1") or "",
                "pass_at_10":   r.get("pass_at_10") or "",
                "pass_at_100":  r.get("pass_at_100") or "",
            })


def main() -> int:
    args = parse_args()

    if args.merge:
        # MERGE MODE
        paths = [Path(p) for p in args.merge]
        rows = [m for m in (load_metrics(p) for p in paths) if m]
    elif args.benchmark and args.backends:
        # RUN MODE
        output_dir = Path(args.output_dir)
        result_paths: list[Path] = []
        for spec in args.backends:
            result_paths.append(run_one(args.benchmark, spec, output_dir, args.n_samples, args.limit))
        rows = [m for m in (load_metrics(p) for p in result_paths) if m]
    else:
        print("Usage: --benchmark + --backends, OR --merge <files>", file=sys.stderr)
        return 2

    md = render_markdown(rows)
    print("\n" + md)

    # Sidecar files for downstream tooling
    out_md = Path(args.markdown) if args.markdown else Path(args.output_dir) / "comparison.md"
    out_csv = Path(args.csv) if args.csv else Path(args.output_dir) / "comparison.csv"
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text(md, encoding="utf-8")
    write_csv(rows, out_csv)
    print(f"\nWrote {out_md}\nWrote {out_csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
