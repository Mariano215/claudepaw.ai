# guard-sidecar/config.py
"""Configuration for the guard sidecar."""

import os
from pathlib import Path

# Server
HOST = os.getenv("GUARD_SIDECAR_HOST", "127.0.0.1")
PORT = int(os.getenv("GUARD_SIDECAR_PORT", "8099"))

# Nova-Hunting
BASE_DIR = Path(__file__).resolve().parent
DEFAULT_RULES_DIR = BASE_DIR / "rules"
NOVA_RULE_PATHS: list[str] = []
_custom_rules = os.getenv("NOVA_RULE_PATHS", "")
if _custom_rules:
    NOVA_RULE_PATHS = [p.strip() for p in _custom_rules.split(",") if p.strip()]
elif DEFAULT_RULES_DIR.exists():
    NOVA_RULE_PATHS = [str(path) for path in sorted(DEFAULT_RULES_DIR.glob("*.nov"))]
NOVA_TIMEOUT_SECONDS = 5.0

# LLM Guard thresholds
INJECTION_THRESHOLD = float(os.getenv("INJECTION_THRESHOLD", "0.8"))
TOXICITY_THRESHOLD = float(os.getenv("TOXICITY_THRESHOLD", "0.8"))
REFUSAL_THRESHOLD = float(os.getenv("REFUSAL_THRESHOLD", "0.8"))
