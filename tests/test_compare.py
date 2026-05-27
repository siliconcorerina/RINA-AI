"""Unit tests for the comparison rendering + merging logic.

We avoid invoking real benchmarks (those take minutes and need GPUs or
API keys) and only test the pure-function bits: safe filename mapping,
metrics loading from JSON, Markdown table rendering, CSV emission.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from evaluation.compare import (
    BENCHMARKS,
    load_metrics,
    render_markdown,
    safe_filename,
    write_csv,
)


def test_benchmarks_registry_paths_exist():
    for name, (script, flag) in BENCHMARKS.items():
        assert script.exists(), f"{name} runner missing at {script}"
        assert flag in {"--model", "--backend"}, f"{name} declared unknown spec flag {flag!r}"


def test_safe_filename_strips_separators():
    assert safe_filename("hf:siliconcorerina/rina-coder-base") == "hf_siliconcorerina_rina-coder-base"
    assert safe_filename("openai:gpt-4o") == "openai_gpt-4o"
    assert safe_filename("anthropic:claude-3-5-sonnet") == "anthropic_claude-3-5-sonnet"


def test_load_metrics_new_shape(tmp_path: Path):
    """New runners (LiveCodeBench, BigCodeBench) wrap output as
    {metrics: {...}, per_problem: [...]}; loader should reach into
    `metrics`."""
    p = tmp_path / "r.json"
    p.write_text(
        json.dumps(
            {
                "metrics": {"backend": "openai:gpt-4o", "benchmark": "humaneval", "pass_at_1": 0.85},
                "per_problem": [],
            }
        )
    )
    m = load_metrics(p)
    assert m["pass_at_1"] == 0.85
    assert m["backend"] == "openai:gpt-4o"


def test_load_metrics_legacy_shape(tmp_path: Path):
    """Old runners write the metrics at the top level; loader should
    fall back to the raw document."""
    p = tmp_path / "r.json"
    p.write_text(json.dumps({"model": "rina-coder-base", "pass_at_1": 0.5, "n_problems": 164}))
    m = load_metrics(p)
    assert m["pass_at_1"] == 0.5
    assert m["model"] == "rina-coder-base"


def test_load_metrics_unreadable_returns_empty(tmp_path: Path):
    p = tmp_path / "missing.json"
    assert load_metrics(p) == {}

    p2 = tmp_path / "bad.json"
    p2.write_text("not json")
    assert load_metrics(p2) == {}


def test_render_markdown_empty_rows():
    assert "No results" in render_markdown([])


def test_render_markdown_sorted_by_pass_at_1():
    rows = [
        {"backend": "rina", "benchmark": "humaneval", "n_problems": 164, "n_samples": 1, "pass_at_1": 0.40},
        {"backend": "gpt-4o", "benchmark": "humaneval", "n_problems": 164, "n_samples": 1, "pass_at_1": 0.85},
        {"backend": "codestral", "benchmark": "humaneval", "n_problems": 164, "n_samples": 1, "pass_at_1": 0.78},
    ]
    md = render_markdown(rows)
    lines = md.splitlines()
    # First data row (line 2) should be the top scorer.
    assert "gpt-4o" in lines[2]
    assert "codestral" in lines[3]
    assert "rina" in lines[4]


def test_render_markdown_pass_at_10_only_appears_if_present():
    rows = [
        {"backend": "a", "benchmark": "x", "n_problems": 1, "n_samples": 1, "pass_at_1": 0.5},
        {"backend": "b", "benchmark": "x", "n_problems": 1, "n_samples": 10, "pass_at_1": 0.6, "pass_at_10": 0.8},
    ]
    md = render_markdown(rows)
    assert "pass@10" in md
    # Row "a" doesn't have pass@10 → cell should be an em dash.
    assert "—" in md


def test_write_csv_round_trip(tmp_path: Path):
    rows = [
        {"backend": "rina", "benchmark": "humaneval", "n_problems": 164, "n_samples": 1, "pass_at_1": 0.40},
        {
            "backend": "gpt-4o",
            "benchmark": "humaneval",
            "n_problems": 164,
            "n_samples": 10,
            "pass_at_1": 0.85,
            "pass_at_10": 0.91,
        },
    ]
    out = tmp_path / "x.csv"
    write_csv(rows, out)
    with out.open(encoding="utf-8") as fh:
        loaded = list(csv.DictReader(fh))
    assert len(loaded) == 2
    by_backend = {r["backend"]: r for r in loaded}
    assert by_backend["gpt-4o"]["pass_at_10"] == "0.91"
    # Missing values stay empty rather than coercing to "None".
    assert by_backend["rina"]["pass_at_10"] == ""
