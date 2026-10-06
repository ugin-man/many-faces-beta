#!/usr/bin/env python3
"""Prepare a deterministic, unreviewed post-selection visual holdout.

This reads completed admission evidence and exact selected image bytes. It
performs no model inference, changes no catalog, and makes no review decisions.
The mixture of controls and challenge strata is not a prevalence estimate.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import re
import zlib
from collections import Counter
from pathlib import Path

import clean_core_admission as admission

SEED = 20261007
TARGET_SAMPLES = 360
PAGE_SIZE = 36
PAINT_TITLE = re.compile(r"\b(?:(?:face|body)[ -]?)?paint(?:ing|ed)?\b", re.IGNORECASE)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def read_evidence(receipt_path: Path):
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    require(receipt.get("schemaVersion") == 2 and receipt.get("status") == "complete",
            "A completed schema-2 candidate audit is required")
    policy = admission.AdmissionPolicy.from_document(receipt.get("policy", {}))
    require(policy.sha256 == receipt.get("policySha256"), "Admission policy digest mismatch")
    path = admission.safe_child(receipt_path.parent, receipt.get("recordsPath", ""))
    require(admission.sha256_file(path) == receipt.get("recordsSha256"), "Admission database digest mismatch")
    database = admission.readonly_database(path)
    try:
        metadata = admission.database_metadata(database)
        for key in ("schemaVersion", "status", "policySha256", "analysisCodeSha256", "models", "controlsSha256", "sources"):
            require(metadata.get(key) == receipt.get(key), "Admission database metadata mismatch: " + key)
        summary = admission.database_summary(database)
        require(all(receipt.get(key) == value for key, value in summary.items()), "Admission database count mismatch")
        return receipt, database
    except Exception:
        database.close()
        raise


def selected_candidates(catalog: Path, manifest: dict, receipt: dict, database, reviews: dict):
    stamp = manifest.get("qualityAdmission", {})
    require(stamp.get("schemaVersion") == 2 and stamp.get("status") == "complete", "Missing selected-catalog admission stamp")
    require(stamp.get("recordsSha256") == receipt["recordsSha256"] and stamp.get("policySha256") == receipt["policySha256"],
            "The selected catalog is bound to different admission evidence")
    eligible, known_denied = [], []
    reviewed_counts: Counter[str] = Counter()
    seen_ids, seen_digests, seen_keys = set(), set(), set()
    profile_counts: Counter[str] = Counter()
    for entry in admission.iter_catalog_entries(catalog):
        identity, digest = entry["id"], entry.get("admissionSha256")
        key = admission.source_key(entry.get("admissionSourceCatalogId", ""), entry.get("admissionSourceId", ""))
        require(identity not in seen_ids and key not in seen_keys, "Repeated selected image/source ID")
        require(admission.valid_digest(digest) and digest not in seen_digests, "Invalid or repeated selected image digest")
        seen_ids.add(identity)
        seen_keys.add(key)
        seen_digests.add(digest)
        row = database.execute("SELECT decision,encoded_sha256,record_sha256,record_z FROM records WHERE source_key=?", (key,)).fetchone()
        require(row is not None and row[0] == "pass" and row[1] == digest, "A selected image lacks passing matching admission evidence")
        raw = zlib.decompress(row[3])
        require(hashlib.sha256(raw).hexdigest() == row[2], "Compressed admission record digest mismatch")
        record = json.loads(raw)
        require(record.get("sourceKey") == key and record.get("encodedSha256") == digest and record.get("decision") == "pass",
                "Admission record identity mismatch")
        require(record.get("policySha256") == receipt["policySha256"], "Selected record policy mismatch")
        require(all(record.get("checks", {}).get(name) == "pass" for name in admission.REQUIRED_CHECKS), "Selected record has incomplete admission checks")
        for field in ("feature", "shape", "mesh", "projection", "layout"):
            require(entry.get(field) == record.get(field), "Selected image has changed face measurements: " + field)
        yaw, pitch = record.get("freshYaw"), record.get("freshPitch")
        require(all(isinstance(value, (int, float)) and math.isfinite(value) for value in (yaw, pitch)), "Missing fresh selected pose")
        face_scores = admission.validate_attribute_scores(record.get("faceAttributes", []))
        full_scores = admission.validate_attribute_scores(record.get("fullAttributes", []))
        profile = str(entry.get("cleanProfile", ""))
        require(bool(profile), "Missing selected expression profile")
        profile_counts[profile] += 1
        if digest in reviews:
            reviewed_counts[reviews[digest]["decision"]] += 1
            if reviews[digest]["decision"] == "deny":
                known_denied.append({"id": identity, "encodedSha256": digest, "sourceKey": key, "review": reviews[digest]})
            continue
        # Keep only sampling metadata and byte references in memory, not the
        # full geometry of every selected photograph.
        eligible.append({
            "id": identity, "encodedSha256": digest, "sourceKey": key,
            "sourceCatalogId": record["sourceCatalogId"], "sourceId": record["sourceId"],
            "sourceLabel": record.get("sourceLabel", ""), "name": str(entry.get("name", "")),
            "freshYaw": yaw, "freshPitch": pitch, "freshRoll": record.get("freshRoll"),
            "cleanProfile": profile, "cleanTier": entry.get("cleanTier"),
            "cleanScore": entry.get("cleanScore"), "admissionQualityScore": record.get("qualityScore"),
            "faceAttributes": dict(zip(admission.ATTRIBUTE_NAMES, face_scores)),
            "fullAttributes": dict(zip(admission.ATTRIBUTE_NAMES, full_scores)),
            "admissionReasons": record.get("reasons", []), "byteLength": record["byteLength"],
            "_imageReference": {name: entry[name] for name in ("id", "pack", "offset", "length", "image") if name in entry},
        })
    count = len(seen_ids)
    require(count == manifest.get("searchableFaces") == manifest.get("totalFaces") == stamp.get("selectedCount"),
            "Final selected-catalog counts are inconsistent")
    return eligible, {"physicalRows": count, "eligibleUniqueImages": len(eligible),
                      "excludedReviewedImages": sum(reviewed_counts.values()), "reviewedSelectedDecisions": dict(reviewed_counts),
                      "knownDeniedSelected": known_denied, "profileCounts": dict(sorted(profile_counts.items()))}


def sample_buckets():
    # Random controls are drawn first from the entire eligible population.
    # Later strata provide targeted coverage without duplicating those images.
    return [
        ("random-control", 144, "All unreviewed selected images", lambda row: True),
        ("yaw-negative-extreme", 36, "Fresh yaw <= -30 degrees", lambda row: row["freshYaw"] <= -30),
        ("yaw-positive-extreme", 36, "Fresh yaw >= +30 degrees", lambda row: row["freshYaw"] >= 30),
        ("pitch-negative-extreme", 24, "Fresh pitch <= -24 degrees", lambda row: row["freshPitch"] <= -24),
        ("pitch-positive-extreme", 24, "Fresh pitch >= +24 degrees", lambda row: row["freshPitch"] >= 24),
        ("wink-left", 12, "Strict winkLeft profile", lambda row: row["cleanProfile"] == "winkLeft"),
        ("wink-right", 12, "Strict winkRight profile", lambda row: row["cleanProfile"] == "winkRight"),
        ("smile-closed", 12, "Strict smileClosed profile", lambda row: row["cleanProfile"] == "smileClosed"),
        ("smile-open", 12, "Strict smileOpen profile", lambda row: row["cleanProfile"] == "smileOpen"),
        ("mouth-open", 12, "Strict mouthOpen profile", lambda row: row["cleanProfile"] == "mouthOpen"),
        ("mouth-slight-open", 8, "Strict mouthSlightOpen profile", lambda row: row["cleanProfile"] == "mouthSlightOpen"),
        ("eyeglasses-score-challenge", 16, "Tight-crop eyeglasses score >= 0.50; visibility is not presumed", lambda row: row["faceAttributes"]["eyeglasses"] >= .50),
        ("paint-title-challenge", 12, "Paint-related title; not a pixel-based paint diagnosis", lambda row: bool(PAINT_TITLE.search(row["name"]))),
    ]


def deterministic_rank(row: dict, bucket: str) -> tuple[bytes, str]:
    digest = row["encodedSha256"]
    return hashlib.sha256(f"{SEED}\0{bucket}\0{digest}".encode("utf-8")).digest(), digest


def choose_samples(eligible: list[dict]):
    selected, coverage, used = [], [], set()
    definitions = sample_buckets()
    require(sum(count for _, count, _, _ in definitions) == TARGET_SAMPLES, "Sample quota total mismatch")
    for name, count, criterion, predicate in definitions:
        all_matching = [row for row in eligible if predicate(row)]
        available = [row for row in all_matching if row["encodedSha256"] not in used]
        chosen = sorted(available, key=lambda row: deterministic_rank(row, name))[:count]
        for row in chosen:
            used.add(row["encodedSha256"])
            selected.append({**row, "bucket": name, "matchingBuckets": [label for label, _, _, test in definitions if test(row)]})
        coverage.append({"bucket": name, "criterion": criterion, "requested": count,
                         "eligibleBeforeOtherBuckets": len(all_matching), "availableAfterEarlierBuckets": len(available),
                         "selected": len(chosen), "shortfall": count - len(chosen)})
    remaining = [row for row in eligible if row["encodedSha256"] not in used]
    fill_count = TARGET_SAMPLES - len(selected)
    fill = sorted(remaining, key=lambda row: deterministic_rank(row, "random-fill"))[:fill_count]
    for row in fill:
        selected.append({**row, "bucket": "random-fill", "matchingBuckets": [label for label, _, _, test in definitions if test(row)]})
    coverage.append({"bucket": "random-fill", "criterion": "Remaining unreviewed images after challenge shortfalls",
                     "requested": fill_count, "availableAfterEarlierBuckets": len(remaining), "selected": len(fill),
                     "shortfall": fill_count - len(fill)})
    return selected, coverage


def extract_and_render(catalog: Path, output: Path, selected: list[dict]) -> list[dict]:
    from PIL import Image, ImageDraw, ImageFont, ImageOps

    images = output / "images"
    images.mkdir()
    extensions = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "AVIF": ".avif", "GIF": ".gif"}
    with admission.PackedImageReader(catalog) as reader:
        for index, row in enumerate(selected, 1):
            payload = reader.read(row.pop("_imageReference"))
            require(len(payload) == row["byteLength"] and hashlib.sha256(payload).hexdigest() == row["encodedSha256"],
                    "Selected image bytes changed before holdout extraction")
            with Image.open(io.BytesIO(payload)) as opened:
                extension = extensions.get(opened.format, ".bin")
                row["encodedImageSize"] = [opened.width, opened.height]
            row["sample"] = f"H{index:03d}"
            row["imagePath"] = f"images/{row['sample']}{extension}"
            row["contactSheet"] = f"contact-{(index - 1) // PAGE_SIZE + 1:02d}.jpg"
            row["assistantReviewStatus"] = "pending"
            # Preserve the original encoded file exactly. Only the contact
            # preview below is resized; faces are not cropped for review.
            (output / row["imagePath"]).write_bytes(payload)
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 12)
    except OSError:
        font = ImageFont.load_default()
    tile_width, photo_height, label_height = 192, 192, 72
    pages = []
    for page_start in range(0, len(selected), PAGE_SIZE):
        rows = selected[page_start:page_start + PAGE_SIZE]
        sheet = Image.new("RGB", (tile_width * 6, (photo_height + label_height) * 6), "#e5e7eb")
        draw = ImageDraw.Draw(sheet)
        for index, row in enumerate(rows):
            x, y = index % 6 * tile_width, index // 6 * (photo_height + label_height)
            with Image.open(output / row["imagePath"]) as opened:
                preview = ImageOps.contain(ImageOps.exif_transpose(opened).convert("RGB"), (tile_width, photo_height), Image.Resampling.LANCZOS)
                sheet.paste(preview, (x + (tile_width - preview.width) // 2, y + (photo_height - preview.height) // 2))
            scores = row["faceAttributes"]
            lines = [f"{row['sample']} {row['bucket'][:22]}",
                     row["cleanProfile"],
                     f"yaw {row['freshYaw']:+.1f} pitch {row['freshPitch']:+.1f}",
                     f"mask {scores['mask']:.3f} sun {scores['sunglasses']:.3f}",
                     f"glasses {scores['eyeglasses']:.3f} {row['encodedSha256'][:8]}"]
            for line, label in enumerate(lines):
                draw.text((x + 3, y + photo_height + 3 + line * 13), label, font=font, fill="#111827")
        name = f"contact-{page_start // PAGE_SIZE + 1:02d}.jpg"
        sheet.save(output / name, "JPEG", quality=92, optimize=True)
        pages.append({"path": name, "samples": [row["sample"] for row in rows]})
    return pages


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--candidate-audit", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--reviewed-visibility", type=Path, required=True)
    args = parser.parse_args()
    catalog, output, receipt_path = args.catalog.resolve(), args.out.resolve(), args.candidate_audit.resolve()
    require(not output.exists() or not any(output.iterdir()), "Holdout output must be empty; previous samples are never overwritten")
    manifest_path = catalog / "manifest.json"
    manifest_hash = admission.sha256_file(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    require(manifest.get("schemaVersion") == 3 and manifest.get("shardsContainGeometry") is True, "Expected a completed physical sharded catalog")
    reviews = admission.load_visibility_reviews(args.reviewed_visibility)
    receipt, database = read_evidence(receipt_path)
    try:
        require(manifest.get("qualityAdmission", {}).get("receiptSha256") == admission.sha256_file(receipt_path),
                "The selected catalog is bound to another admission receipt")
        eligible, population = selected_candidates(catalog, manifest, receipt, database, reviews)
    finally:
        database.close()
    require(len(eligible) >= 320, "Fewer than 320 unique unreviewed selected photos are available")
    selected, coverage = choose_samples(eligible)
    output.mkdir(parents=True, exist_ok=True)
    pages = extract_and_render(catalog, output, selected)
    require(admission.sha256_file(manifest_path) == manifest_hash, "Catalog manifest changed during holdout preparation")
    index = {
        "schemaVersion": 1, "documentKind": "post-selection-visual-holdout", "catalogId": manifest["catalogId"],
        "manifestSha256": manifest_hash, "candidateAuditSha256": admission.sha256_file(receipt_path),
        "recordsSha256": receipt["recordsSha256"], "reviewedVisibilitySha256": admission.sha256_file(args.reviewed_visibility),
        "seed": SEED, "ranking": "SHA256(seed + NUL + bucket + NUL + encodedSha256), ascending",
        "targetSamples": TARGET_SAMPLES, "sampleCount": len(selected), "population": population, "buckets": coverage,
        "assistantReviewStatus": "pending", "humanVerified": False, "scoresCalibrated": False,
        "sampling": "Uniform hash-ranked controls followed by deterministic pose, expression, eyeglasses-score, and paint-title challenges; unique encoded images only.",
        "samplingLimitation": "The combined stratified sample is not an overall error-rate or prevalence estimate. Already reviewed encoded images are excluded. Bucket overlap and unmet challenge quotas are explicit.",
        "knownLimits": "FaceAttribNet mask/sunglasses scores do not cover every expression-obscuring object. Inspect eye, nose, and mouth visibility in the exact originals, including hands and microphones.",
        "catalogChanged": False, "modelInferencePerformed": False, "originalEncodedImagesUnchanged": True,
        "contactThumbnailsOnly": "Original images are contained in each tile without cropping; EXIF orientation is applied to the thumbnail only.",
        "pages": pages, "samples": selected,
    }
    (output / "sample-index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"sampleCount": len(selected), "pages": len(pages), "output": str(output),
                      "assistantReviewStatus": "pending", "knownDeniedSelected": len(population["knownDeniedSelected"])}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
