#!/usr/bin/env python3
"""Build a 70k Clean Core v3 runtime catalog with zero known synthetic faces.

Synthetic Humans FACS is useful for defining and testing isolated facial-action
classes, but its rendered people must never become visible runtime candidates.
This wrapper keeps the strict single-factor classifier and diversity selection,
filters known CG/synthetic sources before selection, and records a physical
zero-synthetic receipt after the catalog is packed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import clean_core_policy_v3 as policy
import build_clean_core_v3 as builder
import run_build_clean_core_v3_repair as repair

# Important: repair imports the shared policy module and applies the verified-
# FACS release gates. Reapply the natural-photo gates *after* importing repair,
# otherwise its mouthSlightOpen=240 override silently wins and blocks the
# real-photo build even when the physical 70k catalog is valid.
REAL_ONLY_PROFILE_MINIMUMS = {
    "winkLeft": 4,
    "winkRight": 4,
    "blink": 200,
    "eyesWide": 1,
    "gazeUp": 100,
    "gazeDown": 100,
    "gazeLeft": 100,
    "gazeRight": 100,
    "browsUp": 100,
    "browsDown": 100,
    "noseSneer": 0,
    "mouthSlightOpen": 5,
    "mouthOpen": 20,
    "smileClosed": 400,
    "smileOpen": 20,
    "mouthRound": 1,
    "mouthPucker": 150,
    "mouthWide": 20,
    "mouthPress": 150,
    "mouthRoll": 20,
    "mouthLeft": 1,
    "mouthRight": 1,
    "mouthFrown": 8,
    "mouthShrug": 80,
    "mouthUpperUp": 20,
    "mouthLowerDown": 20,
}

REAL_ONLY_PROFILE_POSE_CELL_MINIMUMS = {
    "winkLeft": 2,
    "winkRight": 2,
    "blink": 20,
    "eyesWide": 1,
    "gazeUp": 25,
    "gazeDown": 25,
    "gazeLeft": 25,
    "gazeRight": 25,
    "browsUp": 18,
    "browsDown": 18,
    "noseSneer": 0,
    "mouthSlightOpen": 3,
    "mouthOpen": 15,
    "smileClosed": 60,
    "smileOpen": 18,
    "mouthRound": 1,
    "mouthPucker": 25,
    "mouthWide": 10,
    "mouthPress": 25,
    "mouthRoll": 10,
    "mouthLeft": 1,
    "mouthRight": 1,
    "mouthFrown": 4,
    "mouthShrug": 12,
    "mouthUpperUp": 8,
    "mouthLowerDown": 8,
}

REAL_ONLY_PROFILE_CELL_LIMITS = {
    "eyesWide": 64,
    "noseSneer": 32,
    "mouthRound": 40,
    "mouthSlightOpen": 64,
    "mouthWide": 48,
    "mouthFrown": 40,
}

policy.PROFILE_MINIMUMS.update(REAL_ONLY_PROFILE_MINIMUMS)
policy.PROFILE_POSE_CELL_MINIMUMS.update(REAL_ONLY_PROFILE_POSE_CELL_MINIMUMS)
policy.PROFILE_CELL_LIMITS.update(REAL_ONLY_PROFILE_CELL_LIMITS)

SYNTHETIC_MARKERS = (
    "verified-synthetic-facs",
    "synthetic humans facs",
    "synthetic-humans-facs",
    "clean-v3-facs",
    "computer-generated",
    "computer generated",
    "3d render",
    "3d-render",
    "3d model",
    "virtual human",
    "metahuman",
    "cgi portrait",
    "cg portrait",
)

EXCLUDED: dict[str, int] = {}


def entry_text(source: Any, entry: dict[str, Any]) -> str:
    values = (
        getattr(source, "label", ""),
        getattr(source, "catalog_id", ""),
        entry.get("sourceKind", ""),
        entry.get("sourceCatalogId", ""),
        entry.get("sourceName", ""),
        entry.get("name", ""),
        entry.get("title", ""),
    )
    return " ".join(str(value).lower() for value in values if value is not None)


def synthetic_reason(source: Any, entry: dict[str, Any]) -> str | None:
    text = entry_text(source, entry)
    if entry.get("sourceKind") == "verified-synthetic-facs":
        return "verified_synthetic_facs"
    if entry.get("annotationVerified") is True and "facs" in text:
        return "verified_synthetic_facs"
    for marker in SYNTHETIC_MARKERS:
        if marker in text:
            return "known_synthetic_source"
    return None


_original_load_catalog = builder.load_catalog


def load_catalog_real_only(label: str, root: Path):
    source = _original_load_catalog(label, root)
    retained = []
    for entry in source.entries:
        reason = synthetic_reason(source, entry)
        if reason is None:
            retained.append(entry)
        else:
            EXCLUDED[reason] = EXCLUDED.get(reason, 0) + 1
    source.entries = retained
    return source


def inspect_output(catalog: Path) -> tuple[int, list[str]]:
    manifest = json.loads((catalog / "manifest.json").read_text(encoding="utf-8"))
    names = sorted({
        name
        for cell in manifest.get("cells", {}).values()
        for name in (cell.get("shards") or ([cell["shard"]] if cell.get("shard") else []))
    })
    found = 0
    samples: list[str] = []
    source_stub = type(
        "OutputSource",
        (),
        {"label": "", "catalog_id": manifest.get("catalogId", "")},
    )()
    for name in names:
        payload = json.loads((catalog / "shards" / name).read_text(encoding="utf-8"))
        for entry in payload.get("items", []):
            if synthetic_reason(source_stub, entry) is not None:
                found += 1
                if len(samples) < 20:
                    samples.append(str(entry.get("id") or ""))
    return found, samples


def main() -> int:
    builder.load_catalog = load_catalog_real_only
    builder.rank_diverse = repair.fast_rank_diverse
    result = int(builder.main())
    output = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
    if output is None or not (output / "audit.json").is_file():
        return result

    audit_path = output / "audit.json"
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    audit["runtimeImagePolicy"] = "real-photo-only-v1"
    audit["knownSyntheticCandidatesExcluded"] = dict(sorted(EXCLUDED.items()))
    audit["realOnlyProfileMinimums"] = dict(sorted(REAL_ONLY_PROFILE_MINIMUMS.items()))
    audit["realOnlyProfilePoseCellMinimums"] = dict(
        sorted(REAL_ONLY_PROFILE_POSE_CELL_MINIMUMS.items())
    )

    if result == 0:
        found, samples = inspect_output(output / "catalog")
        audit["knownSyntheticFacesSelected"] = found
        audit["knownSyntheticSelectedSamples"] = samples
        if found:
            audit["gatePassed"] = False
            audit.setdefault("gateFailures", []).append(
                f"known synthetic runtime faces selected: {found}"
            )
            result = 3
        else:
            manifest_path = output / "catalog" / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest.setdefault("stats", {}).setdefault("cleanCore", {}).update({
                "runtimeImagePolicy": "real-photo-only-v1",
                "knownSyntheticFaces": 0,
                "knownSyntheticCandidatesExcluded": sum(EXCLUDED.values()),
            })
            manifest_path.write_text(
                json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )

    audit_path.write_text(
        json.dumps(audit, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return result


if __name__ == "__main__":
    raise SystemExit(main())
