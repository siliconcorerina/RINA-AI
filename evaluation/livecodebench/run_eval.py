"""LiveCodeBench runner for RINA AI.

LiveCodeBench is a code-generation benchmark with contest-style problems
released on a rolling basis (LeetCode, Codeforces, …). Because the
problems keep getting added, it's much harder for any given model to be
"contaminated" with the test data than HumanEval/MBPP.

Dataset (HuggingFace):
    livecodebench/code_generation_lite  — ~400 problems, lighter loader.

Each problem comes with:
    question_id, question_title, question_content, starter_code,
    difficulty, public_test_cases, private_test_cases, platform.

`*_test_cases` are JSON arrays of {input, output} pairs. Public tests
are shown to the model in the prompt; private tests are the grading
signal. This runner uses both at grading time (so a model can't cheat
by hardcoding only the visible answers).

Usage:
    python evaluation/livecodebench/run_eval.py \\
        --backend hf:siliconcorerina/rina-coder-base \\
        --n-samples 1 \\
        --output results/livecodebench.json

The script is intentionally minimal — for hard contest problems it
matches a backend on Python solutions only and skips problems without
runnable Python tests. It's not a replacement for the official LCB
toolchain; it's a quick consistency check that lets RINA AI plug into
the same comparison table as HumanEval/MBPP.
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


PROMPT_TEMPLATE = """You are an expert Python programmer. Solve the following programming problem.

## Problem
{title}

{content}

## Starter code
```python
{starter_code}
```

## Public examples
{examples}

Write ONLY the full Python solution that satisfies the test cases. Return a code block.
"""


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="LiveCodeBench runner for RINA AI")
    p.add_argument("--backend", required=True, help="Backend spec, e.g. hf:siliconcorerina/rina-coder-base or openai:gpt-4o")
    p.add_argument("--n-samples", type=int, default=1)
    p.add_argument("--max-new-tokens", type=int, default=2048)
    p.add_argument("--temperature", type=float, default=0.2)
    p.add_argument("--timeout", type=float, default=15.0)
    p.add_argument("--limit", type=int, default=None, help="Limit the number of problems (debug)")
    p.add_argument("--difficulty", choices=["easy", "medium", "hard"], default=None, help="Filter by difficulty")
    p.add_argument("--output", default="results/livecodebench.json")
    p.add_argument("--device", default="auto", help="HF backend device hint")
    return p.parse_args()


# Matches a fenced Python code block. Used to extract the solution from
# chat-style backends that wrap their answers in ```python ... ```.
CODE_FENCE = re.compile(r"```(?:python|py)?\s*\n(.+?)```", re.DOTALL)


def extract_code(text: str) -> str:
    """Return the most plausible Python code block from a free-form answer.

    Chat models often add prose around the code; HF completion models
    typically just return raw code. We try fenced blocks first, falling
    back to the raw response.
    """
    matches = CODE_FENCE.findall(text)
    if matches:
        # If the model emits several blocks, the longest one is almost
        # always the full solution.
        return max(matches, key=len).strip()
    return text.strip()


def format_examples(test_cases: list[dict]) -> str:
    """Render up to 3 input/output pairs as a human-readable block."""
    if not test_cases:
        return "(none)"
    lines: list[str] = []
    for i, t in enumerate(test_cases[:3], start=1):
        lines.append(f"Example {i}:")
        lines.append(f"  Input:  {t.get('input', '').strip()}")
        lines.append(f"  Output: {t.get('output', '').strip()}")
    return "\n".join(lines)


def build_test_harness(solution_code: str, test_cases: list[dict]) -> str:
    """Wrap the model's solution in a runnable script that exits non-zero
    on the first failing case.

    LiveCodeBench test cases are typically stdin/stdout pairs — the
    program reads stdin and we compare its stdout. The harness shells
    out via subprocess.run inside the candidate script, then compares.
    """
    test_cases_json = json.dumps(test_cases)
    return f"""# AUTO-GENERATED LIVECODEBENCH HARNESS
import json, sys, io
from contextlib import redirect_stdout, redirect_stderr

_TEST_CASES = json.loads({test_cases_json!r})

