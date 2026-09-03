#!/usr/bin/env python3
"""Compare two fixed-video E2E reports and require exact output parity."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--require-faster", action="store_true")
    return parser.parse_args()


def read(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def final_report(payload: dict[str, Any]) -> dict[str, Any]:
    report = payload.get("finalReport")
    if not isinstance(report, dict):
        raise ValueError("E2E report has no finalReport object")
    return report


def number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def main() -> int:
    args = parse_args()
    baseline_payload = read(args.baseline)
    candidate_payload = read(args.candidate)
    baseline = final_report(baseline_payload)
    candidate = final_report(candidate_payload)

    baseline_ids = list(baseline.get("sequenceIds") or [])
    candidate_ids = list(candidate.get("sequenceIds") or [])
    failures: list[str] = []

    if not baseline_payload.get("passed") or not baseline.get("passed"):
        failures.append("baseline is not a passing browser E2E result")
    if not candidate_payload.get("passed") or not candidate.get("passed"):
        failures.append("candidate is not a passing browser E2E result")
    if not baseline_ids:
        failures.append("baseline sequence IDs are missing")
    if baseline_ids != candidate_ids:
        mismatch = next(
            (
                index
                for index, pair in enumerate(zip(baseline_ids, candidate_ids))
                if pair[0] != pair[1]
            ),
            min(len(baseline_ids), len(candidate_ids)),
        )
        failures.append(
            "ordered candidate sequence changed "
            f"at frame {mismatch} ({len(baseline_ids)} -> {len(candidate_ids)} frames)"
        )
    if baseline.get("sequenceFingerprint") != candidate.get("sequenceFingerprint"):
        failures.append("sequence fingerprint changed")
    for key in (
        "plannedFrames",
        "faceFrames",
        "sequenceFrames",
        "selectedImages",
        "outputChanges",
        "uniqueFaces",
        "imageFailures",
        "canvasNonBlank",
    ):
        if baseline.get(key) != candidate.get(key):
            failures.append(
                f"{key} changed ({baseline.get(key)!r} -> {candidate.get(key)!r})"
            )

    baseline_ms = number(baseline.get("processingMs"))
    candidate_ms = number(candidate.get("processingMs"))
    speedup = baseline_ms / candidate_ms if baseline_ms > 0 and candidate_ms > 0 else 0.0
    if args.require_faster and candidate_ms >= baseline_ms:
        failures.append(
            f"candidate is not faster ({baseline_ms:.1f}ms -> {candidate_ms:.1f}ms)"
        )

    phases = sorted(
        set((baseline.get("phaseTimingsMs") or {}).keys())
        | set((candidate.get("phaseTimingsMs") or {}).keys())
    )
    phase_comparison = {}
    for phase in phases:
        before = number((baseline.get("phaseTimingsMs") or {}).get(phase))
        after = number((candidate.get("phaseTimingsMs") or {}).get(phase))
        phase_comparison[phase] = {
            "baselineMs": before,
            "candidateMs": after,
            "speedup": before / after if before > 0 and after > 0 else 0.0,
        }

    result = {
        "schemaVersion": 1,
        "passed": not failures,
        "exactSequenceParity": baseline_ids == candidate_ids,
        "sequenceFingerprint": candidate.get("sequenceFingerprint"),
        "baselineProcessingMs": baseline_ms,
        "candidateProcessingMs": candidate_ms,
        "speedup": speedup,
        "phaseComparison": phase_comparison,
        "failures": failures,
    }
    rendered = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
