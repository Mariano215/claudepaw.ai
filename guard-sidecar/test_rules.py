#!/usr/bin/env python3
"""Validate repo-local Nova rules against expected attack and benign samples."""

from __future__ import annotations

import json
import contextlib
import io
import sys
from pathlib import Path

from config import NOVA_RULE_PATHS
from nova.core.parser import NovaRuleFileParser
from nova.core.scanner import NovaScanner


def build_scanner() -> NovaScanner:
    parser = NovaRuleFileParser()
    scanner = NovaScanner()

    if not NOVA_RULE_PATHS:
        raise SystemExit("No Nova rule paths configured")

    for path in NOVA_RULE_PATHS:
        with contextlib.redirect_stdout(io.StringIO()):
            rules = parser.parse_file(path)
            scanner.add_rules(rules)

    return scanner


def run() -> int:
    base_dir = Path(__file__).resolve().parent
    cases = json.loads((base_dir / "rule_test_cases.json").read_text())
    scanner = build_scanner()
    failures: list[str] = []

    for case in cases["blocked"]:
        results = scanner.scan(case["text"])
        matched_rules = {result.get("rule_name", "unknown") for result in results}
        expected_rules = set(case.get("expect_rules", []))

        if not matched_rules:
            failures.append(
                f"BLOCKED case '{case['name']}' did not trigger any rules"
            )
            continue

        missing = expected_rules - matched_rules
        if missing:
            failures.append(
                f"BLOCKED case '{case['name']}' missed expected rules: {sorted(missing)}; matched {sorted(matched_rules)}"
            )

    for case in cases["allowed"]:
        results = scanner.scan(case["text"])
        if results:
            matched_rules = sorted(result.get("rule_name", "unknown") for result in results)
            failures.append(
                f"ALLOWED case '{case['name']}' triggered rules unexpectedly: {matched_rules}"
            )

    if failures:
        print("Nova rule tests failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print(
        f"Nova rule tests passed: {len(cases['blocked'])} blocked samples, {len(cases['allowed'])} allowed samples"
    )
    print(f"Loaded {len(scanner.rules)} rules from {len(NOVA_RULE_PATHS)} files")
    return 0


if __name__ == "__main__":
    sys.exit(run())