# Run each test case with the candidate solution's `main` exposed at
# module top-level. We exec the solution, then replace sys.stdin and
# capture sys.stdout for each test.
_solution_globals: dict = {{"__name__": "__candidate__"}}
exec({solution_code!r}, _solution_globals)

for idx, _case in enumerate(_TEST_CASES):
    _expected = _case.get("output", "").rstrip()
    _stdin = _case.get("input", "")

    _buf = io.StringIO()
    _orig_stdin = sys.stdin
    sys.stdin = io.StringIO(_stdin)
    try:
        with redirect_stdout(_buf), redirect_stderr(io.StringIO()):
            # Re-exec to trigger the module-level code reading stdin.
            exec({solution_code!r}, _solution_globals.copy())
    except SystemExit:
        pass
    finally:
        sys.stdin = _orig_stdin

    _actual = _buf.getvalue().rstrip()
    if _actual != _expected:
        sys.stderr.write(
            f"FAILED case {{idx}}:\\n  stdin: {{_stdin!r}}\\n  expected: {{_expected!r}}\\n  got:      {{_actual!r}}\\n"
        )
        sys.exit(1)

sys.exit(0)
"""


def main() -> int:
    args = parse_args()
    try:
        from datasets import load_dataset
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("`datasets` is required: pip install datasets") from exc

    print(f"[LiveCodeBench] Loading dataset…")
    ds = load_dataset("livecodebench/code_generation_lite", split="test", trust_remote_code=True)

    if args.difficulty:
        ds = ds.filter(lambda r: (r.get("difficulty") or "").lower() == args.difficulty)
    if args.limit:
        ds = ds.select(range(min(args.limit, len(ds))))

    print(f"[LiveCodeBench] Loading backend {args.backend}…")
    backend = Backend.from_spec(args.backend)

    config = GenerationConfig(
        max_new_tokens=args.max_new_tokens,
        temperature=args.temperature,
    )

    per_problem: list[dict] = []
    for i, problem in enumerate(ds):
        public_tests = problem.get("public_test_cases") or []
        private_tests = problem.get("private_test_cases") or []
        # Parse if they come as JSON strings (LCB stores them either way).
        if isinstance(public_tests, str):
            try:
                public_tests = json.loads(public_tests)
            except json.JSONDecodeError:
                public_tests = []
        if isinstance(private_tests, str):
            try:
                private_tests = json.loads(private_tests)
            except json.JSONDecodeError:
                private_tests = []

        grading_tests = (public_tests or []) + (private_tests or [])
        if not grading_tests:
            # No runnable tests — skip rather than count it as a free fail.
            continue

        prompt = PROMPT_TEMPLATE.format(
            title=problem.get("question_title", problem.get("question_id", "untitled")),
            content=problem.get("question_content", "").strip(),
            starter_code=problem.get("starter_code", "") or "# (write the full solution)",
            examples=format_examples(public_tests),
        )

        correct = 0
        sample_logs: list[dict] = []
        for s in range(args.n_samples):
            try:
                completion = backend.generate(prompt, config=config)
            except Exception as exc:  # noqa: BLE001 — propagating individual generation failures defeats the run
                sample_logs.append({"passed": False, "error": str(exc)[:200]})
                continue

            code = extract_code(completion)
            script = build_test_harness(code, grading_tests)
            result: ExecResult = run_python(script, timeout=args.timeout)
            if result.passed:
                correct += 1
            sample_logs.append({"passed": result.passed, "timed_out": result.timed_out, "stderr_tail": result.stderr[-300:]})

        per_problem.append({
            "task_id": problem.get("question_id"),
            "title": problem.get("question_title"),
            "difficulty": problem.get("difficulty"),
            "n_samples": args.n_samples,
            "n_correct": correct,
            "samples": sample_logs,
        })

        print(f"[{i + 1}/{len(ds)}] {problem.get('question_id')} ({problem.get('difficulty', '?')}): {correct}/{args.n_samples}")

    n = len(per_problem)
    if n == 0:
        print("No graded problems — exiting.")
        return 1

    metrics = {
        "backend": backend.spec,
        "benchmark": "livecodebench",
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

    print("\n=== LiveCodeBench results ===")
    for k, v in metrics.items():
        print(f"  {k}: {v}")
    print(f"Results written to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
