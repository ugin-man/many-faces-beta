#!/usr/bin/env python3
"""Exact-byte visual evidence after frozen admission, before selection.

Selection denials can only remove candidates. Wink expression confirmations
only authorize a corroborated expression label. Neither changes an inference
result or admits an unresolved image.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date
from pathlib import Path
from typing import Any


DOCUMENT_KIND = "clean-core-selection-visibility-review"
REVIEW_FILENAME = "selection-review.json"
PREVIOUS_FILENAME = "selection-review-previous.json"
WINK_DOCUMENT_KIND = "clean-core-wink-expression-review"
WINK_REVIEW_FILENAME = "wink-expression-review.json"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def valid_digest(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate selection review JSON key: " + key)
        result[key] = value
    return result


def invalid_constant(value: str) -> None:
    raise ValueError("Non-finite selection review JSON constant: " + value)


def read_document(path: Path | str, receipt_sha256: str, records_sha256: str) -> tuple[bytes, dict, frozenset[str]]:
    raw = Path(path).read_bytes()
    document = json.loads(raw, object_pairs_hook=unique_object, parse_constant=invalid_constant)
    require(isinstance(document, dict), "Selection review must be a JSON object")
    require(type(document.get("schemaVersion")) is int and document["schemaVersion"] == 1,
            "Selection review schemaVersion must be 1")
    require(document.get("documentKind") == DOCUMENT_KIND and document.get("mode") == "deny-only",
            "Only an explicit deny-only selection review is supported")
    require(valid_digest(receipt_sha256) and document.get("candidateAuditSha256") == receipt_sha256,
            "Selection review is bound to another candidate audit")
    require(valid_digest(records_sha256) and document.get("recordsSha256") == records_sha256,
            "Selection review is bound to another admission database")
    require(document.get("reviewer") == "assistant-visual-review" and document.get("humanVerified") is False,
            "Selection review must accurately identify assistant visual review")
    reviewed_on = document.get("reviewedOn")
    require(isinstance(reviewed_on, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", reviewed_on) is not None,
            "Selection review requires an ISO review date")
    date.fromisoformat(reviewed_on)
    predecessor = document.get("previousReviewSha256")
    require(predecessor is None or valid_digest(predecessor), "Invalid predecessor review digest")
    reviews = document.get("reviews")
    require(isinstance(reviews, list), "Selection review requires a reviews array")
    denied: set[str] = set()
    for row in reviews:
        require(isinstance(row, dict), "Each selection review must be an object")
        digest = row.get("encodedSha256")
        require(valid_digest(digest), "Selection exclusion requires an exact encoded SHA-256")
        require(digest not in denied, "Repeated image digest in selection review")
        require(row.get("decision") == "deny", "Selection review cannot admit or override any candidate")
        require(isinstance(row.get("reason"), str) and bool(row["reason"].strip()),
                "Every selection denial requires a reason")
        source_catalog, source_id = row.get("sourceCatalogId"), row.get("sourceId")
        require((source_catalog is None and source_id is None) or
                (isinstance(source_catalog, str) and bool(source_catalog.strip()) and "\0" not in source_catalog
                 and isinstance(source_id, str) and bool(source_id.strip()) and "\0" not in source_id),
                "Selection review source evidence requires both catalog and image ID")
        evidence = row.get("evidence")
        if isinstance(evidence, dict):
            if "imageSha256" in evidence:
                require(evidence["imageSha256"] == digest, "Reviewed evidence describes different image bytes")
            if "pixelChangesApplied" in evidence:
                require(evidence["pixelChangesApplied"] is False, "Selection review must inspect original image pixels")
        denied.add(digest)
    return raw, document, frozenset(denied)


class SelectionReview:
    """Validated deny set, bound to the original completed audit and database."""

    def __init__(self, path: Path | str, receipt_sha256: str, records_sha256: str,
                 previous_path: Path | str | None = None) -> None:
        self.raw_bytes, self.document, self.denied = read_document(path, receipt_sha256, records_sha256)
        self.sha256 = hashlib.sha256(self.raw_bytes).hexdigest()
        self.previous_bytes: bytes | None = None
        previous_digest = self.document.get("previousReviewSha256")
        if previous_digest is None:
            require(previous_path is None, "A predecessor file was supplied without its bound review digest")
        else:
            require(previous_path is not None, "The exact previous selection review is required")
            previous_raw, _, previous_denied = read_document(previous_path, receipt_sha256, records_sha256)
            require(hashlib.sha256(previous_raw).hexdigest() == previous_digest,
                    "Previous selection review digest mismatch")
            require(previous_denied <= self.denied, "Selection review revisions may only add exclusions")
            self.previous_bytes = previous_raw

    def validate_audit_records(self, connection: Any) -> None:
        """Check evidence IDs without changing any original decision or row."""
        for review in self.document["reviews"]:
            rows = connection.execute(
                "SELECT source_catalog_id,source_id FROM records WHERE encoded_sha256=?",
                (review["encodedSha256"],),
            ).fetchall()
            require(bool(rows), "Selection review image is absent from the completed audit")
            if review.get("sourceCatalogId") is not None:
                require((review["sourceCatalogId"], review["sourceId"]) in rows,
                        "Selection review source ID does not match its audited image bytes")

    def excludes(self, encoded_sha256: str) -> bool:
        require(valid_digest(encoded_sha256), "Selection gate requires a valid encoded image digest")
        return encoded_sha256 in self.denied

    def require_payload(self, payload: bytes) -> str:
        digest = hashlib.sha256(payload).hexdigest()
        require(not self.excludes(digest), "A reviewed excluded image reached physical selection")
        return digest

    def stamp(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1, "documentKind": DOCUMENT_KIND, "mode": "deny-only",
            "reviewPath": REVIEW_FILENAME, "reviewSha256": self.sha256,
            "candidateAuditSha256": self.document["candidateAuditSha256"],
            "recordsSha256": self.document["recordsSha256"],
            "excludedEncodedImages": len(self.denied),
            "previousReviewSha256": self.document.get("previousReviewSha256"),
            "previousReviewPath": PREVIOUS_FILENAME if self.previous_bytes is not None else None,
            "reviewer": self.document["reviewer"], "humanVerified": self.document["humanVerified"],
            "reviewedOn": self.document["reviewedOn"],
        }

    def write_catalog_files(self, catalog: Path | str) -> None:
        catalog = Path(catalog)
        (catalog / REVIEW_FILENAME).write_bytes(self.raw_bytes)
        if self.previous_bytes is not None:
            (catalog / PREVIOUS_FILENAME).write_bytes(self.previous_bytes)

    def verify_catalog_files(self, catalog: Path | str) -> None:
        catalog = Path(catalog)
        require((catalog / REVIEW_FILENAME).read_bytes() == self.raw_bytes,
                "Physical catalog selection review differs from the bound review file")
        previous = catalog / PREVIOUS_FILENAME
        if self.previous_bytes is None:
            require(not previous.exists(), "Unbound predecessor review in physical catalog")
        else:
            require(previous.read_bytes() == self.previous_bytes,
                    "Physical catalog predecessor review differs from its bound file")


class WinkExpressionReview:
    """Reviewed anatomical side; never an image-admission override.

    A confirmation is necessary but not sufficient: callers must still verify
    original PASS admission, additional image denials and automatic same-side
    feature/landmark corroboration. Unreviewed and uncertain photos may qualify
    for other expression profiles.
    """

    def __init__(self, path: Path | str, receipt_sha256: str, records_sha256: str) -> None:
        self.raw_bytes = Path(path).read_bytes()
        self.document = json.loads(self.raw_bytes, object_pairs_hook=unique_object, parse_constant=invalid_constant)
        document = self.document
        require(isinstance(document, dict) and type(document.get("schemaVersion")) is int
                and document["schemaVersion"] == 1, "Wink expression review schemaVersion must be 1")
        require(document.get("documentKind") == WINK_DOCUMENT_KIND and document.get("mode") == "confirmed-side-only",
                "An explicit confirmed-side-only wink expression review is required")
        require(valid_digest(receipt_sha256) and document.get("candidateAuditSha256") == receipt_sha256,
                "Wink expression review is bound to another candidate audit")
        require(valid_digest(records_sha256) and document.get("recordsSha256") == records_sha256,
                "Wink expression review is bound to another admission database")
        require(document.get("reviewer") == "assistant-visual-review" and document.get("humanVerified") is False,
                "Wink review must accurately identify assistant visual review")
        reviewed_on = document.get("reviewedOn")
        require(isinstance(reviewed_on, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", reviewed_on) is not None,
                "Wink expression review requires an ISO review date")
        date.fromisoformat(reviewed_on)
        require(isinstance(document.get("reviews"), list), "Wink expression review requires a reviews array")
        seen, self.confirmed_sides = set(), {}
        for row in document["reviews"]:
            require(isinstance(row, dict) and valid_digest(row.get("encodedSha256")),
                    "Wink review requires an exact encoded SHA-256")
            digest, decision, side = row["encodedSha256"], row.get("decision"), row.get("side")
            require(digest not in seen, "Repeated image digest in wink expression review")
            require(decision in ("confirmed", "uncertain", "does-not-match"), "Invalid wink expression review decision")
            require((decision == "confirmed" and side in ("left", "right")) or
                    (decision != "confirmed" and side is None), "Only confirmed winks may declare an anatomical side")
            require(isinstance(row.get("reason"), str) and bool(row["reason"].strip()),
                    "Wink expression review requires a reason")
            source_catalog, source_id = row.get("sourceCatalogId"), row.get("sourceId")
            require((source_catalog is None and source_id is None) or
                    (isinstance(source_catalog, str) and bool(source_catalog.strip()) and "\0" not in source_catalog
                     and isinstance(source_id, str) and bool(source_id.strip()) and "\0" not in source_id),
                    "Wink review source evidence requires both catalog and image ID")
            evidence = row.get("evidence")
            if isinstance(evidence, dict):
                if "imageSha256" in evidence:
                    require(evidence["imageSha256"] == digest, "Wink review evidence describes different image bytes")
                if "pixelChangesApplied" in evidence:
                    require(evidence["pixelChangesApplied"] is False, "Wink review must inspect original pixels")
                if "recordSha256" in evidence:
                    require(valid_digest(evidence["recordSha256"]) and source_catalog is not None,
                            "Wink record evidence requires an exact digest and source identity")
            seen.add(digest)
            if decision == "confirmed":
                self.confirmed_sides[digest] = side
        self.sha256 = hashlib.sha256(self.raw_bytes).hexdigest()

    def validate_audit_records(self, connection: Any) -> None:
        for review in self.document["reviews"]:
            rows = connection.execute("SELECT source_catalog_id,source_id,record_sha256 FROM records WHERE encoded_sha256=?",
                                      (review["encodedSha256"],)).fetchall()
            require(bool(rows), "Wink review image is absent from the completed audit")
            if review.get("sourceCatalogId") is not None:
                matching = [row for row in rows if row[:2] == (review["sourceCatalogId"], review["sourceId"])]
                require(bool(matching),
                        "Wink review source ID does not match its audited image bytes")
                evidence = review.get("evidence")
                record_digest = evidence.get("recordSha256") if isinstance(evidence, dict) else None
                if record_digest is not None:
                    require(any(row[2] == record_digest for row in matching),
                            "Wink review record digest does not match its exact audited source row")

    def side_for(self, encoded_sha256: str) -> str | None:
        require(valid_digest(encoded_sha256), "Wink review lookup requires an exact encoded image digest")
        return self.confirmed_sides.get(encoded_sha256)

    def evidence_for(self, encoded_sha256: str, side: str) -> dict[str, Any]:
        require(side in ("left", "right") and self.side_for(encoded_sha256) == side,
                "Wink profile lacks same-side exact-image visual confirmation")
        return {"schemaVersion": 1, "encodedSha256": encoded_sha256, "side": side, "reviewSha256": self.sha256}

    def stamp(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1, "documentKind": WINK_DOCUMENT_KIND, "mode": "confirmed-side-only",
            "reviewPath": WINK_REVIEW_FILENAME, "reviewSha256": self.sha256,
            "candidateAuditSha256": self.document["candidateAuditSha256"], "recordsSha256": self.document["recordsSha256"],
            "reviewedEncodedImages": len(self.document["reviews"]), "confirmedEncodedImages": len(self.confirmed_sides),
            "confirmedSides": {side: sum(value == side for value in self.confirmed_sides.values()) for side in ("left", "right")},
            "reviewer": self.document["reviewer"], "humanVerified": self.document["humanVerified"],
            "reviewedOn": self.document["reviewedOn"],
        }

    def write_catalog_files(self, catalog: Path | str) -> None:
        (Path(catalog) / WINK_REVIEW_FILENAME).write_bytes(self.raw_bytes)

    def verify_catalog_files(self, catalog: Path | str) -> None:
        require((Path(catalog) / WINK_REVIEW_FILENAME).read_bytes() == self.raw_bytes,
                "Physical catalog wink expression review differs from its exact bound file")
