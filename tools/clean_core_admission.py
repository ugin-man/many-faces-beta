#!/usr/bin/env python3
"""Exact-image, pre-selection admission for the physical Clean Core catalog.

Model scores are not calibrated probabilities. High visibility scores leave a
candidate unresolved unless an exact-image visual review supplies a decision.
No title, clear-eyeglasses score, or face-paint label is an exclusion rule.
The model dependencies are imported only when AdmissionEngine is constructed.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import sqlite3
import struct
import zlib
from collections import Counter, OrderedDict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import quote

from clean_core_policy_v2 import BLEND_KEYS, FEATURE_LENGTH, quantized_pose_cell

SCHEMA_VERSION = 2
POLICY_ID = "exact-pixel-clean-core-admission-v1"
ATTRIBUTE_NAMES = ("left_eye_open", "right_eye_open", "eyeglasses", "mask", "sunglasses")
REQUIRED_CHECKS = ("decode", "face", "pose", "visibility", "detail")
PREPROCESSOR_ID = "mesh-bbox-scale1.2-rgb128-floor-area-letterbox-v1"


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha256_file(path: Path | str) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def source_key(catalog_id: str, identity: str) -> str:
    if not catalog_id or not identity or "\0" in catalog_id or "\0" in identity:
        raise ValueError("Source catalog and image IDs must be nonempty and contain no NUL")
    return catalog_id + "\0" + identity


def feature_sha256(entry: Mapping[str, Any]) -> str:
    # A malformed source feature must still receive a stable rejection record.
    raw = json.dumps(entry.get("feature"), ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=True).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def valid_digest(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


@dataclass(frozen=True)
class AdmissionPolicy:
    visibility_max_score: float = .05
    detection_confidence: float = .45
    face_crop_scale: float = 1.20  # 20% extra total width/height, 10% per edge.
    minimum_face_pixels: float = 60.0
    critical_edge_margin: float = .01
    mirror_check: bool = False

    def __post_init__(self) -> None:
        if not math.isfinite(self.visibility_max_score) or not 0 < self.visibility_max_score <= 1:
            raise ValueError("visibility_max_score must be in (0, 1]")
        if self.detection_confidence != .45 or self.face_crop_scale != 1.20:
            raise ValueError("Changing detection/crop semantics requires a new admission policy")
        if self.minimum_face_pixels != 60.0 or self.critical_edge_margin != .01:
            raise ValueError("Changing geometric gates requires a new admission policy")
        if not isinstance(self.mirror_check, bool):
            raise ValueError("mirror_check must be a boolean")

    def document(self) -> dict[str, Any]:
        return {
            "policyId": POLICY_ID, "preprocessorId": PREPROCESSOR_ID,
            "parameters": asdict(self), "attributeNames": list(ATTRIBUTE_NAMES),
            "visibilityInput": "tight-face-crop", "fullFrameScores": "diagnostic-only",
            "poseConvention": "python-row-major-with-pitch1.4-clamped-v3",
            "poseCells": "v3-round3-clamp-yaw45-pitch36",
            "geometryEncoding": "int16-scale4096-clamped-v3",
            "imageQuality": "whole-image-clean-core-v3-thresholds",
            "requiredChecks": list(REQUIRED_CHECKS), "scoresCalibrated": False,
            "clearEyeglassesAllowed": True, "facePaintAllowed": True,
        }

    @property
    def sha256(self) -> str:
        return hashlib.sha256(json_bytes(self.document())).hexdigest()

    @classmethod
    def from_document(cls, document: Mapping[str, Any]) -> "AdmissionPolicy":
        if document.get("policyId") != POLICY_ID:
            raise ValueError("Unknown admission policy")
        policy = cls(**dict(document.get("parameters", {})))
        if policy.document() != dict(document):
            raise ValueError("Incomplete or altered admission policy document")
        return policy


def validate_attribute_scores(values: Sequence[Any]) -> list[float]:
    if len(values) != 5:
        raise ValueError("FaceAttribNet must return five independent scores")
    result = [float(value) for value in values]
    if not all(math.isfinite(value) and 0 <= value <= 1 for value in result):
        raise ValueError("Invalid FaceAttribNet score")
    return result


def visibility_decision(values: Sequence[Any], policy: AdmissionPolicy, review: Mapping[str, Any] | None = None) -> tuple[str, str]:
    scores = validate_attribute_scores(values)
    if review is not None:
        if review.get("decision") == "deny":
            return "reject", "reviewed_visibility_deny"
        if review.get("decision") == "allow":
            return "pass", "reviewed_visibility_allow"
        raise ValueError("Invalid visibility review decision")
    if max(scores[3], scores[4]) >= policy.visibility_max_score:
        return "unresolved", "visibility_unresolved"
    return "pass", "visibility_scores_below_admission_limit"


def load_visibility_reviews(path: Path | str | None) -> dict[str, dict[str, Any]]:
    if path is None:
        return {}
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("schemaVersion") != 1 or not isinstance(payload.get("reviews"), list):
        raise ValueError("Visibility reviews require schemaVersion 1 and a reviews list")
    result: dict[str, dict[str, Any]] = {}
    for row in payload["reviews"]:
        if not isinstance(row, dict) or not valid_digest(row.get("encodedSha256")):
            raise ValueError("Each visibility review must bind an exact encodedSha256")
        if row.get("decision") not in ("allow", "deny") or not str(row.get("reason", "")).strip():
            raise ValueError("Each visibility review needs an allow/deny decision and reason")
        digest = row["encodedSha256"]
        if digest in result and result[digest] != row:
            raise ValueError("Conflicting duplicate visibility review")
        result[digest] = dict(row)
    return result


def load_digest_exclusions(path: Path | str | None) -> dict[str, dict[str, Any]]:
    if path is None:
        return {}
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = payload.get("excluded") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError("Digest exclusions must contain an excluded list")
    result = {}
    for row in rows:
        if not isinstance(row, dict) or not valid_digest(row.get("encodedSha256")):
            raise ValueError("Prior yaw exclusions must already be bound to encodedSha256")
        result[row["encodedSha256"]] = dict(row)
    return result


def flattened_matrix(matrix: Any) -> list[float]:
    if hasattr(matrix, "tolist"):
        matrix = matrix.tolist()
    elif hasattr(matrix, "data"):
        matrix = matrix.data
    result: list[float] = []

    def append(value: Any) -> None:
        if isinstance(value, (str, bytes)):
            raise ValueError("Non-numeric face transform")
        try:
            number = float(value)
        except (ValueError, TypeError):
            for child in value:
                append(child)
        else:
            result.append(number)

    append(matrix)
    if len(result) != 16 or not all(math.isfinite(value) for value in result):
        raise ValueError("A finite 16-value face transform is required")
    return result


def fresh_feature(result: Any) -> list[float]:
    if len(result.face_landmarks) != 1 or not result.face_blendshapes or not result.facial_transformation_matrixes:
        raise ValueError("One face with blendshapes and transform is required")
    values = flattened_matrix(result.facial_transformation_matrixes[0])
    half_pi = math.pi / 2
    clamp = lambda value: max(-1.0, min(1.0, value))
    pose = [
        clamp(math.atan2(-values[8], math.hypot(values[9], values[10])) / half_pi),
        clamp(math.atan2(values[9], values[10]) / half_pi * 1.4),
        clamp(math.atan2(values[4], values[0]) / half_pi),
    ]
    scores = {category.category_name: float(category.score) for category in result.face_blendshapes[0]}
    if not all(key in scores for key in BLEND_KEYS):
        raise ValueError("Face model returned an incomplete action schema")
    if not all(math.isfinite(value) and 0 <= value <= 1 for value in scores.values()):
        raise ValueError("Face model returned invalid actions")
    return pose + [scores[key] for key in BLEND_KEYS]


def opposite_pose(stored_yaw: float, fresh_yaw: float) -> bool:
    return (math.isfinite(stored_yaw) and math.isfinite(fresh_yaw)
            and abs(stored_yaw) >= 12 and abs(fresh_yaw) >= 8
            and stored_yaw * fresh_yaw < 0 and abs(stored_yaw - fresh_yaw) >= 20)


def encode_geometry(values: Sequence[float]) -> str:
    if not all(math.isfinite(value) for value in values):
        raise ValueError("Nonfinite face geometry")
    quantized = [max(-32768, min(32767, round(value * 4096))) for value in values]
    return base64.b64encode(struct.pack("<" + "h" * len(quantized), *quantized)).decode("ascii")


def tight_crop_rect(layout: Sequence[float], width: int, height: int, scale: float = 1.2) -> tuple[int, int, int, int]:
    if len(layout) != 4 or not all(math.isfinite(float(value)) for value in layout):
        raise ValueError("Invalid face layout")
    cx, cy, face_width, face_height = map(float, layout)
    if min(face_width, face_height) <= 0 or min(width, height) <= 0:
        raise ValueError("Empty face layout")
    rect = (max(0, math.floor((cx - face_width * scale / 2) * width)),
            max(0, math.floor((cy - face_height * scale / 2) * height)),
            min(width, math.ceil((cx + face_width * scale / 2) * width)),
            min(height, math.ceil((cy + face_height * scale / 2) * height)))
    if rect[0] >= rect[2] or rect[1] >= rect[3]:
        raise ValueError("Face crop does not overlap image")
    return rect


def attribute_blob(image: Any) -> Any:
    import cv2
    import numpy as np
    rgb = np.asarray(image.convert("RGB"))
    height, width = rgb.shape[:2]
    scale = min(128 / height, 128 / width)
    new_height, new_width = max(1, math.floor(height * scale)), max(1, math.floor(width * scale))
    if 128 / height < 128 / width:
        new_height = 128
    else:
        new_width = 128
    resized = cv2.resize(rgb, (new_width, new_height), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
    canvas = np.zeros((128, 128, 3), dtype=np.uint8)
    top, left = (128 - new_height) // 2, (128 - new_width) // 2
    canvas[top:top + new_height, left:left + new_width] = resized
    return np.transpose(canvas.astype(np.float32) / 255.0, (2, 0, 1))[None, ...]


def image_quality_metrics(image: Any) -> dict[str, float]:
    import numpy as np
    from PIL import Image
    pixels = np.asarray(image.resize((128, 128), Image.Resampling.BILINEAR), dtype=np.float32)
    gray = pixels[:, :, 0] * .299 + pixels[:, :, 1] * .587 + pixels[:, :, 2] * .114
    lap = (-4 * gray + np.roll(gray, 1, 0) + np.roll(gray, -1, 0) + np.roll(gray, 1, 1) + np.roll(gray, -1, 1))[1:-1, 1:-1]
    rg = pixels[:, :, 0] - pixels[:, :, 1]
    yb = (pixels[:, :, 0] + pixels[:, :, 1]) / 2 - pixels[:, :, 2]
    color = math.sqrt(float(rg.var() + yb.var())) + .3 * math.sqrt(float(rg.mean() ** 2 + yb.mean() ** 2))
    return {"sharpness": float(lap.var()), "brightness": float(gray.mean()), "contrast": float(gray.std()),
            "colorfulness": color, "clippedFraction": float(((gray < 8) | (gray > 247)).mean())}


def image_quality_decision(metrics: Mapping[str, float], source_text: str) -> tuple[bool, str, float]:
    is_ffhq = "ffhq" in source_text.lower()
    sharp_min, contrast_min = (24, 18) if is_ffhq else (42, 23)
    color_min, bright_min, bright_max, clip_max = (0, 28, 226, .48) if is_ffhq else (4.5, 34, 220, .42)
    if not all(math.isfinite(float(value)) for value in metrics.values()):
        return False, "invalid_image_quality", 0.0
    if metrics["sharpness"] < sharp_min: return False, "blur", 0.0
    if not bright_min <= metrics["brightness"] <= bright_max: return False, "brightness", 0.0
    if metrics["contrast"] < contrast_min: return False, "low_contrast", 0.0
    if metrics["colorfulness"] < color_min: return False, "low_colorfulness", 0.0
    if metrics["clippedFraction"] > clip_max: return False, "clipping", 0.0
    score = (min(1.0, math.log1p(metrics["sharpness"]) / math.log1p(720)) * .33
             + max(0.0, 1 - abs(metrics["brightness"] - 118) / 118) * .18
             + min(1.0, metrics["contrast"] / 68) * .24
             + min(1.0, metrics["colorfulness"] / 58) * .10
             + max(0.0, 1 - metrics["clippedFraction"] / clip_max) * .15)
    return True, "", score


def base_record(entry: Mapping[str, Any], catalog_id: str, source_label: str, policy: AdmissionPolicy, payload: bytes | None) -> dict[str, Any]:
    identity = str(entry.get("id") or "")
    return {
        "schemaVersion": SCHEMA_VERSION, "policyId": POLICY_ID, "policySha256": policy.sha256,
        "sourceKey": source_key(catalog_id, identity), "sourceCatalogId": catalog_id,
        "sourceId": identity, "sourceLabel": source_label,
        "encodedSha256": hashlib.sha256(payload).hexdigest() if payload is not None else None,
        "byteLength": len(payload) if payload is not None else None,
        "sourceFeatureSha256": feature_sha256(entry),
        "decision": "unresolved", "reasons": [],
        "checks": {name: "not_run" for name in REQUIRED_CHECKS},
        "freshYaw": None, "freshPitch": None, "freshRoll": None,
        "fullAttributes": None, "faceAttributes": None,
    }


class AdmissionEngine:
    def __init__(self, model_path: Path | str, face_model_path: Path | str,
                 policy: AdmissionPolicy | Mapping[str, Any] | None = None,
                 reviewed_path: Path | str | None = None, prior_exclusions_path: Path | str | None = None,
                 *, reviews: Mapping[str, Mapping[str, Any]] | None = None,
                 prior_exclusions: Mapping[str, Mapping[str, Any]] | None = None) -> None:
        import numpy as np
        import onnxruntime as ort
        import mediapipe as mp
        import PIL
        import cv2
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision
        from build_face_catalog import face_geometry

        self.policy = policy if isinstance(policy, AdmissionPolicy) else AdmissionPolicy(**dict(policy or {}))
        self.reviews = dict(reviews) if reviews is not None else load_visibility_reviews(reviewed_path)
        self.prior_exclusions = dict(prior_exclusions) if prior_exclusions is not None else load_digest_exclusions(prior_exclusions_path)
        self.model_sha256 = sha256_file(model_path)
        self.face_model_sha256 = sha256_file(face_model_path)
        self.np, self.mp, self.face_geometry = np, mp, face_geometry
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        self.attribute_session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
        inp = self.attribute_session.get_inputs()[0]
        if len(inp.shape) != 4 or list(inp.shape[1:]) != [3, 128, 128]:
            raise ValueError("Unexpected FaceAttribNet input schema")
        self.attribute_input = inp.name
        self.attribute_output = self.attribute_session.get_outputs()[0].name
        landmark_options = vision.FaceLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=str(face_model_path)),
            running_mode=vision.RunningMode.IMAGE, num_faces=2,
            output_face_blendshapes=True, output_facial_transformation_matrixes=True,
            min_face_detection_confidence=self.policy.detection_confidence,
            min_face_presence_confidence=self.policy.detection_confidence,
            min_tracking_confidence=self.policy.detection_confidence,
        )
        self.detector = vision.FaceLandmarker.create_from_options(landmark_options)
        self.runtime_versions = {"mediapipe": mp.__version__, "onnxruntime": ort.__version__, "numpy": np.__version__,
                                 "Pillow": PIL.__version__, "cv2": cv2.__version__}

    def close(self) -> None:
        self.detector.close()

    def __enter__(self) -> "AdmissionEngine":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def attributes(self, image: Any) -> list[float]:
        values = self.attribute_session.run([self.attribute_output], {self.attribute_input: attribute_blob(image)})[0]
        return validate_attribute_scores(self.np.asarray(values).reshape(-1).tolist())

    def detect(self, image: Any) -> Any:
        return self.detector.detect(self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=self.np.ascontiguousarray(image)))

    def evaluate(self, payload: bytes, entry: Mapping[str, Any], source_catalog_id: str, source_label: str = "") -> dict[str, Any]:
        from PIL import Image, ImageOps
        record = base_record(entry, source_catalog_id, source_label, self.policy, payload)

        def finish(decision: str, reason: str, check: str | None = None) -> dict[str, Any]:
            record["decision"] = decision
            record["reasons"] = [reason]
            if check:
                record["checks"][check] = decision
            return record

        if record["encodedSha256"] in self.prior_exclusions:
            record["priorYawEvidence"] = self.prior_exclusions[record["encodedSha256"]]
            return finish("reject", "prior_yaw_contradiction", "pose")
        try:
            with Image.open(io.BytesIO(payload)) as opened:
                image = ImageOps.exif_transpose(opened).convert("RGB")
        except (OSError, ValueError) as error:
            record["error"] = str(error)
            return finish("unresolved", "image_decode_error", "decode")
        record["checks"]["decode"] = "pass"
        record["imageSize"] = list(image.size)
        original_feature = entry.get("feature")
        if not isinstance(original_feature, (list, tuple)) or len(original_feature) != FEATURE_LENGTH or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in original_feature):
            return finish("unresolved", "invalid_source_feature", "pose")
        record["storedYaw"] = float(original_feature[0]) * 90
        try:
            result = self.detect(image)
        except (ValueError, RuntimeError) as error:
            record["error"] = str(error)
            return finish("unresolved", "face_inference_error", "face")
        record["faceCount"] = len(result.face_landmarks)
        if record["faceCount"] != 1:
            return finish("unresolved", "no_single_face", "face")
        try:
            feature = fresh_feature(result)
            geometry = self.face_geometry(result.face_landmarks[0])
            if geometry is None:
                raise ValueError("Invalid landmark geometry")
            shape, mesh, projection, layout = geometry
            record.update({"feature": feature, "shape": encode_geometry(shape), "mesh": encode_geometry(mesh),
                           "projection": encode_geometry(projection), "layout": list(layout),
                           "freshYaw": feature[0] * 90, "freshPitch": feature[1] * 90, "freshRoll": feature[2] * 90,
                           "cell": quantized_pose_cell(feature, 3)[0]})
        except (ValueError, TypeError, IndexError) as error:
            record["error"] = str(error)
            return finish("unresolved", "invalid_fresh_face_measurement", "face")
        points = result.face_landmarks[0]
        edge = self.policy.critical_edge_margin
        if any(not (edge <= float(points[i].x) <= 1 - edge and edge <= float(points[i].y) <= 1 - edge) for i in (33, 133, 362, 263, 13, 14, 61, 291, 1)):
            return finish("unresolved", "critical_region_truncated", "face")
        if layout[3] * image.height < self.policy.minimum_face_pixels or min(layout[2:4]) <= 0:
            return finish("unresolved", "insufficient_face_pixels", "face")
        record["checks"]["face"] = "pass"
        if opposite_pose(record["storedYaw"], record["freshYaw"]):
            return finish("reject", "yaw_contradiction", "pose")
        if self.policy.mirror_check and abs(record["freshYaw"]) >= 12:
            try:
                mirrored = self.detect(image.transpose(Image.Transpose.FLIP_LEFT_RIGHT))
                mirrored_yaw = fresh_feature(mirrored)[0] * 90
                record["mirrorYaw"] = mirrored_yaw
                if record["freshYaw"] * mirrored_yaw >= 0 or abs(record["freshYaw"] + mirrored_yaw) > 12:
                    return finish("unresolved", "pose_unstable_under_check", "pose")
            except (ValueError, TypeError, IndexError, RuntimeError) as error:
                record["error"] = str(error)
                return finish("unresolved", "pose_check_unresolved", "pose")
        record["checks"]["pose"] = "pass"
        try:
            rect = tight_crop_rect(layout, image.width, image.height, self.policy.face_crop_scale)
            record["cropRectPx"] = list(rect)
            record["faceAttributes"] = self.attributes(image.crop(rect))
            record["fullAttributes"] = self.attributes(image)
        except (ValueError, RuntimeError) as error:
            record["error"] = str(error)
            return finish("unresolved", "attribute_inference_error", "visibility")
        metrics = image_quality_metrics(image)
        quality_ok, quality_reason, quality_score = image_quality_decision(metrics, source_label + " " + source_catalog_id)
        record["imageQuality"] = metrics
        record["qualityScore"] = quality_score
        if not quality_ok:
            return finish("reject", "image_quality_" + quality_reason, "detail")
        record["checks"]["detail"] = "pass"
        review = self.reviews.get(record["encodedSha256"])
        visibility, reason = visibility_decision(record["faceAttributes"], self.policy, review)
        if review:
            record["visibilityReview"] = dict(review)
        return finish(visibility, reason, "visibility")


def referenced_shards(manifest: Mapping[str, Any]) -> list[str]:
    names: list[str] = []
    for cell in manifest.get("cells", {}).values():
        names.extend(cell.get("shards") or ([cell["shard"]] if cell.get("shard") else []))
    if len(names) != len(set(names)):
        raise ValueError("A source shard is referenced more than once")
    return sorted(names)


def safe_child(root: Path, relative: str) -> Path:
    result = (root / relative).resolve()
    if not result.is_relative_to(root.resolve()):
        raise ValueError("Source path leaves its catalog")
    return result


def key_set_sha256(keys: Iterable[str]) -> str:
    digest = hashlib.sha256()
    for key in sorted(keys):
        value = key.encode("utf-8")
        digest.update(struct.pack(">I", len(value)))
        digest.update(value)
    return digest.hexdigest()


def fingerprint_catalog(label: str, root: Path | str) -> dict[str, Any]:
    root = Path(root).resolve()
    manifest_raw = (root / "manifest.json").read_bytes()
    manifest = json.loads(manifest_raw)
    catalog_id = str(manifest.get("catalogId") or label)
    if manifest.get("schemaVersion") != 3 or manifest.get("featureLength") != FEATURE_LENGTH:
        raise ValueError("Admission sources must be schema 3 with 55 face features")
    keys: set[str] = set()
    shards = []
    cell_counts: Counter[str] = Counter()
    for name in referenced_shards(manifest):
        raw = safe_child(root / "shards", name).read_bytes()
        payload = json.loads(raw)
        entries = payload.get("items")
        if not isinstance(entries, list):
            raise ValueError("Source shard has no items list")
        for entry in entries:
            key = source_key(catalog_id, str(entry.get("id") or ""))
            if key in keys:
                raise ValueError("Duplicate source image ID")
            keys.add(key)
        cell_counts[str(payload.get("cell"))] += len(entries)
        shards.append({"path": "shards/" + name, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "rows": len(entries)})
    expected = int(manifest.get("searchableFaces", manifest.get("totalFaces", -1)))
    if expected != len(keys):
        raise ValueError(f"Source searchable count mismatch: {catalog_id}: {len(keys)} != {expected}")
    if {key: int(cell.get("count", -1)) for key, cell in manifest.get("cells", {}).items()} != dict(cell_counts):
        raise ValueError("Source per-cell row counts do not match its manifest")
    indexes = [{"path": name, "sha256": sha256_file(safe_child(root, name))} for name in manifest.get("indexFiles", [])]
    result = {"label": label, "catalogId": catalog_id, "manifestSha256": hashlib.sha256(manifest_raw).hexdigest(),
              "expectedRows": expected, "sourceKeySetSha256": key_set_sha256(keys), "shards": shards, "indexes": indexes}
    result["fingerprintSha256"] = hashlib.sha256(json_bytes(result)).hexdigest()
    return result


def normalize_sources(sources: Iterable[Any]) -> list[dict[str, Any]]:
    result = []
    for value in sources:
        if isinstance(value, str):
            label, separator, root = value.partition("=")
            if not separator or not label or not root:
                raise ValueError("Catalog arguments must be LABEL=PATH")
        elif isinstance(value, Mapping):
            label, root = str(value["label"]), value["root"]
        elif isinstance(value, (tuple, list)) and len(value) == 2:
            label, root = value
        else:
            label, root = value.label, value.root
        result.append({"label": str(label), "root": str(Path(root).resolve())})
    if not result:
        raise ValueError("At least one catalog is required")
    return result


def iter_catalog_entries(root: Path | str) -> Iterable[dict[str, Any]]:
    root = Path(root)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    for name in referenced_shards(manifest):
        payload = json.loads(safe_child(root / "shards", name).read_text(encoding="utf-8"))
        yield from payload["items"]


class PackedImageReader:
    def __init__(self, root: Path | str, maximum_handles: int = 24) -> None:
        self.root = Path(root)
        self.maximum_handles = maximum_handles
        self.handles: OrderedDict[str, Any] = OrderedDict()

    def read(self, entry: Mapping[str, Any]) -> bytes:
        if entry.get("image"):
            return safe_child(self.root / "images", str(entry["image"])).read_bytes()
        pack = str(entry["pack"])
        offset, length = entry["offset"], entry["length"]
        if not isinstance(offset, int) or not isinstance(length, int) or offset < 0 or length <= 0:
            raise ValueError("Invalid packed image range")
        handle = self.handles.pop(pack, None)
        if handle is None:
            handle = safe_child(self.root / "packs", pack).open("rb")
        self.handles[pack] = handle
        while len(self.handles) > self.maximum_handles:
            self.handles.popitem(last=False)[1].close()
        handle.seek(offset)
        payload = handle.read(length)
        if len(payload) != length:
            raise ValueError("Truncated packed image")
        return payload

    def close(self) -> None:
        for handle in self.handles.values():
            handle.close()
        self.handles.clear()

    def __enter__(self) -> "PackedImageReader":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


def resolve_prior_yaw_exclusions(path: Path | str, sources: Sequence[Mapping[str, Any]], fingerprints: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    evidence = json.loads(Path(path).read_text(encoding="utf-8"))
    if evidence.get("documentKind") != "existing-catalog-quality-audit-evidence" or not evidence.get("evidenceIntegrationComplete"):
        raise ValueError("Prior yaw evidence has not completed integration")
    yaw = evidence.get("yaw", {})
    if not yaw.get("idCoverageComplete"):
        raise ValueError("Prior yaw partition coverage is incomplete")
    previous_source = evidence.get("source", {})
    matches = [(source, fp) for source, fp in zip(sources, fingerprints) if fp["catalogId"] == previous_source.get("catalogId")]
    if len(matches) != 1:
        raise ValueError("Prior yaw source is absent or ambiguous")
    source, current = matches[0]
    if current["manifestSha256"] != previous_source.get("manifestSha256"):
        raise ValueError("Prior yaw source manifest changed")
    expected_shards = {row["path"]: row["sha256"] for row in previous_source.get("shards", [])}
    if expected_shards != {row["path"]: row["sha256"] for row in current["shards"]}:
        raise ValueError("Prior yaw source shards changed")
    contradictions = yaw.get("contradictions", [])
    if len(contradictions) != yaw.get("contradictionCount"):
        raise ValueError("Prior yaw contradiction count mismatch")
    requested = {str(row["id"]): row for row in contradictions}
    if len(requested) != len(contradictions):
        raise ValueError("Duplicate prior yaw IDs")
    root = Path(source["root"])
    pack_hashes = {row["path"]: row["sha256"] for row in previous_source.get("imageFiles", [])}
    checked_paths = set()
    resolved = {}
    evidence_hash = sha256_file(path)
    with PackedImageReader(root) as reader:
        for entry in iter_catalog_entries(root):
            prior = requested.pop(str(entry["id"]), None)
            if prior is None:
                continue
            relative = "images/" + entry["image"] if entry.get("image") else "packs/" + entry["pack"]
            if relative not in checked_paths:
                if pack_hashes.get(relative) != sha256_file(safe_child(root, relative)):
                    raise ValueError("Prior yaw source image bytes changed")
                checked_paths.add(relative)
            payload = reader.read(entry)
            digest = hashlib.sha256(payload).hexdigest()
            resolved[digest] = {"encodedSha256": digest, "sourceCatalogId": current["catalogId"], "sourceId": entry["id"],
                                "storedYaw": prior["storedYaw"], "freshYaw": prior["freshYaw"],
                                "reason": "prior_yaw_contradiction", "evidenceSha256": evidence_hash}
    if requested:
        raise ValueError("Unknown prior yaw image IDs")
    return resolved


def create_records_database(path: Path | str, metadata: Mapping[str, Any]) -> sqlite3.Connection:
    path = Path(path)
    if path.exists():
        raise ValueError(f"Audit database already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode=DELETE")
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("PRAGMA cache_size=-16384")
    connection.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID")
    connection.execute("CREATE TABLE records (source_key TEXT PRIMARY KEY, source_catalog_id TEXT NOT NULL, source_id TEXT NOT NULL, encoded_sha256 TEXT, source_feature_sha256 TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('pass','reject','unresolved')), record_sha256 TEXT NOT NULL, record_z BLOB NOT NULL) WITHOUT ROWID")
    connection.execute("CREATE INDEX records_catalog ON records(source_catalog_id)")
    connection.execute("CREATE INDEX records_image ON records(encoded_sha256)")
    for key, value in metadata.items():
        connection.execute("INSERT INTO metadata VALUES (?,?)", (key, json_bytes(value).decode("utf-8")))
    connection.commit()
    return connection


def set_database_metadata(connection: sqlite3.Connection, key: str, value: Any) -> None:
    connection.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", (key, json_bytes(value).decode("utf-8")))


def database_metadata(connection: sqlite3.Connection) -> dict[str, Any]:
    return {key: json.loads(value) for key, value in connection.execute("SELECT key,value FROM metadata")}


def insert_record(connection: sqlite3.Connection, record: Mapping[str, Any]) -> None:
    raw = json_bytes(record)
    connection.execute("INSERT INTO records VALUES (?,?,?,?,?,?,?,?)", (
        record["sourceKey"], record["sourceCatalogId"], record["sourceId"], record["encodedSha256"],
        record["sourceFeatureSha256"], record["decision"], hashlib.sha256(raw).hexdigest(), zlib.compress(raw, 3)))


def database_summary(connection: sqlite3.Connection) -> dict[str, Any]:
    decisions = dict(connection.execute("SELECT decision,COUNT(*) FROM records GROUP BY decision"))
    sources = dict(connection.execute("SELECT source_catalog_id,COUNT(*) FROM records GROUP BY source_catalog_id"))
    return {"recordCount": sum(decisions.values()), "passCount": decisions.get("pass", 0), "rejectCount": decisions.get("reject", 0),
            "unresolvedCount": decisions.get("unresolved", 0), "sourceCounts": sources}


def readonly_database(path: Path | str) -> sqlite3.Connection:
    connection = sqlite3.connect("file:" + quote(str(Path(path).resolve()), safe="/") + "?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA cache_size=-16384")
    return connection


class AdmissionAudit:
    """Fail-closed validation and lookup for a completed candidate audit.

    sources accepts builder SourceCatalog objects, LABEL=PATH strings, or
    (label, root) pairs. record() returns None for known nonpassing candidates;
    unknown IDs, source changes, altered evidence, and byte mismatches raise.
    """
    def __init__(self, receipt_path: Path | str, model_path: Path | str, sources: Iterable[Any]) -> None:
        self.receipt_path = Path(receipt_path).resolve()
        receipt = json.loads(self.receipt_path.read_text(encoding="utf-8"))
        if receipt.get("schemaVersion") != SCHEMA_VERSION or receipt.get("status") != "complete":
            raise ValueError("A schema-2 completed candidate audit is required")
        self.policy = AdmissionPolicy.from_document(receipt.get("policy", {}))
        if receipt.get("policySha256") != self.policy.sha256:
            raise ValueError("Admission policy hash mismatch")
        if receipt.get("analysisCodeSha256") != sha256_file(__file__):
            raise ValueError("Admission analysis code differs from the audited code")
        models = receipt.get("models", {})
        if models.get("attributeSha256") != sha256_file(model_path) or not valid_digest(models.get("faceSha256")):
            raise ValueError("Admission model hashes are missing or mismatched")
        self.sources = normalize_sources(sources)
        actual_sources = [fingerprint_catalog(source["label"], source["root"]) for source in self.sources]
        expected_sources = receipt.get("sources", [])
        if len({source["catalogId"] for source in actual_sources}) != len(actual_sources):
            raise ValueError("Ambiguous duplicate source catalogs")
        if sorted(actual_sources, key=lambda row: row["catalogId"]) != sorted(expected_sources, key=lambda row: row["catalogId"]):
            raise ValueError("Admission source manifest/shard fingerprint mismatch")
        controls_path = safe_child(self.receipt_path.parent, receipt.get("controlsPath", ""))
        if sha256_file(controls_path) != receipt.get("controlsSha256"):
            raise ValueError("Admission review/evidence controls changed")
        self.controls = json.loads(controls_path.read_text(encoding="utf-8"))
        database_path = safe_child(self.receipt_path.parent, receipt.get("recordsPath", ""))
        if sha256_file(database_path) != receipt.get("recordsSha256"):
            raise ValueError("Admission record database hash mismatch")
        self.connection = readonly_database(database_path)
        self.readers: dict[str, PackedImageReader] = {}
        try:
            metadata = database_metadata(self.connection)
            for key in ("schemaVersion", "status", "policySha256", "analysisCodeSha256", "models", "controlsSha256", "sources"):
                if metadata.get(key) != receipt.get(key):
                    raise ValueError("Admission database metadata mismatch: " + key)
            summary = database_summary(self.connection)
            if any(receipt.get(key) != value for key, value in summary.items()):
                raise ValueError("Admission database count mismatch")
            if summary["recordCount"] != sum(source["expectedRows"] for source in actual_sources):
                raise ValueError("Incomplete admission candidate coverage")
            partitions = receipt.get("partitions", [])
            parts = int(receipt.get("partitionCount", receipt.get("workers", 0)))
            if parts < 1 or len(partitions) != parts or {row.get("part") for row in partitions} != set(range(parts)):
                raise ValueError("Missing or duplicate audit partitions")
            if any(row.get("status") != "complete" or row.get("parts") != parts for row in partitions):
                raise ValueError("Incomplete audit partition")
            if sum(row.get("recordCount", -1) for row in partitions) != summary["recordCount"]:
                raise ValueError("Audit partition coverage mismatch")
            for source, fingerprint in zip(self.sources, actual_sources):
                catalog_id = fingerprint["catalogId"]
                keys = [row[0] for row in self.connection.execute("SELECT source_key FROM records WHERE source_catalog_id=? ORDER BY source_key", (catalog_id,))]
                if len(keys) != fingerprint["expectedRows"] or key_set_sha256(keys) != fingerprint["sourceKeySetSha256"]:
                    raise ValueError("Admission source-key coverage mismatch")
                self.readers[catalog_id] = PackedImageReader(source["root"])
        except Exception:
            self.close()
            raise
        self.receipt = receipt

    def close(self) -> None:
        for reader in getattr(self, "readers", {}).values():
            reader.close()
        if getattr(self, "connection", None) is not None:
            self.connection.close()
            self.connection = None

    def __enter__(self) -> "AdmissionAudit":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def record(self, source_catalog_id: str, entry: Mapping[str, Any], payload: bytes | None = None) -> dict[str, Any] | None:
        key = source_key(source_catalog_id, str(entry.get("id") or ""))
        row = self.connection.execute("SELECT encoded_sha256,source_feature_sha256,decision,record_sha256,record_z FROM records WHERE source_key=?", (key,)).fetchone()
        if row is None:
            raise ValueError("Candidate is absent from the completed audit: " + key)
        digest, original_feature, decision, record_hash, compressed = row
        if feature_sha256(entry) != original_feature:
            raise ValueError("Candidate source feature changed after admission")
        if decision != "pass":
            return None
        raw = zlib.decompress(compressed)
        if hashlib.sha256(raw).hexdigest() != record_hash:
            raise ValueError("Compressed admission record hash mismatch")
        record = json.loads(raw)
        if (record.get("sourceKey") != key or record.get("sourceCatalogId") != source_catalog_id or record.get("sourceId") != str(entry["id"])
                or record.get("decision") != "pass" or record.get("encodedSha256") != digest
                or record.get("policySha256") != self.policy.sha256 or record.get("sourceFeatureSha256") != original_feature):
            raise ValueError("Admission record identity mismatch")
        if any(record.get("checks", {}).get(check) != "pass" for check in REQUIRED_CHECKS):
            raise ValueError("A passing record has unresolved checks")
        feature = record.get("feature", [])
        layout = record.get("layout", [])
        if len(feature) != FEATURE_LENGTH or len(layout) != 4 or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in [*feature, *layout]):
            raise ValueError("Invalid admitted face feature/layout")
        if record.get("faceCount") != 1 or min(layout[2:]) <= 0 or not isinstance(record.get("freshYaw"), (int, float)) or not math.isfinite(record["freshYaw"]):
            raise ValueError("Missing admitted single-face/pose evidence")
        if abs(record["freshYaw"] - feature[0] * 90) > 1e-8 or record.get("cell") != quantized_pose_cell(feature, 3)[0]:
            raise ValueError("Admitted pose does not match fresh features")
        if opposite_pose(float(entry["feature"][0]) * 90, record["freshYaw"]):
            raise ValueError("A strong pose contradiction was admitted")
        if digest in self.controls.get("priorYawExclusions", {}):
            raise ValueError("Prior yaw exclusion was admitted under another ID")
        review = self.controls.get("reviews", {}).get(digest)
        if visibility_decision(record.get("faceAttributes", []), self.policy, review)[0] != "pass":
            raise ValueError("Visibility evidence does not permit admission")
        validate_attribute_scores(record.get("fullAttributes", []))
        if not image_quality_decision(record.get("imageQuality", {}), record.get("sourceLabel", "") + " " + source_catalog_id)[0]:
            raise ValueError("Image detail evidence does not permit admission")
        for name, minimum in (("shape", 13), ("mesh", 3), ("projection", 936)):
            encoded = base64.b64decode(record.get(name, ""), validate=True)
            if len(encoded) % 2 or len(encoded) // 2 < minimum or (name == "projection" and len(encoded) != 936 * 2):
                raise ValueError("Invalid admitted geometry encoding")
        if payload is None:
            payload = self.readers[source_catalog_id].read(entry)
        if not valid_digest(digest) or len(payload) != record.get("byteLength") or hashlib.sha256(payload).hexdigest() != digest:
            raise ValueError("Candidate image bytes changed after admission")
        return record
