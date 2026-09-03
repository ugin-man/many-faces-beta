#!/usr/bin/env python3
"""Download, verify and inspect official FDF256 source archives.

The URLs and MD5 digests below are copied from the official hukkelas/FDF
`download_fdf256.py`. Downloads are streamed, resumable, checksum-verified and
extracted with zip-slip protection. The tool writes a machine-readable source
report so downstream catalog jobs can prove exactly which upstream artifact
was used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

OFFICIAL_REPOSITORY = "https://github.com/hukkelas/FDF"
METADATA = {
    "name": "metainfo",
    "url": (
        "https://api.loke.aws.unit.no/dlr-gui-backend-resources-content/v2/contents/links/"
        "b704049a-d465-4a07-9cb3-ca270ffab80292e4d5ac-6172-4d37-bf63-4438f61f8aa0e1f6483d-5d45-40b5-b356-10b71fc00e89"
    ),
    "md5": "b790269bd64e9a6c1b1b032a9ff60410",
}
ARCHIVES = {
    "cc-by-2": {
        "url": (
            "https://api.loke.aws.unit.no/dlr-gui-backend-resources-content/v2/contents/links/"
            "cb545564-120f-4f35-8b68-63e59e4fd273b1c36452-21e7-4976-85dd-a86c0738ebc256264f20-f969-4a82-ae1c-f6345d8e8d1f"
        ),
        "md5": "e45e313358a5912927ed3a8aa620b3b1",
    },
    "cc-by-sa-2": {
        "url": (
            "https://api.loke.aws.unit.no/dlr-gui-backend-resources-content/v2/contents/links/"
            "4e5c27bd-f5fd-4dd3-bf2b-4434a8952df0ff4d11f8-e993-4517-9378-b35d89e7882ecae76ce7-88a0-417b-b5d8-e030863e97f6"
        ),
        "md5": "2cd40e77def0e14148530d7f250a199e",
    },
    "cc-by-nc-2": {
        "url": (
            "https://api.loke.aws.unit.no/dlr-gui-backend-resources-content/v2/contents/links/"
            "da46d666-4378-4e75-9182-e683ebe08f2e9203750f-7ed8-42f7-8bce-90a7dfddd3764401df36-a3c3-4d39-ae8e-0cb4397e5c74"
        ),
        "md5": "12c531a59a47783bca53d69b04653805",
    },
    "cc-by-nc-sa-2": {
        "url": (
            "https://api.loke.aws.unit.no/dlr-gui-backend-resources-content/v2/contents/links/"
            "33bb6132-a30e-4169-a09e-48b94cd5e09010fd8f59-1db9-4192-96f0-83d18adf50b4ee3ab25c-b8f8-4c40-a8ba-eaa64d830412"
        ),
        "md5": "afad28fdb033ae57ce5e5e2d95a6be18",
    },
}
USER_AGENT = "Many Faces FDF256 Builder/0.1 (+https://github.com/ugin-man/many-faces-beta)"
CHUNK_SIZE = 1024 * 1024


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--license",
        dest="licenses",
        action="append",
        choices=sorted(ARCHIVES),
        default=[],
        help="Download one image archive. Repeat to select multiple partitions.",
    )
    parser.add_argument("--metadata-only", action="store_true")
    parser.add_argument("--probe-only", action="store_true")
    parser.add_argument("--skip-extract", action="store_true")
    parser.add_argument("--keep-archives", action="store_true")
    parser.add_argument("--retries", type=int, default=4)
    return parser.parse_args()


def md5_file(path: Path) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as handle:
        while chunk := handle.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def probe(url: str) -> dict[str, Any]:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/zip,*/*"}
    request = urllib.request.Request(url, headers=headers, method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return {
                "reachable": True,
                "status": response.status,
                "finalUrl": response.geturl(),
                "contentLength": int(response.headers.get("Content-Length", "0") or 0),
                "contentType": response.headers.get("Content-Type", ""),
                "contentDisposition": response.headers.get("Content-Disposition", ""),
                "acceptRanges": response.headers.get("Accept-Ranges", ""),
            }
    except urllib.error.HTTPError as error:
        if error.code not in (400, 403, 405):
            return {"reachable": False, "status": error.code, "error": str(error)}
    except Exception as error:  # pragma: no cover - network-specific
        return {"reachable": False, "error": str(error)}

    # Some content services reject HEAD. A one-byte range request proves reachability
    # without downloading the archive.
    request = urllib.request.Request(
        url,
        headers={**headers, "Range": "bytes=0-0"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            content_range = response.headers.get("Content-Range", "")
            total = 0
            if "/" in content_range:
                total_token = content_range.rsplit("/", 1)[-1]
                if total_token.isdigit():
                    total = int(total_token)
            return {
                "reachable": True,
                "status": response.status,
                "finalUrl": response.geturl(),
                "contentLength": total or int(response.headers.get("Content-Length", "0") or 0),
                "contentType": response.headers.get("Content-Type", ""),
                "contentDisposition": response.headers.get("Content-Disposition", ""),
                "acceptRanges": response.headers.get("Accept-Ranges", ""),
                "contentRange": content_range,
            }
    except Exception as error:  # pragma: no cover - network-specific
        return {"reachable": False, "error": str(error)}


def download(url: str, destination: Path, expected_md5: str, retries: int) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and md5_file(destination) == expected_md5:
        return {
            "path": str(destination),
            "bytes": destination.stat().st_size,
            "md5": expected_md5,
            "downloaded": False,
        }

    partial = destination.with_suffix(destination.suffix + ".part")
    latest_error: Exception | None = None
    for attempt in range(max(1, retries)):
        try:
            existing = partial.stat().st_size if partial.exists() else 0
            headers = {
                "User-Agent": USER_AGENT,
                "Accept": "application/zip,*/*",
            }
            if existing:
                headers["Range"] = f"bytes={existing}-"
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=120) as response:
                append = existing > 0 and response.status == 206
                if existing and not append:
                    partial.unlink(missing_ok=True)
                    existing = 0
                mode = "ab" if append else "wb"
                with partial.open(mode) as handle:
                    while chunk := response.read(CHUNK_SIZE):
                        handle.write(chunk)
            actual_md5 = md5_file(partial)
            if actual_md5 != expected_md5:
                raise RuntimeError(
                    f"MD5 mismatch for {destination.name}: expected {expected_md5}, got {actual_md5}"
                )
            os.replace(partial, destination)
            return {
                "path": str(destination),
                "bytes": destination.stat().st_size,
                "md5": actual_md5,
                "downloaded": True,
            }
        except Exception as error:  # pragma: no cover - network-specific
            latest_error = error
            if attempt + 1 < max(1, retries):
                time.sleep(min(30, 2 ** attempt * 2))
    raise RuntimeError(f"Unable to download {url}: {latest_error}")


def safe_extract(archive: Path, destination: Path) -> list[str]:
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    extracted: list[str] = []
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            target = (destination / info.filename).resolve()
            if target != root and root not in target.parents:
                raise RuntimeError(f"Unsafe ZIP member: {info.filename}")
            bundle.extract(info, destination)
            extracted.append(info.filename)
    return extracted


def find_metainfo(root: Path) -> list[Path]:
    return sorted(
        candidate
        for candidate in root.rglob("*.json")
        if "metainfo" in candidate.name.lower()
    )


def value_shape(value: Any) -> str:
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    return type(value).__name__


def inspect_metainfo(root: Path) -> dict[str, Any]:
    files = find_metainfo(root)
    reports = []
    for filepath in files:
        payload = json.loads(filepath.read_text(encoding="utf-8"))
        report: dict[str, Any] = {
            "path": str(filepath.relative_to(root)),
            "topLevelType": value_shape(payload),
            "records": len(payload) if hasattr(payload, "__len__") else None,
        }
        if isinstance(payload, dict) and payload:
            sample_key = next(iter(payload))
            sample = payload[sample_key]
            report["keyShape"] = {
                "containsSlash": "/" in sample_key,
                "suffix": Path(sample_key).suffix,
                "length": len(sample_key),
            }
            if isinstance(sample, dict):
                report["recordFields"] = sorted(sample)
                counters: dict[str, Counter[str]] = {}
                for field in ("license", "license_name", "split", "partition"):
                    counter = Counter(
                        str(item.get(field, ""))
                        for item in payload.values()
                        if isinstance(item, dict) and item.get(field) not in (None, "")
                    )
                    if counter:
                        counters[field] = counter
                report["distributions"] = {
                    field: dict(counter.most_common(20))
                    for field, counter in counters.items()
                }
        reports.append(report)
    return {"metadataFiles": reports, "metadataFileCount": len(reports)}


def selected_sources(args: argparse.Namespace) -> list[dict[str, str]]:
    sources = [METADATA]
    if not args.metadata_only:
        for license_name in args.licenses:
            sources.append({"name": license_name, **ARCHIVES[license_name]})
    return sources


def main() -> int:
    args = parse_args()
    output = args.output.resolve()
    archives_dir = output / "archives"
    extracted_dir = output / "extracted"
    output.mkdir(parents=True, exist_ok=True)

    sources = selected_sources(args)
    report: dict[str, Any] = {
        "officialRepository": OFFICIAL_REPOSITORY,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sources": [],
    }
    for source in sources:
        item = {
            "name": source["name"],
            "url": source["url"],
            "expectedMd5": source["md5"],
            "probe": probe(source["url"]),
        }
        if not args.probe_only:
            archive = archives_dir / f"{source['name']}.zip"
            item["archive"] = download(source["url"], archive, source["md5"], args.retries)
            if not args.skip_extract:
                members = safe_extract(archive, extracted_dir)
                item["extractedMembers"] = len(members)
                item["memberPreview"] = members[:20]
            if not args.keep_archives and not args.skip_extract:
                archive.unlink(missing_ok=True)
                item["archiveRemovedAfterVerification"] = True
        report["sources"].append(item)

    if not args.probe_only and not args.skip_extract:
        report.update(inspect_metainfo(extracted_dir))
    report_path = output / "source-report.json"
    report_path.write_text(json.dumps(report, indent=2, default=lambda value: dict(value)), encoding="utf-8")
    print(json.dumps(report, indent=2, default=lambda value: dict(value)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
