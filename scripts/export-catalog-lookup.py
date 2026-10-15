"""Read-only thumbnails for matching an already rendered photograph to its asset.

No user video or screenshot is uploaded. Thumbnails are investigation artifacts,
never application/catalog replacements. Exact original hashes identify matches.
"""
import hashlib
import io
import json
import zipfile
from pathlib import Path

from PIL import Image

root = Path("public/seed-catalog")
out = Path("work/photo-lookup")
out.mkdir(parents=True, exist_ok=True)
manifest_bytes = (root / "manifest.json").read_bytes()
assert hashlib.sha256(manifest_bytes).hexdigest() == "fe90b250e37093bcf1ecb46b820cec98ece91e5bf2319681e0d3a3933767b03a"
manifest = json.loads(manifest_bytes)
assert manifest["totalFaces"] == 70000 and manifest["poseStep"] == 3 and len(manifest["cells"]) == 775
files = sorted({f for c in manifest["cells"].values() for f in c.get("shards", [c.get("shard")]) if f})
records = []
archives = [zipfile.ZipFile(out / f"thumbnails-{i}.zip", "w", zipfile.ZIP_STORED) for i in range(2)]
try:
    for shard in files:
        items = json.loads((root / "shards" / shard).read_text())["items"]
        for item in items:
            if item.get("image"):
                payload = (root / "images" / item["image"]).read_bytes()
            else:
                with (root / "packs" / item["pack"]).open("rb") as stream:
                    stream.seek(item["offset"])
                    payload = stream.read(item["length"])
            digest = hashlib.sha256(payload).hexdigest()
            assert digest == item["admissionSha256"]
            index = len(records)
            with Image.open(io.BytesIO(payload)) as opened:
                image = opened.convert("RGB")
                image.thumbnail((128, 128), Image.Resampling.LANCZOS)
                thumb = io.BytesIO()
                image.save(thumb, "JPEG", quality=85)
            filename = f"{index:05d}.jpg"
            archives[index % 2].writestr(filename, thumb.getvalue())
            records.append({"index": index, "file": filename, "shard": shard,
                            **{key: item[key] for key in ["id", "feature", "layout", "pack", "offset", "length", "admissionSha256"] if key in item}})
        if len(records) % 5000 < len(items):
            print(f"Exported {len(records)} read-only thumbnails", flush=True)
finally:
    for archive in archives:
        archive.close()
assert len(records) == 70000 and len({r["id"] for r in records}) == 70000
(out / "index.json").write_text(json.dumps({"catalogId": manifest["catalogId"], "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(), "records": records}))
print("Export complete; originals unchanged", flush=True)
