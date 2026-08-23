#!/usr/bin/env python3
"""Collect openly licensed real photographs for weak Clean Core v3 profiles.

Search text is only a retrieval hint.  Every retained image is subsequently
measured by MediaPipe; the query never becomes a trusted facial-action label.
The collector is deliberately conservative about licenses and synthetic/CG
metadata, and downloads candidates concurrently so a targeted pass completes
in minutes rather than hours.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import random
import re
import time
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Iterable

from PIL import Image, ImageOps

OPENVERSE_API = "https://api.openverse.org/v1/images/"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "ManyFacesRealPhotoCollector/3.1 (https://github.com/ugin-man/many-faces-beta)"
MAX_DOWNLOAD_BYTES = 6 * 1024 * 1024

QUERIES: dict[str, list[str]] = {
    "winkLeft": [
        "winking man portrait closed mouth photograph",
        "winking woman portrait closed mouth photograph",
        "person winking selfie closed mouth",
        "one eye closed portrait neutral mouth",
        "wink close up face photograph",
        "winking person serious portrait",
    ],
    "winkRight": [
        "winking man portrait closed mouth photograph",
        "winking woman portrait closed mouth photograph",
        "person winking selfie closed mouth",
        "one eye closed portrait neutral mouth",
        "wink close up face photograph",
        "winking person serious portrait",
    ],
    "eyesWide": [
        "wide eyed man portrait closed mouth photograph",
        "wide eyed woman portrait closed mouth photograph",
        "astonished eyes portrait mouth closed",
        "surprised eyes close up portrait photograph",
        "person eyes wide open neutral mouth photograph",
    ],
    "noseSneer": [
        "sneering person portrait photograph",
        "wrinkled nose portrait photograph",
        "disgusted face close up photograph",
        "upper lip raised disgust portrait photograph",
        "snarling person portrait photograph",
    ],
    "mouthRound": [
        "round lips portrait photograph",
        "person saying oh portrait photograph",
        "whistling person close up portrait",
        "o shaped mouth portrait photograph",
        "blowing air lips portrait photograph",
    ],
    "mouthSlightOpen": [
        "slightly open mouth portrait neutral eyes photograph",
        "parted lips portrait photograph",
        "person lips slightly parted portrait",
        "neutral portrait mouth slightly open photograph",
    ],
    "mouthOpen": [
        "open mouth portrait neutral eyes not smiling photograph",
        "person saying ah portrait photograph",
        "open mouth close up face neutral expression photograph",
    ],
    "smileOpen": [
        "open mouth smile portrait photograph",
        "smiling person teeth portrait photograph",
        "happy open smile close up photograph",
    ],
    "mouthWide": [
        "stretched mouth portrait photograph",
        "wide mouth grimace portrait photograph",
        "person grimacing mouth wide photograph",
        "horizontal mouth stretch portrait photograph",
    ],
    "mouthFrown": [
        "downturned mouth portrait photograph",
        "sad frown face closed mouth photograph",
        "frowning lips portrait neutral eyes photograph",
        "person mouth corners down portrait photograph",
    ],
    "mouthUpperUp": [
        "upper lip raised portrait photograph",
        "disgusted expression upper lip portrait photograph",
        "snarl face portrait photograph",
    ],
    "mouthLowerDown": [
        "lower lip pulled down portrait photograph",
        "sad lower lip portrait photograph",
        "pout lower lip face close up photograph",
    ],
    "mouthLeft": [
        "crooked mouth portrait photograph",
        "mouth pulled sideways portrait photograph",
        "one sided mouth grimace portrait photograph",
    ],
    "mouthRight": [
        "crooked mouth portrait photograph",
        "mouth pulled sideways portrait photograph",
        "one sided mouth grimace portrait photograph",
    ],
}

NON_PHOTO = re.compile(
    r"\b(?:3d|3-d|render(?:ed|ing)?|cgi|computer[- ]generated|synthetic|"
    r"virtual human|metahuman|avatar|video game|game character|statue|"
    r"sculpture|painting|drawing|illustration|illustrated|cartoon|comic|"
    r"anime|manga|doll|figurine|poster|engraving|artwork|digital art|"
    r"concept art|wax figure|mannequin)\b",
    re.IGNORECASE,
)
UNSAFE_LICENSE = re.compile(
    r"(?:no.?deriv|fair use|copyrighted|all rights reserved)", re.IGNORECASE
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--provider", choices=("openverse", "commons"), required=True)
    parser.add_argument("--profiles", required=True)
    parser.add_argument("--pages", type=int, default=6)
    parser.add_argument("--per-page", type=int, default=50)
    parser.add_argument("--max-images", type=int, default=2500)
    parser.add_argument("--workers", type=int, default=24)
    parser.add_argument("--seed", type=int, default=20260823)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    args.pages = max(1, min(20, args.pages))
    args.per_page = max(10, min(80, args.per_page))
    args.max_images = max(1, args.max_images)
    args.workers = max(1, min(48, args.workers))
    profiles = [value.strip() for value in args.profiles.split(",") if value.strip()]
    unknown = [profile for profile in profiles if profile not in QUERIES]
    if unknown:
        parser.error(f"unsupported profiles: {', '.join(unknown)}")
    args.profiles = profiles
    return args


def clean_html(value: Any) -> str:
    text = re.sub(r"<[^>]*>", " ", str(value or ""))
    text = re.sub(r"&[a-zA-Z]+;", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalized_license(value: Any) -> str | None:
    text = clean_html(value).lower().replace("_", "-")
    if UNSAFE_LICENSE.search(text):
        return None
    if "by-sa" in text or "attribution-sharealike" in text or "attribution share alike" in text:
        return "CC BY-SA"
    if re.search(r"(?:^|\b)(?:cc[- ]?)?by(?:\b|[- ])", text) or "attribution" in text:
        return "CC BY"
    if "cc0" in text or "creative commons zero" in text:
        return "CC0"
    if text in {"pdm", "pd", "public domain"} or "public domain" in text:
        return "PDM"
    return None


def request_json(url: str, *, retries: int = 5) -> dict[str, Any]:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=35) as response:
                return json.load(response)
        except Exception as error:  # pragma: no cover - network dependent
            last = error
            time.sleep(min(20.0, 1.5 * (2**attempt)))
    raise RuntimeError(f"request failed: {url}") from last


def openverse_candidates(profile: str, query: str, pages: int, per_page: int) -> Iterable[dict[str, str]]:
    for page in range(1, pages + 1):
        params = urllib.parse.urlencode(
            {
                "q": query,
                "category": "photograph",
                "mature": "false",
                "license_type": "modification",
                "license": "by,by-sa,cc0,pdm",
                "page": page,
                "page_size": per_page,
            }
        )
        payload = request_json(f"{OPENVERSE_API}?{params}")
        results = payload.get("results") or []
        if not results:
            break
        for item in results:
            category = clean_html(item.get("category")).lower()
            tags = " ".join(
                clean_html(tag if isinstance(tag, str) else tag.get("name"))
                for tag in (item.get("tags") or [])
            )
            title = clean_html(item.get("title"))
            description = clean_html(item.get("description"))
            combined = f"{title} {description} {tags} {category}"
            license_code = normalized_license(
                " ".join(
                    value
                    for value in (
                        clean_html(item.get("license")),
                        clean_html(item.get("license_version")),
                        clean_html(item.get("license_url")),
                    )
                    if value
                )
            )
            image_url = item.get("thumbnail") or item.get("url")
            landing = item.get("foreign_landing_url") or item.get("detail_url")
            if category and category != "photograph":
                continue
            if NON_PHOTO.search(combined) or not license_code or not image_url or not landing:
                continue
            yield {
                "source_id": f"openverse:{item.get('id')}",
                "title": title or "Targeted real-person portrait",
                "source_name": "Openverse photograph",
                "source_url": str(landing),
                "creator": clean_html(item.get("creator")) or "Unknown creator",
                "creator_url": clean_html(item.get("creator_url")),
                "license": license_code,
                "license_url": clean_html(item.get("license_url")) or str(landing),
                "image_url": str(image_url),
                "target_configuration": profile,
                "target_query": query,
                "provider": clean_html(item.get("provider")),
                "source_collection": clean_html(item.get("source")),
            }
        if not payload.get("next"):
            break


def commons_candidates(profile: str, query: str, pages: int, per_page: int) -> Iterable[dict[str, str]]:
    for page in range(pages):
        params = urllib.parse.urlencode(
            {
                "action": "query",
                "format": "json",
                "formatversion": 2,
                "generator": "search",
                "gsrsearch": f"{query} filetype:bitmap",
                "gsrnamespace": 6,
                "gsrlimit": per_page,
                "gsroffset": page * per_page,
                "prop": "imageinfo",
                "iiprop": "url|mime|extmetadata",
                "iiurlwidth": 900,
                "origin": "*",
            }
        )
        payload = request_json(f"{COMMONS_API}?{params}")
        items = payload.get("query", {}).get("pages", [])
        if not items:
            break
        for item in items:
            info_list = item.get("imageinfo") or []
            if not info_list:
                continue
            info = info_list[0]
            metadata = info.get("extmetadata") or {}
            title = clean_html((metadata.get("ObjectName") or {}).get("value") or item.get("title"))
            description = clean_html((metadata.get("ImageDescription") or {}).get("value"))
            categories = clean_html((metadata.get("Categories") or {}).get("value"))
            license_text = " ".join(
                clean_html((metadata.get(key) or {}).get("value"))
                for key in ("LicenseShortName", "UsageTerms", "LicenseUrl")
            )
            license_code = normalized_license(license_text)
            image_url = info.get("thumburl") or info.get("url")
            landing = info.get("descriptionurl")
            if NON_PHOTO.search(f"{title} {description} {categories}"):
                continue
            if not license_code or not image_url or not landing:
                continue
            yield {
                "source_id": f"commons:{item.get('pageid')}",
                "title": title or "Targeted real-person portrait",
                "source_name": "Wikimedia Commons photograph",
                "source_url": str(landing),
                "creator": clean_html((metadata.get("Artist") or {}).get("value")) or "Unknown creator",
                "creator_url": "",
                "license": license_code,
                "license_url": clean_html((metadata.get("LicenseUrl") or {}).get("value")) or str(landing),
                "image_url": str(image_url),
                "target_configuration": profile,
                "target_query": query,
                "provider": "Wikimedia Commons",
                "source_collection": "commons",
            }


def download_bytes(url: str, *, retries: int = 3) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": USER_AGENT, "Accept": "image/jpeg,image/png,image/webp,image/*"},
            )
            with urllib.request.urlopen(request, timeout=45) as response:
                content_type = response.headers.get("Content-Type", "").lower()
                if content_type and "image" not in content_type:
                    raise ValueError(f"not an image: {content_type}")
                payload = response.read(MAX_DOWNLOAD_BYTES + 1)
            if not payload or len(payload) > MAX_DOWNLOAD_BYTES:
                raise ValueError("invalid image byte length")
            return payload
        except Exception as error:  # pragma: no cover - network dependent
            last = error
            time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}") from last


def normalize_image(payload: bytes) -> tuple[bytes, int, int]:
    with Image.open(io.BytesIO(payload)) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        if min(image.size) < 180:
            raise ValueError("image too small")
        image.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="WEBP", quality=92, method=6)
        return output.getvalue(), image.width, image.height


def stage_candidate(item: dict[str, str], images: Path) -> dict[str, str]:
    payload = download_bytes(item["image_url"])
    normalized, width, height = normalize_image(payload)
    digest = hashlib.sha256(normalized).hexdigest()
    filename = f"{digest}.webp"
    path = images / filename
    if not path.exists():
        path.write_bytes(normalized)
    return {
        **item,
        "filename": filename,
        "sha256": digest,
        "width": str(width),
        "height": str(height),
    }


def main() -> int:
    args = parse_args()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()) and not args.overwrite:
        raise SystemExit("Output directory is not empty")
    if args.overwrite and output.exists():
        import shutil

        shutil.rmtree(output)
    images = output / "images"
    images.mkdir(parents=True, exist_ok=True)

    candidates: list[dict[str, str]] = []
    seen_sources: set[str] = set()
    search_failures: Counter[str] = Counter()
    provider = openverse_candidates if args.provider == "openverse" else commons_candidates
    for profile in args.profiles:
        for query in QUERIES[profile]:
            try:
                items = provider(profile, query, args.pages, args.per_page)
                for item in items:
                    key = f"{item['source_id']}|{item['source_url']}"
                    if key in seen_sources:
                        continue
                    seen_sources.add(key)
                    candidates.append(item)
            except Exception as error:  # pragma: no cover - network dependent
                search_failures[f"{profile}:{type(error).__name__}"] += 1

    random.Random(args.seed).shuffle(candidates)
    staged: list[dict[str, str]] = []
    hashes: set[str] = set()
    download_failures: Counter[str] = Counter()
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(stage_candidate, candidate, images): candidate
            for candidate in candidates
        }
        for future in as_completed(futures):
            if len(staged) >= args.max_images:
                for pending in futures:
                    pending.cancel()
                break
            try:
                row = future.result()
            except Exception as error:  # pragma: no cover - network dependent
                download_failures[type(error).__name__] += 1
                continue
            if row["sha256"] in hashes:
                continue
            hashes.add(row["sha256"])
            staged.append(row)

    staged.sort(key=lambda row: (row["target_configuration"], row["source_id"]))
    columns = [
        "relative_path",
        "title",
        "source_name",
        "source_url",
        "creator",
        "creator_url",
        "license",
        "license_url",
        "target_pose",
        "target_configuration",
        "target_query",
        "target_pressure",
        "source_kind",
        "provider",
        "source_collection",
        "media_category",
        "original_url",
        "author_profile_url",
        "source_id",
        "sha256",
        "width",
        "height",
    ]
    with (output / "metadata.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for row in staged:
            normalized = {
                **row,
                "relative_path": f"images/{row['filename']}",
                "target_pose": "",
                "target_pressure": "",
                "source_kind": "real-photo-targeted",
                "media_category": "photograph",
                "original_url": row["image_url"],
                "author_profile_url": row.get("creator_url", ""),
            }
            writer.writerow({key: normalized.get(key, "") for key in columns})

    staged_by_profile = Counter(row["target_configuration"] for row in staged)
    report = {
        "schemaVersion": 1,
        "provider": args.provider,
        "profiles": args.profiles,
        "sourceCandidates": len(candidates),
        "staged": len(staged),
        "stagedByProfile": dict(sorted(staged_by_profile.items())),
        "searchFailures": dict(sorted(search_failures.items())),
        "downloadFailures": dict(sorted(download_failures.items())),
        "runtimeImagePolicy": "real-photo-only-v1",
        "allowedLicenses": ["CC BY", "CC BY-SA", "CC0", "PDM"],
    }
    (output / "source-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if staged else 1


if __name__ == "__main__":
    raise SystemExit(main())
