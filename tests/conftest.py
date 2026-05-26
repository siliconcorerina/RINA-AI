"""Configuration partagee pytest pour RINA AI."""

from __future__ import annotations

import sys
from pathlib import Path

# Permettre l'import d'evaluation._utils depuis la racine du projet
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
