"""Sandbox d'execution pour les solutions de code generees.

Lance le code dans un sous-processus Python isole, avec un timeout dur.
Ne pretend pas etre une sandbox de securite : a executer dans un environnement
controle (CI, conteneur jetable).
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ExecResult:
    passed: bool
    stdout: str
    stderr: str
    timed_out: bool
    returncode: int | None


def run_python(
    code: str,
    timeout: float = 10.0,
    extra_args: list[str] | None = None,
) -> ExecResult:
    """Execute `code` dans un Python isole et renvoie le resultat.

    `passed` vaut True si le processus termine avec returncode 0 sans timeout.
    """
    extra_args = extra_args or []
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "candidate.py"
        script.write_text(code, encoding="utf-8")
        try:
            proc = subprocess.run(
                [sys.executable, str(script), *extra_args],
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=tmp,
            )
        except subprocess.TimeoutExpired as e:
            return ExecResult(
                passed=False,
                stdout=e.stdout.decode("utf-8", errors="replace") if e.stdout else "",
                stderr=e.stderr.decode("utf-8", errors="replace") if e.stderr else "",
                timed_out=True,
                returncode=None,
            )

    return ExecResult(
        passed=proc.returncode == 0,
        stdout=proc.stdout,
        stderr=proc.stderr,
        timed_out=False,
        returncode=proc.returncode,
    )


def pass_at_k(num_samples: int, num_correct: int, k: int) -> float:
    """Estimateur non biaise de pass@k (Chen et al., 2021).

    Implementation independante a partir de la formule combinatoire.
    """
    if num_samples - num_correct < k:
        return 1.0
    from math import comb

    return 1.0 - comb(num_samples - num_correct, k) / comb(num_samples, k)
