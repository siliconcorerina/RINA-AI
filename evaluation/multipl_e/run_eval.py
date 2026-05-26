"""Evaluation MultiPL-E (Rust, Go, Kotlin, ...) pour RINA AI.

Usage:
    python evaluation/multipl_e/run_eval.py \\
        --model siliconcorerina/rina-coder-base \\
        --language rs \\
        --output results/multipl_e_rs.json
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


@dataclass
class LangSpec:
    name: str
    dataset_subset: str
    extension: str
    compile_cmd: list[str] | None
    run_cmd: list[str]


LANGUAGES: dict[str, LangSpec] = {
    "rs": LangSpec(
        name="Rust",
        dataset_subset="humaneval-rs",
        extension="rs",
        compile_cmd=["rustc", "{src}", "-o", "{exe}"],
        run_cmd=["{exe}"],
    ),
    "go": LangSpec(
        name="Go",
        dataset_subset="humaneval-go",
        extension="go",
        compile_cmd=None,
        run_cmd=["go", "run", "{src}"],
    ),
    "kt": LangSpec(
        name="Kotlin",
        dataset_subset="humaneval-kt",
        extension="kt",
        compile_cmd=["kotlinc", "{src}", "-include-runtime", "-d", "{jar}"],
        run_cmd=["java", "-jar", "{jar}"],
    ),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MultiPL-E runner for RINA AI")
    parser.add_argument("--model", required=True)
    parser.add_argument(
        "--language",
        required=True,
        choices=sorted(LANGUAGES.keys()),
        help="Code langage (rs, go, kt)",
    )
    parser.add_argument("--n-samples", type=int, default=1)
    parser.add_argument("--max-new-tokens", type=int, default=768)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--output", required=True)
    parser.add_argument("--device", default="auto")
    return parser.parse_args()


def execute(spec: LangSpec, source: str, timeout: float) -> tuple[bool, str]:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        src = tmp_path / f"solution.{spec.extension}"
        exe = tmp_path / ("solution.exe" if sys.platform == "win32" else "solution")
        jar = tmp_path / "solution.jar"
        src.write_text(source, encoding="utf-8")

        subst = {"src": str(src), "exe": str(exe), "jar": str(jar)}

        try:
            if spec.compile_cmd:
                cmd = [c.format(**subst) for c in spec.compile_cmd]
                compile_proc = subprocess.run(
                    cmd, capture_output=True, text=True, timeout=timeout, cwd=tmp
                )
                if compile_proc.returncode != 0:
                    return False, "compile: " + compile_proc.stderr[-300:]

            run = [c.format(**subst) for c in spec.run_cmd]
            run_proc = subprocess.run(
                run, capture_output=True, text=True, timeout=timeout, cwd=tmp
            )
            if run_proc.returncode != 0:
                return False, "run: " + run_proc.stderr[-300:]
            return True, ""
        except subprocess.TimeoutExpired:
            return False, "timeout"
        except FileNotFoundError as e:
            return False, f"missing toolchain: {e}"


def generate(model, tokenizer, prompt: str, args) -> str:
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    outputs = model.generate(
        **inputs,
        max_new_tokens=args.max_new_tokens,
        temperature=args.temperature,
        do_sample=args.temperature > 0,
        pad_token_id=tokenizer.eos_token_id,
    )
    return tokenizer.decode(
        outputs[0][inputs["input_ids"].shape[1]:],
        skip_special_tokens=True,
    )


def main() -> int:
    args = parse_args()
    spec = LANGUAGES[args.language]

    try:
        from datasets import load_dataset
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError:
        print("Manquant : pip install -r requirements.txt + datasets", file=sys.stderr)
        return 1

    print(f"[MultiPL-E/{spec.name}] Chargement du dataset")
    ds = load_dataset("nuprl/MultiPL-E", spec.dataset_subset, split="test")
    if args.limit:
        ds = ds.select(range(min(args.limit, len(ds))))

    print(f"[MultiPL-E/{spec.name}] Chargement du modele {args.model}")
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(args.model, device_map=args.device)

    per_problem = []
    for i, problem in enumerate(ds):
        prompt = problem["prompt"]
        correct = 0
        last_err = ""
        for _ in range(args.n_samples):
            completion = generate(model, tokenizer, prompt, args)
            source = prompt + completion + "\n" + problem.get("tests", "")
            ok, err = execute(spec, source, args.timeout)
            if ok:
                correct += 1
            else:
                last_err = err
        per_problem.append(
            {
                "name": problem.get("name", f"task_{i}"),
                "n_correct": correct,
                "n_samples": args.n_samples,
                "last_error": last_err,
            }
        )
        print(f"[{i + 1}/{len(ds)}] {per_problem[-1]['name']} : {correct}/{args.n_samples}")

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "model": args.model,
                "language": args.language,
                "n_problems": len(ds),
                "pass_at_1": sum(p["n_correct"] for p in per_problem)
                / (len(per_problem) * args.n_samples),
                "per_problem": per_problem,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Resultats ecrits dans {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
