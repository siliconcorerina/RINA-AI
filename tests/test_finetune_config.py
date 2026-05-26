"""Test du chargement de la config YAML de fine-tuning."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_dry_run_default_config():
    """`finetune/train.py --dry-run` doit valider la config sans crash."""
    result = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "finetune" / "train.py"),
            "--config",
            str(REPO_ROOT / "finetune" / "configs" / "lora_default.yaml"),
            "--dry-run",
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"
    assert "Config OK" in result.stdout


def test_dry_run_missing_required_key(tmp_path: Path):
    """La validation echoue si une cle obligatoire est absente."""
    bad_cfg = tmp_path / "bad.yaml"
    bad_cfg.write_text("model:\n  base: foo\n", encoding="utf-8")  # manque data + training

    result = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "finetune" / "train.py"),
            "--config",
            str(bad_cfg),
            "--dry-run",
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 1
    assert "manquante" in result.stderr.lower() or "missing" in result.stderr.lower()
