# guard-sidecar/ml_scanner.py
"""LLM Guard scanner wrapper for input and output classification."""

import logging
from typing import Any

from config import INJECTION_THRESHOLD, TOXICITY_THRESHOLD, REFUSAL_THRESHOLD

logger = logging.getLogger("guard-sidecar.ml")

# Scanner instances (lazy-loaded)
_input_scanners: list[Any] = []
_output_scanners: list[Any] = []
_models_loaded = False


def init_ml_scanners() -> bool:
    """Initialize LLM Guard scanners. Returns True if loaded successfully."""
    global _input_scanners, _output_scanners, _models_loaded

    try:
        from llm_guard.input_scanners import PromptInjection, InvisibleText, Toxicity as InputToxicity  # type: ignore
        from llm_guard.output_scanners import Toxicity as OutputToxicity, NoRefusal  # type: ignore

        logger.info("Loading LLM Guard input scanners...")

        _input_scanners = [
            ("PromptInjection", PromptInjection(threshold=INJECTION_THRESHOLD)),
            ("InvisibleText", InvisibleText()),
            ("Toxicity", InputToxicity(threshold=TOXICITY_THRESHOLD)),
        ]

        logger.info("Loading LLM Guard output scanners...")

        _output_scanners = [
            ("Toxicity", OutputToxicity(threshold=TOXICITY_THRESHOLD)),
            ("NoRefusal", NoRefusal(threshold=REFUSAL_THRESHOLD)),
        ]

        _models_loaded = True
        logger.info("All LLM Guard models loaded")
        return True

    except ImportError as e:
        logger.error("llm-guard not installed: %s", e)
        _models_loaded = False
        return False
    except Exception as e:
        logger.error("Failed to initialize LLM Guard: %s", e)
        _models_loaded = False
        return False


def is_ready() -> bool:
    """Check if ML models are loaded and ready."""
    return _models_loaded


def scan_input(text: str) -> dict:
    """
    Run LLM Guard input scanners on text.
    Returns: { injectionScore, toxicityScore, invisibleTextDetected, isBlocked, blocker }
    """
    if not _models_loaded:
        return {
            "injectionScore": 0.0,
            "toxicityScore": 0.0,
            "invisibleTextDetected": False,
            "isBlocked": False,
            "blocker": None,
        }

    result = {
        "injectionScore": 0.0,
        "toxicityScore": 0.0,
        "invisibleTextDetected": False,
        "isBlocked": False,
        "blocker": None,
    }

    sanitized = text
    for name, scanner in _input_scanners:
        try:
            sanitized, is_valid, risk_score = scanner.scan(sanitized)

            if name == "PromptInjection":
                result["injectionScore"] = round(risk_score, 4)
                if not is_valid:
                    result["isBlocked"] = True
                    result["blocker"] = "PromptInjection"
            elif name == "InvisibleText":
                if not is_valid:
                    result["invisibleTextDetected"] = True
                    result["isBlocked"] = True
                    result["blocker"] = result["blocker"] or "InvisibleText"
            elif name == "Toxicity":
                result["toxicityScore"] = round(risk_score, 4)
                if not is_valid:
                    result["isBlocked"] = True
                    result["blocker"] = result["blocker"] or "Toxicity"

        except Exception as e:
            logger.error("Input scanner %s failed: %s", name, e)

    return result


def scan_output(text: str, prompt: str) -> dict:
    """
    Run LLM Guard output scanners on response.
    Returns: { toxicityScore, refusalDetected, isBlocked, blocker }
    """
    if not _models_loaded:
        return {
            "toxicityScore": 0.0,
            "refusalDetected": False,
            "isBlocked": False,
            "blocker": None,
        }

    result = {
        "toxicityScore": 0.0,
        "refusalDetected": False,
        "isBlocked": False,
        "blocker": None,
    }

    sanitized = text
    for name, scanner in _output_scanners:
        try:
            sanitized, is_valid, risk_score = scanner.scan(prompt, sanitized)

            if name == "Toxicity":
                result["toxicityScore"] = round(risk_score, 4)
                if not is_valid:
                    result["isBlocked"] = True
                    result["blocker"] = "Toxicity"
            elif name == "NoRefusal":
                if not is_valid:
                    result["refusalDetected"] = True

        except Exception as e:
            logger.error("Output scanner %s failed: %s", name, e)

    return result
