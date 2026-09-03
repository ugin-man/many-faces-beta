#!/usr/bin/env python3
"""Collect redistribution-compatible candidates for rare Clean Core v2 states.

Search terms are only a staging hint.  Every image is subsequently measured by
MediaPipe and must pass the isolated-state policy; query text never becomes a
class label.  Openverse is primary and Wikimedia Commons is a deterministic
fallback.  Only CC0/PDM/CC BY/CC BY-SA material is staged, and attribution is
preserved per file.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import mimetypes
import os
import random
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Iterable

from PIL import Image, ImageOps

USER_AGENT = "ManyFacesCleanCore/2.0 (https://github.com/ugin-man/many-faces-beta)"
OPENVERSE = "https://api.openverse.org/v1/images/"
COMMONS = "https://commons.wikimedia.org/w/api.php"
ALLOWED_LICENSES = {"cc0", "pdm", "by", "by-sa", "cc by", "cc by-sa"}

DEFAULT_QUERIES = [
    "neutral face portrait closed mouth",
    "serious portrait closed mouth",
    "person one eye closed neutral face",
    "winking portrait closed mouth",
    "left wink portrait closed mouth",
    "right wink portrait closed mouth",
    "one eye closed serious portrait",
    "both eyes closed portrait closed mouth",
    "wide eyes portrait closed mouth",
    "looking left portrait closed mouth",
    "looking right portrait closed mouth",
    "looking up portrait closed mouth",
    "looking down portrait closed mouth",
    "raised eyebrow portrait closed mouth",
    "furrowed brow portrait closed mouth",
    "slightly open mouth portrait",
    "open mouth portrait neutral eyes",
    "closed mouth smile portrait",
    "open mouth smile portrait",
    "rounded mouth portrait",
    "puckered lips portrait",
    "pressed lips portrait",
    "wide mouth portrait",
    "frowning mouth portrait neutral eyes",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--max-images", type=int, default=12000)
    parser.add_argument("--openverse-pages", type=int, default=6)
    parser.add_argument("--commons-pages", type=int, default=4)
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--seed", type=int, default=20260822)
    parser.add_argument("--queries", type=Path)
    parser.add_argument("--mirror", action="store_true")
    return parser.parse_args()


def request_json(url: str, retries: int = 4) -> dict[str, Any]:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=40) as response:
                return json.load(response)
        except Exception as error:  # pragma: no cover - network dependent
            last = error
            time.sleep(min(8, 1.5 * (attempt + 1)))
    raise RuntimeError(f"request failed after {retries} attempts: {url}") from last


def normalized_license(value: str | None) -> str:
    text = (value or "").strip().lower().replace("_", "-")
    text = text.replace("creativecommons.org/licenses/", "")
    if text.startswith("by-sa") or "by-sa" in text:
        return "by-sa"
    if text.startswith("by") or text == "cc by":
        return "by"
    if "zero" in text or text == "cc0":
        return "cc0"
    if "publicdomain" in text or text in {"pdm", "public domain"}:
        return "pdm"
    return text


def openverse_candidates(query: str, pages: int) -> Iterable[dict[str, Any]]:
    for page in range(1, pages + 1):
        params = urllib.parse.urlencode(
            {
                "q": query,
                "page": page,
                "page_size": 80,
                "license": "cc0,pdm,by,by-sa",
                "mature": "false",
            }
        )
        try:
            payload = request_json(f"{OPENVERSE}?{params}")
        except Exception:
            break
        results = payload.get("results") or []
        if not results:
            break
        for item in results:
            license_code = normalized_license(item.get("license"))
            if license_code not in ALLOWED_LICENSES:
                continue
            image_url = item.get("url") or item.get("thumbnail")
            landing = item.get("foreign_landing_url") or item.get("detail_url")
            if not image_url or not landing:
                continue
            yield {
                "source_id": f"openverse:{item.get('id')}",
                "source_name": "Openverse",
                "source_url": str(landing),
                "image_url": str(image_url),
                "title": str(item.get("title") or query),
                "creator": str(item.get("creator") or "Unknown"),
                "creator_url": str(item.get("creator_url") or ""),
                "license": license_code,
                "license_url": str(item.get("license_url") or ""),
                "query": query,
                "modified": False,
            }
        if not payload.get("next"):
            break


def commons_candidates(query: str, pages: int) -> Iterable[dict[str, Any]]:
    offset = None
    for _ in range(pages):
        params: dict[str, Any] = {
            "action": "query",
            "format": "json",
            "formatversion": 2,
            "generator": "search",
            "gsrsearch": f"{query} filetype:bitmap",
            "gsrnamespace": 6,
            "gsrlimit": 50,
            "prop": "imageinfo",
            "iiprop": "url|extmetadata|mime|size",
        }
        if offset:
            params["gsroffset"] = offset
        try:
            payload = request_json(f"{COMMONS}?{urllib.parse.urlencode(params)}")
        except Exception:
            break
        pages_data = payload.get("query", {}).get("pages", [])
        if not pages_data:
            break
        for page in pages_data:
            info_list = page.get("imageinfo") or []
            if not info_list:
                continue
            info = info_list[0]
            mime = str(info.get("mime") or "")
            if mime and not mime.startswith("image/"):
                continue
            meta = info.get("extmetadata") or {}
            license_short = str((meta.get("LicenseShortName") or {}).get("value") or "")
            license_code = normalized_license(license_short)
            if license_code not in ALLOWED_LICENSES:
                continue
            image_url = info.get("thumburl") or info.get("url")
            landing = info.get("descriptionurl")
            if not image_url or not landing:
                continue
            creator = str((meta.get("Artist") or {}).get("value") or "Unknown")
            yield {
                "source_id": f"commons:{page.get('pageid')}",
                "source_name": "Wikimedia Commons",
                "source_url": str(landing),
                "image_url": str(image_url),
                "title": str(page.get("title") or query),
                "creator": creator,
                "creator_url": "",
                "license": license_code,
                "license_url": str((meta.get("LicenseUrl") or {}).get("value") or ""),
                "query": query,
                "modified": False,
            }
        offset = payload.get("continue", {}).get("gsroffset")
        if offset is None:
            break


def load_queries(path: Path | None) -> list[str]:
    if path is None:
        return list(DEFAULT_QUERIES)
    payload = json.loads(path.read_text(encoding="utf-8"))
    values = payload.get("queries", payload) if isinstance(payload, dict) else payload
    if not isinstance(values, list):
        raise ValueError("queries file must contain a list or {queries: [...]}")
    return [str(value).strip() for value in values if str(value).strip()]


def download_bytes(url: str, retries: int = 3) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=45) as response:
                content_type = response.headers.get("Content-Type", "")
                if content_type and "image" not in content_type.lower():
                    raise ValueError(f"not an image: {content_type}")
                data = response.read(24 * 1024 * 1024 + 1)
            if len(data) > 24 * 1024 * 1024:
                raise ValueError("image exceeds 24 MiB")
            return data
        except Exception as error:  # pragma: no cover - network dependent
            last = error
            time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}") from last


def normalize_image(data: bytes) -> tuple[bytes, int, int]:
    with Image.open(io.BytesIO(data)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        if min(image.size) < 160:
            raise ValueError("image is too small")
        image.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="WEBP", quality=91, method=6)
        return output.getvalue(), image.width, image.height


def stage_one(item: dict[str, Any], images: Path) -> dict[str, Any]:
    raw = download_bytes(item["image_url"])
    normalized, width, height = normalize_image(raw)
    digest = hashlib.sha256(normalized).hexdigest()
    filename = f"{digest}.webp"
    path = images / filename
    if not path.exists():
        path.write_bytes(normalized)
    return {**item, "filename": filename, "sha256": digest, "width": width, "height": height}


def mirror_rows(rows: list[dict[str, Any]], images: Path) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for row in rows:
        source = images / row["filename"]
        try:
            with Image.open(source) as image:
                mirrored = ImageOps.mirror(image.convert("RGB"))
                buffer = io.BytesIO()
                mirrored.save(buffer, format="WEBP", quality=91, method=6)
                data = buffer.getvalue()
        except Exception:
            continue
        digest = hashlib.sha256(data).hexdigest()
        filename = f"{digest}.webp"
        destination = images / filename
        if not destination.exists():
            destination.write_bytes(data)
        output.append(
            {
                **row,
                "source_id": f"{row['source_id']}:mirror",
                "title": f"{row['title']} (mirrored)",
                "filename": filename,
                "sha256": digest,
                "modified": True,
                "modification": "horizontal mirror for left/right isolated-state coverage",
            }
        )
    return output


def write_metadata(output: Path, rows: list[dict[str, Any]]) -> None:
    fields = [
        "filename", "file", "path", "id", "source_id", "sourceId", "name", "title",
        "source_name", "sourceName", "source_url", "sourceUrl", "creator", "creator_url",
        "license", "license_url", "licenseUrl", "query", "modified", "modification",
        "sha256", "width", "height",
    ]
    with (output / "metadata.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            filename = row["filename"]
            normalized = {
                **row,
                "file": filename,
                "path": f"images/{filename}",
                "id": row["source_id"],
                "sourceId": row["source_id"],
                "name": row["title"],
                "sourceName": row["source_name"],
                "sourceUrl": row["source_url"],
                "licenseUrl": row["license_url"],
                "modification": row.get("modification", ""),
            }
            writer.writerow({field: normalized.get(field, "") for field in fields})


def main() -> None:
    args = parse_args()
    if args.output.exists() and any(args.output.iterdir()):
        raise SystemExit(f"output directory is not empty: {args.output}")
    images = args.output / "images"
    images.mkdir(parents=True, exist_ok=True)
    queries = load_queries(args.queries)
    random.Random(args.seed).shuffle(queries)

    candidates: list[dict[str, Any]] = []
    seen_source: set[str] = set()
    for query in queries:
        for item in openverse_candidates(query, args.openverse_pages):
            if item["source_id"] in seen_source:
                continue
            seen_source.add(item["source_id"])
            candidates.append(item)
        for item in commons_candidates(query, args.commons_pages):
            if item["source_id"] in seen_source:
                continue
            seen_source.add(item["source_id"])
            candidates.append(item)
    random.Random(args.seed).shuffle(candidates)

    rows: list[dict[str, Any]] = []
    hashes: set[str] = set()
    failures: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        pending = {executor.submit(stage_one, item, images): item for item in candidates}
        for future in as_completed(pending):
            if len(rows) >= args.max_images:
                for item in pending:
                    item.cancel()
                break
            try:
                row = future.result()
            except Exception as error:  # pragma: no cover - network dependent
                key = type(error).__name__
                failures[key] = failures.get(key, 0) + 1
                continue
            if row["sha256"] in hashes:
                continue
            hashes.add(row["sha256"])
            rows.append(row)

    rows.sort(key=lambda row: (row["query"], row["source_id"]))
    if args.mirror:
        mirrored = mirror_rows(rows, images)
        for row in mirrored:
            if row["sha256"] in hashes:
                continue
            hashes.add(row["sha256"])
            rows.append(row)
    write_metadata(args.output, rows)
    report = {
        "schemaVersion": 1,
        "queries": queries,
        "sourceCandidates": len(candidates),
        "staged": len(rows),
        "uniqueOriginals": len(rows) - (len(rows) // 2 if args.mirror else 0),
        "mirroringEnabled": bool(args.mirror),
        "licenses": sorted({row["license"] for row in rows}),
        "downloadFailures": failures,
    }
    (args.output / "source-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
