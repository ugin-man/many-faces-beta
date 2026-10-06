#!/usr/bin/env python3
"""Export bounded, exact-image diagnostics from a completed admission audit.

No inference, admission decision, source measurement, selection gate, catalog,
or Site is changed. These challenge samples are not a prevalence estimate or
visual approval. Full-pool counts distinguish source rows from encoded images.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import heapq
import io
import json
import math
import os
import shutil
import zlib
from collections import Counter, defaultdict
from dataclasses import asdict
from pathlib import Path
from typing import Any

import clean_core_admission as admission
import clean_core_policy_v2 as isolated
import clean_core_policy_v3 as current

GROUPS = ("wink-left", "wink-right", "mouth-wide", "mouth-frown")
SAMPLE_PREFIX = dict(zip(GROUPS, ("WL", "WR", "MW", "MF")))
MAX_GROUP_BYTES = 24 * 1024 * 1024
SAMPLES_PER_GROUP = 48
MAX_ARTIFACT_PARTS = 8
MAX_ARTIFACT_FILES = 1000
AUTOMATIC_WINK_GROUPS = ("wink-left", "wink-right")
POOL_PER_BUCKET = 128
SEED = "clean-core-profile-diagnostics-20261008"
SYNTHETIC_MARKERS = (
    "verified-synthetic-facs", "synthetic humans facs", "synthetic-humans-facs", "clean-v3-facs",
    "computer-generated", "computer generated", "3d render", "3d-render", "3d model",
    "virtual human", "metahuman", "cgi portrait", "cg portrait",
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(admission.json_bytes(value) + b"\n")


def synthetic_reason(entry: dict, source: dict, catalog_id: str) -> str | None:
    text = " ".join(str(value).lower() for value in (
        source["label"], catalog_id, *(entry.get(name, "") for name in
        ("sourceKind", "sourceCatalogId", "sourceName", "name", "title"))))
    if entry.get("annotationVerified") is True and "facs" in text:
        return "verified_synthetic_facs"
    return next((marker for marker in SYNTHETIC_MARKERS if marker in text), None)


def source_index(audit: admission.AdmissionAudit) -> dict[str, dict]:
    # Importing this pure name filter does not construct an inference engine or
    # import the wrapper that mutates the selection minimums.
    from build_clean_core_v3 import title_rejection
    result = {}
    for source in audit.sources:
        manifest = json.loads((Path(source["root"]) / "manifest.json").read_text())
        catalog_id = str(manifest.get("catalogId") or source["label"])
        for entry in admission.iter_catalog_entries(source["root"]):
            key = admission.source_key(catalog_id, str(entry["id"]))
            require(key not in result, "Duplicate source key during diagnostic indexing")
            result[key] = {
                "featureSha256": admission.feature_sha256(entry),
                "syntheticReason": synthetic_reason(entry, source, catalog_id),
                "artworkReason": title_rejection(entry, None),
                "sourceLabel": source["label"],
                "creatorKey": str(entry.get("creator", "")).strip().lower(),
            }
    return result


def decode_pass_record(row: tuple, audit: admission.AdmissionAudit, sources: dict) -> tuple[dict, bytes]:
    key, catalog_id, identity, digest, feature_hash, decision, record_hash, compressed = row
    require(decision == "pass" and key in sources, "Unexpected or unknown PASS source key")
    decoder = zlib.decompressobj()
    raw = decoder.decompress(compressed, 2 * 1024 * 1024 + 1)
    require(len(raw) <= 2 * 1024 * 1024 and decoder.eof and not decoder.unused_data,
            "Invalid or oversized compressed admission record")
    require(hashlib.sha256(raw).hexdigest() == record_hash, "Compressed admission record hash mismatch")
    record = json.loads(raw)
    expected = {"schemaVersion": 2, "sourceKey": key, "sourceCatalogId": catalog_id,
                "sourceId": identity, "encodedSha256": digest, "sourceFeatureSha256": feature_hash,
                "policySha256": audit.policy.sha256, "decision": "pass", "sourceLabel": sources[key]["sourceLabel"]}
    require(all(record.get(name) == value for name, value in expected.items()), "PASS record identity mismatch")
    require(admission.valid_digest(digest) and feature_hash == sources[key]["featureSha256"],
            "PASS record source feature/digest mismatch")
    require(all(record.get("checks", {}).get(name) == "pass" for name in admission.REQUIRED_CHECKS),
            "PASS record has incomplete admission checks")
    feature, layout = record.get("feature"), record.get("layout")
    require(isinstance(feature, list) and len(feature) == 55 and isinstance(layout, list) and len(layout) == 4,
            "PASS record lacks full fresh features/layout")
    require(all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
                for value in [*feature, *layout]), "Nonfinite fresh feature/layout")
    require(record.get("faceCount") == 1 and min(layout[2:]) > 0, "Missing single-face evidence")
    for index, name in enumerate(("freshYaw", "freshPitch", "freshRoll")):
        value = record.get(name)
        require(isinstance(value, (int, float)) and math.isfinite(value)
                and abs(value - feature[index] * 90) < 1e-8, "Fresh pose differs from feature: " + name)
    require(record.get("cell") == isolated.quantized_pose_cell(feature, 3)[0], "Fresh pose cell mismatch")
    for name, minimum in (("shape", 13), ("mesh", 3), ("projection", 936)):
        encoded = base64.b64decode(record.get(name, ""), validate=True)
        require(len(encoded) % 2 == 0 and len(encoded) // 2 >= minimum
                and (name != "projection" or len(encoded) == 1872), "Invalid admitted geometry: " + name)
    require(digest not in audit.controls.get("priorYawExclusions", {}), "Prior yaw denial appears in PASS pool")
    review = audit.controls.get("reviews", {}).get(digest)
    require(not review or review.get("decision") != "deny", "Known manually denied image appears in PASS pool")
    require(admission.visibility_decision(record.get("faceAttributes", []), audit.policy, review)[0] == "pass",
            "PASS visibility evidence does not permit admission")
    admission.validate_attribute_scores(record.get("fullAttributes", []))
    require(admission.image_quality_decision(record.get("imageQuality", {}),
            sources[key]["sourceLabel"] + " " + catalog_id)[0], "PASS detail evidence does not permit admission")
    return record, raw


def assignment_summary(assignment: tuple | None) -> dict | None:
    if assignment is None:
        return None
    profile, tier = assignment
    # CleanProfile.as_dict() retains its v2 defining-module constant. Record the
    # actual selection policy explicitly instead of misreporting that constant.
    return {**asdict(profile), "tier": tier, "selectionPolicyVersion": current.POLICY_VERSION}


def mouth_diagnostics(metrics: dict) -> dict:
    m = metrics
    shared = {"eyes": isolated.all_eyes_neutral(m, 1.08), "brows": isolated.brows_neutral(m),
              "nose": isolated.nose_neutral(m), "jawTranslation": isolated.jaw_translation_neutral(m)}
    wide = m["stretch"] >= .23 and m["smile"] <= .27 and max(m["funnel"], m["pucker"]) <= .23 and m["frown"] <= .19
    frown = (m["frown"] >= .18 and m["browDown"] <= .17 and m["jawOpen"] <= .24
             and m["smile"] <= .21 and m["pucker"] <= .23 and m["stretch"] <= .23)
    purity = lambda strength, leakage: max(0.0, min(1.0, strength - max(0.0, leakage - 1) * .26))
    return {"sharedNeutralGates": shared, "mouthWidePredicate": wide, "mouthFrownPredicate": frown,
            "mouthWidePurityIfEligible": purity(m["stretch"], max(m["jawOpen"] / .46, m["press"] / .31)) if wide else None,
            "mouthFrownPurityIfEligible": purity(m["frown"], max(m["press"] / .33, m["roll"] / .29)) if frown else None,
            "minimumStrictPurity": .20,
            "note": "Diagnostics of the frozen v2 predicates only; no counterfactual features or new expression labels."}


def describe(record: dict) -> dict:
    feature, projection = record["feature"], record["projection"]
    assignment = current.classify_assignment(feature, projection)
    old = assignment
    if assignment is not None and assignment[1] == "observed":
        background = current.classify_background_profile(feature, projection)
        old = (background, "background") if background is not None else None
    m = isolated.metrics_from_feature(feature, projection)
    return {"metrics": m, "originalIsolatedBackgroundAssignment": assignment_summary(old),
            "currentAssignment": assignment_summary(assignment),
            "observedWinkEvidence": current.observed_wink_evidence(feature, projection),
            "strictGateDiagnostics": mouth_diagnostics(m)}


def strata(group: str, description: dict) -> dict[str, float]:
    """Scores choose diagnostic examples; these thresholds never admit a photo."""
    m, assignment = description["metrics"], description["currentAssignment"]
    name, tier = (assignment["name"], assignment["tier"]) if assignment else (None, None)
    buckets = {}
    if group.startswith("wink-"):
        side = group.split("-")[1]
        target, other = (m["blinkLeft"], m["blinkRight"]) if side == "left" else (m["blinkRight"], m["blinkLeft"])
        if target < .20 or target - other < .08 or abs(m["yaw"]) > 36 or abs(m["pitch"]) > 36:
            return {}
        score = target - other
        if name == "wink" + side.title():
            buckets["current-" + tier] = score
        buckets["near-blink-threshold"] = -abs(target - .35)
        evidence = description["observedWinkEvidence"]
        if evidence is None:
            buckets["score-geometry-disagreement"] = score
        if max(m["jawOpen"], m["smile"], m["pucker"], m["frown"]) >= .22:
            buckets["mouth-coexpression"] = score
        if not isolated.brows_neutral(m):
            buckets["brow-coexpression"] = score
        if not isolated.gaze_neutral(m, 1.1):
            buckets["gaze-coexpression"] = score
        buckets["high-action-score"] = score
        return buckets
    target = "mouthWide" if group == "mouth-wide" else "mouthFrown"
    score = m["stretch"] if group == "mouth-wide" else m["frown"]
    if score < .12:
        return {}
    if name == target:
        buckets["current-" + tier] = score
    boundary = .23 if group == "mouth-wide" else .18
    if score <= boundary + .08:
        buckets["near-action-threshold"] = -abs(score - boundary)
    gates = description["strictGateDiagnostics"]
    if not gates["sharedNeutralGates"]["eyes"]:
        buckets["eye-gaze-coexpression"] = score
    if not gates["sharedNeutralGates"]["brows"] or group == "mouth-frown" and m["browDown"] > .17:
        buckets["brow-coexpression"] = score
    if group == "mouth-wide" and m["smile"] > .27:
        buckets["smile-coexpression"] = score
    if group == "mouth-frown" and max(m["press"], m["roll"]) >= .16:
        buckets["press-roll-coexpression"] = score
    predicate = gates[target + "Predicate"]
    if predicate and all(gates["sharedNeutralGates"].values()) and name != target:
        buckets["predicate-purity-priority-conflict"] = score
    if name and name.startswith("mouth") and name != target:
        buckets["different-mouth-assignment"] = score
    buckets["high-action-score"] = score
    return buckets


class CandidatePools:
    def __init__(self) -> None:
        self.heaps = {group: defaultdict(list) for group in GROUPS}
        self.rows = {group: Counter({"eligible": 0}) for group in GROUPS}
        self.images = {group: defaultdict(set) for group in GROUPS}
        self.automatic_winks = {group: {} for group in AUTOMATIC_WINK_GROUPS}
        self.automatic_wink_rows = Counter()

    def add(self, record: dict, source: dict, description: dict) -> None:
        compact = {"sourceKey": record["sourceKey"], "sourceCatalogId": record["sourceCatalogId"],
                   "sourceId": record["sourceId"], "sourceLabel": source["sourceLabel"],
                   "encodedSha256": record["encodedSha256"], "cell": record["cell"],
                   "creatorKey": source["creatorKey"]}
        # This is the unchanged automatic screen, independent of the later
        # exact-image expression review required by selection. A match is a
        # diagnostic candidate, never a confirmed wink or admission override.
        evidence = description["observedWinkEvidence"]
        if evidence is not None:
            group = "wink-" + evidence["side"]
            require(group in self.automatic_winks, "Unknown automatic wink side")
            self.automatic_wink_rows[group] += 1
            alias = {key: value for key, value in compact.items() if key != "creatorKey"}
            candidate = self.automatic_winks[group].setdefault(record["encodedSha256"],
                {**compact, "samplingBucket": "all-automatic-wink-candidates", "sourceAliases": []})
            candidate["sourceAliases"].append(alias)
        for group in GROUPS:
            buckets = strata(group, description)
            if not buckets:
                continue
            for bucket in ("eligible", *buckets):
                self.rows[group][bucket] += 1
                self.images[group][bucket].add(record["encodedSha256"])
            for bucket, score in buckets.items():
                tie = hashlib.sha256((SEED + "\0" + group + "\0" + bucket + "\0" + record["sourceKey"]).encode()).hexdigest()
                item = (score, tie, record["sourceKey"], compact)
                heap = self.heaps[group][bucket]
                if len(heap) < POOL_PER_BUCKET:
                    heapq.heappush(heap, item)
                elif item[:3] > heap[0][:3]:
                    heapq.heapreplace(heap, item)

    def choose(self, group: str, count: int) -> list[dict]:
        priorities = ("current-observed", "current-strict", "predicate-purity-priority-conflict",
                      "near-action-threshold", "near-blink-threshold", "press-roll-coexpression",
                      "smile-coexpression", "eye-gaze-coexpression", "brow-coexpression",
                      "gaze-coexpression", "mouth-coexpression", "score-geometry-disagreement",
                      "different-mouth-assignment", "high-action-score")
        pools = {key: sorted(self.heaps[group].get(key, []), reverse=True) for key in priorities}
        result, used, cells, creators = [], set(), Counter(), Counter()
        # Round-robin challenge strata and progressively relaxed diversity caps
        # preserve rare strata without allowing a single source/photo to repeat.
        for cap in (1, 2, 4, count):
            while len(result) < count:
                added = False
                for bucket in priorities:
                    for _, _, _, row in pools[bucket]:
                        if row["encodedSha256"] in used or cells[row["cell"]] >= cap:
                            continue
                        creator = row["creatorKey"]
                        if creator and creators[creator] >= cap:
                            continue
                        result.append({**row, "samplingBucket": bucket})
                        used.add(row["encodedSha256"]); cells[row["cell"]] += 1
                        if creator:
                            creators[creator] += 1
                        added = True
                        break
                    if len(result) == count:
                        break
                if not added:
                    break
        return result

    def counts(self, group: str) -> dict:
        return {key: {"sourceRows": count, "uniqueEncodedImages": len(self.images[group][key])}
                for key, count in sorted(self.rows[group].items())}

    def all_automatic_winks(self, group: str) -> list[dict]:
        return [self.automatic_winks[group][digest] for digest in sorted(self.automatic_winks[group])]

    def automatic_wink_counts(self, group: str) -> dict:
        return {"sourceRows": self.automatic_wink_rows[group],
                "uniqueEncodedImages": len(self.automatic_winks[group])}


def scan_pool(audit: admission.AdmissionAudit, sources: dict) -> tuple[CandidatePools, dict]:
    pools = CandidatePools()
    rows, unique, skip = Counter(), defaultdict(set), Counter()
    transitions, by_source = Counter(), defaultdict(Counter)
    cursor = audit.connection.execute("SELECT source_key,source_catalog_id,source_id,encoded_sha256,source_feature_sha256,decision,record_sha256,record_z FROM records WHERE decision='pass' ORDER BY source_key")
    scanned = 0
    for row in cursor:
        record, _ = decode_pass_record(row, audit, sources)
        scanned += 1
        source = sources[record["sourceKey"]]
        reason = source["syntheticReason"] or source["artworkReason"]
        if reason:
            skip[reason] += 1
            continue
        description = describe(record)
        old, new = description["originalIsolatedBackgroundAssignment"], description["currentAssignment"]
        label = lambda value: value["name"] + "/" + value["tier"] if value else "unclassified"
        for key in ("realPhotoPass", "original:" + label(old), "current:" + label(new)):
            rows[key] += 1
            unique[key].add(record["encodedSha256"])
        transitions[label(old) + " -> " + label(new)] += 1
        by_source[record["sourceLabel"]][label(new)] += 1
        pools.add(record, source, description)
        if scanned % 10000 == 0:
            print("PROFILE_DIAGNOSTICS " + json.dumps({"passRecordsScanned": scanned, "expectedPassRecords": audit.receipt["passCount"]}), flush=True)
    require(scanned == audit.receipt["passCount"], "Incomplete full PASS-pool scan")
    rows.setdefault("realPhotoPass", 0)
    for version in ("original", "current"):
        rows.setdefault(version + ":unclassified", 0)
        for name in current.STRICT_PROFILE_PRIORITY:
            rows.setdefault(version + ":" + name + "/strict", 0)
        for name in current.BACKGROUND_PRIORITY:
            rows.setdefault(version + ":" + name + "/background", 0)
    for name in current.OBSERVED_PROFILE_PRIORITY:
        rows.setdefault("current:" + name + "/observed", 0)
    return pools, {"database": {key: audit.receipt[key] for key in ("recordCount", "passCount", "rejectCount", "unresolvedCount", "sourceCounts")},
                   "verifiedPassRecords": scanned, "nonphotographicPassRowsNotClassified": dict(skip),
                   "counts": {key: {"sourceRows": count, "uniqueEncodedImages": len(unique[key])} for key, count in sorted(rows.items())},
                   "originalToCurrentSourceRowTransitions": dict(sorted(transitions.items())),
                   "currentSourceRowAssignmentsBySource": {key: dict(sorted(value.items())) for key, value in sorted(by_source.items())},
                   "countingScope": "Every completed PASS record is checked. Synthetic/artwork sources are not classified. Counts precede image deduplication, selection/diversity and profile caps; bucket overlaps are explicit. Unique image counts within different profiles may overlap across source aliases."}


class GroupTooLarge(ValueError):
    """A diagnostic page must be split without changing original image bytes."""


def extract_group(group: str, selected: list[dict], entries: dict, sources: dict,
                  audit: admission.AdmissionAudit, output: Path, provenance: dict, counts: dict,
                  *, directory_name: str | None = None, prefix: str | None = None,
                  first_number: int = 1, exhaustive: bool = False) -> dict:
    from PIL import Image, ImageDraw, ImageFont, ImageOps
    directory = output / (directory_name or group)
    for child in ("originals", "records", "source-records"):
        (directory / child).mkdir(parents=True, exist_ok=False)
    samples = []
    extensions = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "AVIF": ".avif", "GIF": ".gif"}
    for number, candidate in enumerate(selected, first_number):
        key = candidate["sourceKey"]
        entry = entries[key]
        payload = audit.readers[candidate["sourceCatalogId"]].read(entry)
        record = audit.record(candidate["sourceCatalogId"], entry, payload)
        require(record is not None, "A picked record is not PASS")
        row = audit.connection.execute("SELECT source_key,source_catalog_id,source_id,encoded_sha256,source_feature_sha256,decision,record_sha256,record_z FROM records WHERE source_key=?", (key,)).fetchone()
        decoded, raw = decode_pass_record(row, audit, sources)
        require(decoded == record and decoded["encodedSha256"] == candidate["encodedSha256"], "Picked record changed")
        with Image.open(io.BytesIO(payload)) as opened:
            opened.load()
            image_format, size = opened.format, list(opened.size)
        sample = (prefix or SAMPLE_PREFIX[group]) + f"{number:03d}"
        image_path = "originals/" + sample + extensions.get(image_format, ".bin")
        record_path, source_path = f"records/{sample}.json", f"source-records/{sample}.json"
        (directory / image_path).write_bytes(payload)
        (directory / record_path).write_bytes(raw)
        write_json(directory / source_path, entry)
        description = describe(record)
        aliases = []
        if exhaustive:
            evidence = description["observedWinkEvidence"]
            require(evidence is not None and group == "wink-" + evidence["side"],
                    "Exhaustive export includes a nonmatching automatic candidate")
            for alias_number, alias in enumerate(candidate["sourceAliases"], 1):
                alias_entry = entries[alias["sourceKey"]]
                alias_payload = audit.readers[alias["sourceCatalogId"]].read(alias_entry)
                alias_record = audit.record(alias["sourceCatalogId"], alias_entry, alias_payload)
                alias_row = audit.connection.execute("SELECT source_key,source_catalog_id,source_id,encoded_sha256,source_feature_sha256,decision,record_sha256,record_z FROM records WHERE source_key=?", (alias["sourceKey"],)).fetchone()
                alias_decoded, alias_raw = decode_pass_record(alias_row, audit, sources)
                alias_evidence = current.observed_wink_evidence(alias_decoded["feature"], alias_decoded["projection"])
                require(alias_record == alias_decoded and alias_payload == payload
                        and alias_evidence is not None and group == "wink-" + alias_evidence["side"],
                        "Automatic candidate alias bytes or predicate changed")
                if alias["sourceKey"] == key:
                    alias_record_path, alias_source_path = record_path, source_path
                else:
                    alias_record_path = f"records/{sample}-alias-{alias_number:02d}.json"
                    alias_source_path = f"source-records/{sample}-alias-{alias_number:02d}.json"
                    (directory / alias_record_path).write_bytes(alias_raw)
                    write_json(directory / alias_source_path, alias_entry)
                aliases.append({**alias, "recordPath": alias_record_path,
                                "recordSha256": hashlib.sha256(alias_raw).hexdigest(),
                                "sourceRecordPath": alias_source_path,
                                "sourceRecordSha256": admission.sha256_file(directory / alias_source_path),
                                "automaticWinkEvidence": alias_evidence})
        original = current.classify_assignment(entry["feature"], entry.get("projection"))
        samples.append({**{key: value for key, value in candidate.items() if key not in ("creatorKey", "sourceAliases")},
                        "sample": sample, "imagePath": image_path, "imageFormat": image_format, "imageSize": size,
                        "byteLength": len(payload), "recordPath": record_path, "recordSha256": hashlib.sha256(raw).hexdigest(),
                        "sourceRecordPath": source_path, "sourceRecordSha256": admission.sha256_file(directory / source_path),
                        "sourceStoredProfile": entry.get("cleanProfile"), "sourceStoredTier": entry.get("cleanTier"),
                        "sourceMeasurementsAssignment": assignment_summary(original),
                        "sourceMeasurementsAreFreshAuditInput": False,
                        **({"sourceAliases": aliases, "automaticCandidateSide": group.split("-")[1],
                            "expressionConfirmed": False} if exhaustive else {}),
                        **description, "visualReview": "pending", "humanVerified": False})
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 12)
    except OSError:
        font = ImageFont.load_default()
    width, photo_height, label_height = 192, 192, 80
    sheet = Image.new("RGB", (width * 6, (photo_height + label_height) * max(1, math.ceil(len(samples) / 6))), "#e5e7eb")
    draw = ImageDraw.Draw(sheet)
    if not samples:
        draw.text((16, 16), "No eligible PASS photos in this diagnostic group", font=font, fill="black")
    for index, sample in enumerate(samples):
        x, y = index % 6 * width, index // 6 * (photo_height + label_height)
        with Image.open(directory / sample["imagePath"]) as opened:
            preview = ImageOps.contain(ImageOps.exif_transpose(opened).convert("RGB"), (width, photo_height), Image.Resampling.LANCZOS)
            sheet.paste(preview, (x + (width - preview.width) // 2, y + (photo_height - preview.height) // 2))
        m, assignment = sample["metrics"], sample["currentAssignment"]
        label = ("automatic " + group.split("-")[1] + "; unconfirmed") if exhaustive else (
            assignment["name"] + " " + assignment["tier"] if assignment else "unclassified")
        lines = [sample["sample"] + " " + label, sample["samplingBucket"][:27],
                 f"yaw {m['yaw']:+.1f} pitch {m['pitch']:+.1f}",
                 f"stretch {m['stretch']:.3f} frown {m['frown']:.3f}",
                 f"blink L {m['blinkLeft']:.3f} R {m['blinkRight']:.3f}", sample["encodedSha256"][:20]]
        for line, text in enumerate(lines):
            draw.text((x + 3, y + photo_height + 2 + line * 13), text, font=font, fill="#111827")
    sheet.save(directory / "contact-sheet.jpg", "JPEG", quality=90, optimize=True)
    index = {"schemaVersion": 1, "documentKind": "completed-pass-automatic-wink-page" if exhaustive else "completed-pass-profile-diagnostic-group", "group": group,
             "provenance": provenance, "sampleCount": len(samples), "requestedSamples": len(samples) if exhaustive else SAMPLES_PER_GROUP,
             "shortfall": 0 if exhaustive else max(0, SAMPLES_PER_GROUP - len(samples)), "population": counts,
             "contactSheet": "contact-sheet.jpg", "samples": samples,
             "modelInferencePerformed": False, "rawMeasurementsUnchanged": True,
             "originalEncodedImagesUnchanged": True, "selectionOrAdmissionChanged": False,
             "visualReview": "pending", "humanVerified": False,
             "sampling": ("Exhaustive unchanged observed_wink_evidence screen over completed real-photo PASS records, before later selection denials or expression review. Unique encoded images per side sorted by SHA256; all matching source aliases retain exact frozen records. An automatic match is not a confirmed expression."
                          if exhaustive else "Deterministic stratified challenge selection with pose/creator diversity; only unique exact encoded images within each group. Bucket thresholds are sampling thresholds, not admission or expression acceptance rules."),
             "diagnosticFocus": "all-observed-winks" if exhaustive else "profile-challenges",
             "expressionReviewApplied": False, "laterSelectionDenialsApplied": False,
             "thumbnailTransform": "Contain the full image; EXIF orientation and resizing affect contact thumbnails only."}
    write_json(directory / "index.json", index)
    files = [{"path": path.relative_to(directory).as_posix(), "bytes": path.stat().st_size, "sha256": admission.sha256_file(path)}
             for path in sorted(directory.rglob("*")) if path.is_file()]
    total = sum(file["bytes"] for file in files)
    if total > MAX_GROUP_BYTES or len(files) > MAX_ARTIFACT_FILES:
        raise GroupTooLarge("Diagnostic group exceeds its 24 MiB/file bound; exact originals must not be downsampled")
    for sample in samples:
        require(admission.sha256_file(directory / sample["imagePath"]) == sample["encodedSha256"], "Exported image bytes changed")
        require(admission.sha256_file(directory / sample["recordPath"]) == sample["recordSha256"], "Exported audit record bytes changed")
    return {"group": group, "directory": directory.relative_to(output).as_posix(),
            "sampleCount": len(samples), "payloadBytes": total, "files": files,
            "sampleIds": [sample["sample"] for sample in samples],
            "indexSha256": admission.sha256_file(directory / "index.json")}


def extract_all_automatic_winks(choices: dict, entries: dict, sources: dict,
                               audit: admission.AdmissionAudit, output: Path,
                               provenance: dict, pools: CandidatePools) -> tuple[list, list, dict]:
    """Export every match, then pack whole contact pages into small artifacts."""
    staging = output / "pages"
    pages, exhaustive = [], {}
    for group in AUTOMATIC_WINK_GROUPS:
        selected = choices[group]
        count = pools.automatic_wink_counts(group)
        require(len(selected) == count["uniqueEncodedImages"], "Incomplete automatic wink choice set")
        require(sum(len(row["sourceAliases"]) for row in selected) == count["sourceRows"],
                "Automatic wink source alias coverage differs")
        offset, page_number = 0, 0
        while offset < len(selected) or page_number == 0:
            page_number += 1
            amount = min(SAMPLES_PER_GROUP, len(selected) - offset)
            name = f"{group}-page-{page_number:02d}"
            while True:
                try:
                    page = extract_group(group, selected[offset:offset + amount], entries, sources, audit,
                        staging, provenance, count, directory_name=name,
                        prefix="WLA" if group == "wink-left" else "WRA",
                        first_number=offset + 1, exhaustive=True)
                    break
                except GroupTooLarge:
                    # These are our own newly staged files, never source/audit
                    # evidence. Split the page; never shrink the original image.
                    shutil.rmtree(staging / name)
                    require(amount > 1, "A single exact-image diagnostic exceeds its artifact bound")
                    amount = max(1, amount // 2)
            pages.append(page)
            offset += amount
        require(offset == len(selected), "An exhaustive wink page was skipped")
        exhaustive[group] = {**count, "exportedUniqueEncodedImages": offset,
            "exportedSourceRows": sum(len(row["sourceAliases"]) for row in selected),
            "contactPages": page_number,
            "encodedImageSetSha256": hashlib.sha256(admission.json_bytes(sorted(row["encodedSha256"] for row in selected))).hexdigest(),
            "samplePrefix": "WLA" if group == "wink-left" else "WRA",
            "automaticPredicate": "clean_core_policy_v3.observed_wink_evidence",
            "complete": True, "expressionConfirmed": False}

    parts = []
    current_part = None
    for page in pages:
        file_count = len(page["files"])
        if (current_part is None or current_part["payloadBytes"] + page["payloadBytes"] > MAX_GROUP_BYTES
                or current_part["fileCount"] + file_count > MAX_ARTIFACT_FILES):
            require(len(parts) < MAX_ARTIFACT_PARTS,
                    "Exhaustive export needs more than eight small artifacts; no candidates may be omitted")
            part_name = f"part-{len(parts) + 1:02d}"
            current_part = {"name": part_name, "directory": "parts/" + part_name,
                            "payloadBytes": 0, "fileCount": 0, "pages": []}
            parts.append(current_part)
            (output / current_part["directory"]).mkdir(parents=True, exist_ok=False)
        old_path = staging / page["directory"]
        new_path = output / current_part["directory"] / old_path.name
        old_path.rename(new_path)
        page["directory"] = new_path.relative_to(output).as_posix()
        current_part["payloadBytes"] += page["payloadBytes"]
        current_part["fileCount"] += file_count
        current_part["pages"].append({"directory": new_path.name, "group": page["group"],
                                      "sampleCount": page["sampleCount"], "indexSha256": page["indexSha256"]})
    staging.rmdir()
    for part in parts:
        files = [path for path in (output / part["directory"]).rglob("*") if path.is_file()]
        require(len(files) == part["fileCount"] and sum(path.stat().st_size for path in files) == part["payloadBytes"]
                and part["payloadBytes"] <= MAX_GROUP_BYTES, "Packed diagnostic artifact changed")
    for group in AUTOMATIC_WINK_GROUPS:
        exported, aliases, sample_ids = [], [], []
        for page in pages:
            if page["group"] != group:
                continue
            index = json.loads((output / page["directory"] / "index.json").read_text())
            require(len(index["samples"]) <= SAMPLES_PER_GROUP, "Contact page has more than 48 samples")
            exported.extend(sample["encodedSha256"] for sample in index["samples"])
            aliases.extend(alias["sourceKey"] for sample in index["samples"] for alias in sample["sourceAliases"])
            sample_ids.extend(sample["sample"] for sample in index["samples"])
        require(exported == sorted(pools.automatic_winks[group]) and len(aliases) == len(set(aliases))
                and len(aliases) == pools.automatic_wink_rows[group], "Exhaustive export membership or alias coverage differs")
        prefix = exhaustive[group]["samplePrefix"]
        require(sample_ids == [prefix + f"{number:03d}" for number in range(1, len(exported) + 1)],
                "Stable exhaustive sample IDs are missing or repeated")
    return pages, parts, exhaustive


def export_diagnostics(receipt_path: Path, attribute_model: Path, face_model: Path, sources: list,
                       reviewed_path: Path, output: Path, *, all_observed_winks: bool = False) -> dict:
    require(not output.exists() or not any(output.iterdir()), "Diagnostic output must be empty; nothing is overwritten")
    require(not output.resolve().is_relative_to(receipt_path.parent.resolve()), "Output must not be inside frozen audit evidence")
    for source in admission.normalize_sources(sources):
        require(not output.resolve().is_relative_to(Path(source["root"])), "Output must not be inside a source catalog")
    with admission.AdmissionAudit(receipt_path, attribute_model, sources) as audit:
        require(admission.sha256_file(face_model) == audit.receipt["models"]["faceSha256"], "Fresh face-model bytes differ from completed audit")
        require(admission.sha256_file(reviewed_path) == audit.controls.get("reviewedFileSha256")
                and admission.load_visibility_reviews(reviewed_path) == audit.controls.get("reviews"),
                "Current manual visibility decisions differ from frozen audit controls")
        code_files = [Path(__file__), Path(admission.__file__), Path(isolated.__file__), Path(current.__file__),
                      Path(__file__).with_name("build_clean_core_v3.py")]
        provenance = {"candidateAuditSha256": admission.sha256_file(receipt_path), "recordsSha256": audit.receipt["recordsSha256"],
                      "policySha256": audit.policy.sha256, "analysisCodeSha256": audit.receipt["analysisCodeSha256"],
                      "controlsSha256": audit.receipt["controlsSha256"], "reviewedVisibilitySha256": admission.sha256_file(reviewed_path),
                      "models": audit.receipt["models"], "inferenceRuntimeVersions": audit.receipt.get("runtimeVersions"),
                      "sources": audit.receipt["sources"], "diagnosticCodeCommit": os.environ.get("GITHUB_SHA"),
                      "selectionPolicyVersion": current.POLICY_VERSION, "seed": SEED,
                      "codeSha256": {path.name: admission.sha256_file(path) for path in code_files}}
        indexed = source_index(audit)
        pools, population = scan_pool(audit, indexed)
        choices = ({group: pools.all_automatic_winks(group) for group in AUTOMATIC_WINK_GROUPS}
                   if all_observed_winks else {group: pools.choose(group, SAMPLES_PER_GROUP) for group in GROUPS})
        wanted = {alias["sourceKey"] for chosen in choices.values() for row in chosen
                  for alias in (row["sourceAliases"] if all_observed_winks else [row])}
        originals = {}
        for source in audit.sources:
            manifest = json.loads((Path(source["root"]) / "manifest.json").read_text())
            catalog_id = str(manifest.get("catalogId") or source["label"])
            for entry in admission.iter_catalog_entries(source["root"]):
                key = admission.source_key(catalog_id, str(entry["id"]))
                if key in wanted:
                    originals[key] = entry
        require(set(originals) == wanted, "A picked source image is missing")
        output.mkdir(parents=True, exist_ok=True)
        parts, exhaustive = [], {}
        if all_observed_winks:
            groups, parts, exhaustive = extract_all_automatic_winks(choices, originals, indexed, audit, output, provenance, pools)
        else:
            groups = [extract_group(group, choices[group], originals, indexed, audit, output, provenance, pools.counts(group)) for group in GROUPS]
        require(admission.sha256_file(receipt_path) == provenance["candidateAuditSha256"], "Completed receipt changed during diagnostics")
        require(admission.sha256_file(admission.safe_child(receipt_path.parent, audit.receipt["recordsPath"])) == provenance["recordsSha256"],
                "Frozen record database changed during diagnostics")
        require(all(admission.sha256_file(path) == provenance["codeSha256"][path.name] for path in code_files),
                "Diagnostic or classification code changed while scanning")
        summary = {"schemaVersion": 1, "documentKind": "completed-pass-profile-diagnostics", "status": "complete",
                   "provenance": provenance, "population": population, "groups": groups,
                   "diagnosticFocus": "all-observed-winks" if all_observed_winks else "profile-challenges",
                   "artifactParts": parts, "exhaustiveAutomaticWinks": exhaustive,
                   "automaticWinkCandidates": {group: pools.automatic_wink_counts(group) for group in AUTOMATIC_WINK_GROUPS},
                   "automaticGroupsMayShareEncodedImages": True,
                   "crossSideUniqueImageOverlap": (len(set(pools.automatic_winks["wink-left"]) & set(pools.automatic_winks["wink-right"]))
                                                   if all_observed_winks else None),
                   "expressionReviewApplied": False, "laterSelectionDenialsApplied": False,
                   "maximumGroupPayloadBytes": MAX_GROUP_BYTES, "visualReview": "pending", "humanVerified": False,
                   "modelInferencePerformed": False, "rawMeasurementsUnchanged": True,
                   "selectionOrAdmissionChanged": False, "datasetPromoted": False, "sitePublished": False,
                   "originalAssignmentMeaning": "Apply the unchanged isolated/background path to the same fresh record, before the observed-wink tier. Source measurements and stored source labels are separately disclosed per sample.",
                   "limitation": "Automatic candidates and challenge samples are not confirmed expressions, a prevalence estimate, visual approval, or a completed selected-catalog holdout."}
        write_json(output / "summary/summary.json", summary)
        (output / "summary/README.md").write_text(
            "# Completed PASS-pool profile diagnostics\n\n"
            "Read summary.json for full-pool row and unique-image counts, frozen provenance and file hashes. "
            "Each contact page contains index.json, contact-sheet.jpg, exact original encoded photos, "
            "exact decompressed audit records, and the corresponding original source entries.\n\n"
            "Compare the current assignment, the unchanged isolated/background assignment on the same fresh features, "
            "and the separately disclosed source measurements. Automatic wink matches require expression review; they are not confirmed winks. "
            "Every included photo passed the completed audit and its manual-denial controls. "
            "Expression and residual visibility review remains pending. No model inference, catalog selection, "
            "feature adjustment, admission change or publication occurs here. The challenge sample is not an error-rate estimate.\n\n"
            + ("This exhaustive run exports every unchanged observed_wink_evidence match in the completed real-photo PASS pool, "
               "before later selection denials or wink-expression review. It deduplicates exact encoded bytes within each side, "
               "retains every matching source alias record, and orders WLA/WRA sample IDs by image SHA256. "
               "Contact pages contain at most 48 photos; artifactParts lists every bounded download and its pages. "
               "No heap, diversity cap, 48-photo group limit or manual expression decision reduces this exhaustive set.\n"
               if all_observed_winks else ""),
            encoding="utf-8")
        require(sum(path.stat().st_size for path in (output / "summary").rglob("*") if path.is_file()) <= MAX_GROUP_BYTES,
                "Diagnostic summary exceeds its payload cap")
        return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-audit", type=Path, required=True)
    parser.add_argument("--face-attribute-model", type=Path, required=True)
    parser.add_argument("--face-model", type=Path, required=True)
    parser.add_argument("--source", action="append", required=True, metavar="LABEL=PATH")
    parser.add_argument("--reviewed-visibility", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--all-observed-winks", action="store_true",
                        help="Export all unique automatic wink candidates and matching source records in bounded pages; no expression approval")
    args = parser.parse_args(argv)
    result = export_diagnostics(args.candidate_audit.resolve(), args.face_attribute_model.resolve(), args.face_model.resolve(),
                                args.source, args.reviewed_visibility.resolve(), args.out.resolve(),
                                all_observed_winks=args.all_observed_winks)
    print(json.dumps({"status": result["status"], "verifiedPassRecords": result["population"]["verifiedPassRecords"],
                      "groups": [{key: group[key] for key in ("group", "sampleCount", "payloadBytes")} for group in result["groups"]],
                      "visualReview": "pending", "modelInferencePerformed": False, "output": str(args.out)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
