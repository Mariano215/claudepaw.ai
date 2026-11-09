# guard-sidecar/nova_scanner.py
"""Nova-Hunting rule scanner wrapper."""

import asyncio
import contextlib
import io
import logging
from typing import Any

from config import NOVA_RULE_PATHS, NOVA_TIMEOUT_SECONDS

logger = logging.getLogger("guard-sidecar.nova")

_nova_available = False
_nova_scanner: Any = None

def init_nova() -> bool:
    """Try to initialize Nova-Hunting. Returns True if available."""
    global _nova_available, _nova_scanner
    try:
        from nova.core.parser import NovaRuleFileParser  # type: ignore
        from nova.core.scanner import NovaScanner  # type: ignore

        _nova_scanner = NovaScanner()
        parser = NovaRuleFileParser()

        if not NOVA_RULE_PATHS:
            logger.warning("NOVA_RULE_PATHS not configured, L3 will run in degraded mode")
            _nova_available = False
            return False

        loaded_rule_count = 0
        for path in NOVA_RULE_PATHS:
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    rules = parser.parse_file(path)
                    _nova_scanner.add_rules(rules)
                loaded_rule_count += len(rules)
                logger.info("Loaded %d Nova rules from %s", len(rules), path)
            except Exception as e:
                logger.warning("Failed to load Nova rules from %s: %s", path, e)

        if loaded_rule_count == 0:
            logger.warning("No Nova rules loaded, L3 will run in degraded mode")
            _nova_available = False
            return False

        _nova_available = True
        logger.info("Nova-Hunting initialized with %d rules", loaded_rule_count)
        return True
    except ImportError:
        logger.warning("nova-hunting not installed, L3 will run in degraded mode")
        _nova_available = False
        return False
    except Exception as e:
        logger.error("Failed to initialize Nova-Hunting: %s", e)
        _nova_available = False
        return False


async def scan_nova(text: str) -> dict:
    """
    Scan text using Nova-Hunting rules.
    Returns: { rulesTriggered, severity, timedOut, error }
    """
    if not _nova_available or _nova_scanner is None:
        return {
            "rulesTriggered": [],
            "severity": "none",
            "timedOut": False,
            "error": "Nova-Hunting not available",
        }

    try:
        loop = asyncio.get_event_loop()
        result = await asyncio.wait_for(
            loop.run_in_executor(None, _nova_scanner.scan, text),
            timeout=NOVA_TIMEOUT_SECONDS,
        )

        rules_triggered = []
        severity = "none"

        if isinstance(result, list):
            rules_triggered = [r.get("rule_name", "unknown") for r in result]
        elif hasattr(result, "triggered_rules"):
            rules_triggered = [r.name for r in result.triggered_rules]
        elif isinstance(result, dict):
            rules_triggered = result.get("triggered_rules", [])

        if isinstance(result, list):
            severity = "high" if rules_triggered else "none"
        elif hasattr(result, "severity"):
            severity = str(result.severity).lower()
        elif isinstance(result, dict):
            severity = result.get("severity", "none")

        # Normalize severity
        if severity not in ("none", "low", "high"):
            severity = "low" if rules_triggered else "none"

        return {
            "rulesTriggered": rules_triggered,
            "severity": severity,
            "timedOut": False,
            "error": None,
        }

    except asyncio.TimeoutError:
        logger.warning("Nova scan timed out after %ss", NOVA_TIMEOUT_SECONDS)
        return {
            "rulesTriggered": [],
            "severity": "none",
            "timedOut": True,
            "error": "Scan timed out",
        }
    except Exception as e:
        logger.error("Nova scan error: %s", e)
        return {
            "rulesTriggered": [],
            "severity": "none",
            "timedOut": False,
            "error": str(e),
        }
