"""Verification statique de la structure du depot."""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_required_files_present():
    for name in ("README.md", "LICENSE", "requirements.txt", ".gitignore", "pyproject.toml"):
        assert (REPO_ROOT / name).is_file(), f"Manque : {name}"


def test_required_dirs_present():
    for name in ("evaluation", "demo", "finetune", "assets", "vscode-extension"):
        assert (REPO_ROOT / name).is_dir(), f"Manque : {name}/"


def test_eval_runners_have_main():
    for runner in (
        REPO_ROOT / "evaluation" / "humaneval" / "run_eval.py",
        REPO_ROOT / "evaluation" / "mbpp" / "run_eval.py",
        REPO_ROOT / "evaluation" / "multipl_e" / "run_eval.py",
    ):
        assert runner.is_file()
        content = runner.read_text(encoding="utf-8")
        assert "def main(" in content
        assert "__main__" in content
