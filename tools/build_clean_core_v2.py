#!/usr/bin/env python3
"""Build a >=70k high-quality single-factor Many Faces catalog."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import html
import io
import json
import math
import re
import shutil
import struct
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageOps

from clean_core_policy_v2 import (
    FEATURE_LENGTH, POLICY_VERSION, PROFILE_CELL_LIMITS, PROFILE_GROUPS,
    PROFILE_MINIMUMS, PROFILE_POSE_CELL_MINIMUMS, PROFILE_PRIORITY,
    CleanProfile, classify_clean_profile, quantized_pose_cell,
)

PACK_TARGET_BYTES = 7_500_000
SHARD_ENTRY_LIMIT = 700
ARTWORK_TERMS = {
    "painting", "painted portrait", "drawing", "illustration", "illustrated", "sketch",
    "engraving", "lithograph", "collage", "cartoon", "comic", "sculpture", "statue",
    "ceramic", "wax figure", "poster artwork", "digital art", "digital collage", "character art",
}
MOUTH_OCCLUSION_TERMS = {
    "eating", "eat ", "food", "candy", "chocolate", "ice cream", "icecream", "spoon",
    "fork", "straw", "drinking", "drink ", "microphone", "singing", "singer", "cigar",
    "cigarette", "smoking", "pipe", "tongue", "lollipop", "toothbrush", "pacifier",
    "mask", "face paint", "clown",
}


@dataclass
class SourceCatalog:
    label: str
    root: Path
    manifest: dict[str, Any]
    catalog_id: str
    entries: list[dict[str, Any]]
    handles: dict[str, BinaryIO] = field(default_factory=dict)

    def read_image(self, entry: dict[str, Any]) -> bytes:
        pack = str(entry["pack"])
        handle = self.handles.get(pack)
        if handle is None:
            handle = (self.root / "packs" / pack).open("rb")
            self.handles[pack] = handle
        handle.seek(int(entry["offset"]))
        payload = handle.read(int(entry["length"]))
        if len(payload) != int(entry["length"]):
            raise ValueError(f"{self.catalog_id}:{entry.get('id')}: truncated packed image")
        return payload

    def close(self) -> None:
        for handle in self.handles.values(): handle.close()
        self.handles.clear()


@dataclass
class Candidate:
    source: SourceCatalog
    entry: dict[str, Any]
    profile: CleanProfile
    cell: str
    yaw: int
    pitch: int
    preliminary: float
    structure: tuple[float, ...] = ()
    image_bytes: bytes | None = None
    image_sha256: str = ""
    dhash: str = ""
    quality: dict[str, float] = field(default_factory=dict)
    score: float = 0.0

    @property
    def key(self) -> str:
        return f"{self.source.catalog_id}:{self.entry.get('id')}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--catalog", action="append", default=[], metavar="LABEL=PATH")
    parser.add_argument("--target-total", type=int, default=70_000)
    parser.add_argument("--preselect-multiplier", type=int, default=6)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    if not args.catalog: parser.error("at least one --catalog LABEL=PATH is required")
    if args.target_total < 70_000: parser.error("target-total must be at least 70,000")
    return args


def parse_catalog_arg(value: str) -> tuple[str, Path]:
    label, sep, raw = value.partition("=")
    if not sep or not label.strip() or not raw.strip():
        raise ValueError(f"invalid --catalog {value!r}")
    return label.strip(), Path(raw).resolve()


def load_catalog(label: str, root: Path) -> SourceCatalog:
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 3: raise ValueError(f"{root}: schemaVersion must be 3")
    if int(manifest.get("featureLength", 0)) != FEATURE_LENGTH: raise ValueError(f"{root}: featureLength must be {FEATURE_LENGTH}")
    names = sorted({name for cell in manifest.get("cells", {}).values() for name in (cell.get("shards") or ([cell["shard"]] if cell.get("shard") else []))})
    entries: list[dict[str, Any]] = []
    for name in names:
        payload = json.loads((root / "shards" / name).read_text(encoding="utf-8"))
        entries.extend(payload.get("items", []))
    return SourceCatalog(label, root, manifest, str(manifest.get("catalogId") or label), entries)


def decode_vector(encoded: str | None, *, stride: int = 2, limit: int = 96) -> tuple[float, ...]:
    if not encoded: return ()
    try:
        payload = base64.b64decode(encoded)
        raw = struct.unpack(f"<{len(payload)//2}h", payload)
        return tuple(value / 4096.0 for value in raw[::max(1, stride)][:limit])
    except Exception:
        return ()


def title_rejection(entry: dict[str, Any], profile: CleanProfile) -> str | None:
    text = str(entry.get("name", "")).lower()
    if any(term in text for term in ARTWORK_TERMS): return "likely_artwork"
    if profile.group == "mouth" and any(term in text for term in MOUTH_OCCLUSION_TERMS): return "mouth_occlusion_title"
    return None


def layout_score(entry: dict[str, Any]) -> float:
    layout = entry.get("layout")
    if not isinstance(layout, list) or len(layout) != 4: return 0.0
    cx, cy, width, height = (float(value) for value in layout)
    center = 1.0 - min(1.0, abs(cx - .5) / .28 + abs(cy - .52) / .30)
    size = min(1.0, max(0.0, (min(width, height) - .36) / .34))
    return max(0.0, center * .40 + size * .60)


def source_bonus(source: SourceCatalog) -> float:
    text = f"{source.label} {source.catalog_id}".lower()
    if "open-images" in text or "open images" in text: return .06
    if "openverse" in text or "commons" in text: return .10
    return 0.0


def preliminary_score(source: SourceCatalog, entry: dict[str, Any], profile: CleanProfile) -> float:
    roll_score = max(0.0, 1.0 - max(0.0, abs(profile.roll) - 38) / 52)
    return profile.purity * .60 + min(1.0, profile.strength) * .18 + layout_score(entry) * .12 + source_bonus(source) + roll_score * .04


def image_metrics(payload: bytes) -> tuple[dict[str, float], str]:
    with Image.open(io.BytesIO(payload)) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
    pixels = np.asarray(image.resize((128, 128), Image.Resampling.BILINEAR), dtype=np.float32)
    gray = pixels[:, :, 0] * .299 + pixels[:, :, 1] * .587 + pixels[:, :, 2] * .114
    lap = (-4 * gray + np.roll(gray,1,0)+np.roll(gray,-1,0)+np.roll(gray,1,1)+np.roll(gray,-1,1))[1:-1,1:-1]
    rg = pixels[:,:,0] - pixels[:,:,1]; yb = (pixels[:,:,0]+pixels[:,:,1])/2 - pixels[:,:,2]
    color = math.sqrt(float(rg.var()+yb.var())) + .3 * math.sqrt(float(rg.mean()**2+yb.mean()**2))
    hp = np.asarray(image.convert("L").resize((9,8), Image.Resampling.BILINEAR))
    bits = hp[:,1:] > hp[:,:-1]
    return {
        "sharpness": float(lap.var()), "brightness": float(gray.mean()), "contrast": float(gray.std()),
        "colorfulness": color, "clippedFraction": float(((gray<8)|(gray>247)).mean()),
    }, f"{sum(int(bit)<<index for index,bit in enumerate(bits.reshape(-1))):016x}"


def quality_decision(source: SourceCatalog, metrics: dict[str,float]) -> tuple[bool,str,float]:
    is_ffhq = "ffhq" in f"{source.label} {source.catalog_id}".lower()
    sharp_min = 24 if is_ffhq else 42; contrast_min = 18 if is_ffhq else 23
    color_min = 0 if is_ffhq else 4.5; bright_min = 28 if is_ffhq else 34
    bright_max = 226 if is_ffhq else 220; clip_max = .48 if is_ffhq else .42
    if metrics["sharpness"] < sharp_min: return False,"blur",0
    if not bright_min <= metrics["brightness"] <= bright_max: return False,"brightness",0
    if metrics["contrast"] < contrast_min: return False,"low_contrast",0
    if metrics["colorfulness"] < color_min: return False,"low_colorfulness",0
    if metrics["clippedFraction"] > clip_max: return False,"clipping",0
    sharp = min(1.0, math.log1p(metrics["sharpness"])/math.log1p(720))
    bright = max(0.0,1-abs(metrics["brightness"]-118)/118)
    contrast = min(1.0,metrics["contrast"]/68); color = min(1.0,metrics["colorfulness"]/58)
    clipping = max(0.0,1-metrics["clippedFraction"]/max(clip_max,1e-6))
    return True,"",sharp*.33+bright*.18+contrast*.24+color*.10+clipping*.15


def hamming(left: str, right: str) -> int: return (int(left,16)^int(right,16)).bit_count()

def structure_distance(left: Sequence[float], right: Sequence[float]) -> float:
    length = min(len(left),len(right))
    if not length: return 0.0
    return min(1.0, math.sqrt(sum((left[i]-right[i])**2 for i in range(length))/length)/.24)

def creator_key(c: Candidate) -> str: return str(c.entry.get("creator","")).strip().lower()


def rank_diverse(candidates: list[Candidate], limit: int) -> list[Candidate]:
    remaining = sorted(candidates,key=lambda c:(-c.score,c.source.catalog_id,str(c.entry.get("id"))))
    selected: list[Candidate]=[]; creators:Counter[str]=Counter(); hashes:list[str]=[]
    while remaining and len(selected)<limit:
        best_i=-1; best_v=-99.0
        for i,c in enumerate(remaining[:400]):
            if any(hamming(c.dhash,h)<=2 for h in hashes): continue
            diversity = min((structure_distance(c.structure,p.structure) for p in selected), default=1.0)
            creator=creator_key(c); penalty=min(.22,creators[creator]*.05) if creator else 0
            value=c.score+diversity*.24-penalty
            if value>best_v: best_v=value; best_i=i
        if best_i<0: break
        c=remaining.pop(best_i); selected.append(c); hashes.append(c.dhash)
        if creator_key(c): creators[creator_key(c)]+=1
    return selected


def pose_token(value:int)->str: return f"p{value:03d}" if value>=0 else f"n{abs(value):03d}"
def safe_slug(value:str)->str: return re.sub(r"[^a-z0-9]+","-",value.lower()).strip("-")[:28] or "source"


def choose_minimums(selected_by_group: dict[tuple[str,str],list[Candidate]]) -> tuple[list[Candidate], list[str]]:
    chosen: list[Candidate]=[]; used:set[str]=set(); failures:list[str]=[]
    for profile in PROFILE_PRIORITY:
        needed=PROFILE_MINIMUMS[profile]
        cells=sorted([cell for p,cell in selected_by_group if p==profile and selected_by_group[(p,cell)]],key=lambda x:tuple(map(int,x.split(":"))))
        round_index=0
        while len([c for c in chosen if c.profile.name==profile])<needed:
            added=False
            for cell in cells:
                items=selected_by_group[(profile,cell)]
                if round_index<len(items):
                    c=items[round_index]
                    if c.key not in used: chosen.append(c); used.add(c.key); added=True
                    if len([x for x in chosen if x.profile.name==profile])>=needed: break
            if not added: break
            round_index+=1
        count=sum(1 for c in chosen if c.profile.name==profile)
        if count<needed: failures.append(f"{profile}: {count:,} < required {needed:,}")
    return chosen, failures


def write_contact_sheet(path:Path,profile:str,items:list[Candidate])->None:
    if not items:return
    ordered=sorted(items,key=lambda c:(c.yaw,c.pitch,-c.score)); chosen=[]; seen=set()
    for c in ordered:
        if c.cell not in seen: chosen.append(c); seen.add(c.cell)
        if len(chosen)>=30:break
    for c in sorted(items,key=lambda c:-c.score):
        if c not in chosen: chosen.append(c)
        if len(chosen)>=30:break
    w,h=160,182; sheet=Image.new("RGB",(w*6,h*5),"white"); draw=ImageDraw.Draw(sheet)
    for i,c in enumerate(chosen):
        with Image.open(io.BytesIO(c.image_bytes or b"")) as opened:
            image=ImageOps.fit(ImageOps.exif_transpose(opened).convert("RGB"),(w,w))
        x,y=i%6*w,i//6*h; sheet.paste(image,(x,y)); draw.text((x+3,y+w+2),f"{c.yaw:+d},{c.pitch:+d} {c.score:.2f}",fill="black")
    sheet.save(path,"JPEG",quality=88,optimize=True)


def main()->int:
    args=parse_args(); output=args.output.resolve()
    if output.exists() and any(output.iterdir()) and not args.overwrite: raise SystemExit("Output directory is not empty")
    if args.overwrite and output.exists(): shutil.rmtree(output)
    catalog=output/"catalog"; packs=catalog/"packs"; shards=catalog/"shards"; review=output/"review"; sheets=review/"contact-sheets"
    packs.mkdir(parents=True); shards.mkdir(parents=True); sheets.mkdir(parents=True)
    sources=[load_catalog(*parse_catalog_arg(value)) for value in args.catalog]
    rejects:Counter[str]=Counter(); classified:Counter[str]=Counter(); groups:dict[tuple[str,str],list[Candidate]]=defaultdict(list)
    input_entries=sum(len(source.entries) for source in sources)
    try:
        for source in sources:
            for entry in source.entries:
                feature=entry.get("feature")
                if not isinstance(feature,list) or len(feature)!=FEATURE_LENGTH or not all(math.isfinite(float(v)) for v in feature): rejects["invalid_feature"]+=1; continue
                profile=classify_clean_profile(feature,entry.get("projection"))
                if profile is None: rejects["mixed_or_unsupported_state"]+=1; continue
                reason=title_rejection(entry,profile)
                if reason: rejects[reason]+=1; continue
                cell,yaw,pitch=quantized_pose_cell(feature,3)
                c=Candidate(source,entry,profile,cell,yaw,pitch,preliminary_score(source,entry,profile),decode_vector(entry.get("shape")))
                groups[(profile.name,cell)].append(c); classified[profile.name]+=1

        evaluated:dict[tuple[str,str],list[Candidate]]={}; exact:set[str]=set()
        for key,candidates in sorted(groups.items()):
            limit=PROFILE_CELL_LIMITS[key[0]]; preselect=max(limit*args.preselect_multiplier,limit+16)
            ranked=sorted(candidates,key=lambda c:(-c.preliminary,c.source.catalog_id,str(c.entry.get("id"))))[:preselect]
            accepted=[]
            for c in ranked:
                try:
                    payload=c.source.read_image(c.entry); digest=hashlib.sha256(payload).hexdigest()
                    if digest in exact: rejects["exact_image_duplicate"]+=1; continue
                    metrics,dhash=image_metrics(payload); ok,reason,q=quality_decision(c.source,metrics)
                    if not ok: rejects[reason]+=1; continue
                except Exception: rejects["image_read_error"]+=1; continue
                c.image_bytes=payload;c.image_sha256=digest;c.dhash=dhash;c.quality=metrics
                c.score=c.preliminary*.66+q*.29+layout_score(c.entry)*.05
                accepted.append(c);exact.add(digest)
            evaluated[key]=accepted
        selected_by_group={key:rank_diverse(items,PROFILE_CELL_LIMITS[key[0]]) for key,items in evaluated.items()}
        selected,minimum_failures=choose_minimums(selected_by_group); used={c.key for c in selected}
        cells=sorted({cell for _,cell in selected_by_group},key=lambda x:tuple(map(int,x.split(":"))))
        max_round=max(PROFILE_CELL_LIMITS.values())
        for round_index in range(max_round):
            for profile in PROFILE_PRIORITY:
                for cell in cells:
                    items=selected_by_group.get((profile,cell),[])
                    if round_index<len(items):
                        c=items[round_index]
                        if c.key not in used: selected.append(c);used.add(c.key)
                        if len(selected)>=args.target_total:break
                if len(selected)>=args.target_total:break
            if len(selected)>=args.target_total:break
        # Overflow fill if profile/cell caps were the only reason the target was missed.
        if len(selected)<args.target_total:
            overflow=sorted((c for items in evaluated.values() for c in items if c.key not in used),key=lambda c:-c.score)
            for c in overflow:
                selected.append(c);used.add(c.key)
                if len(selected)>=args.target_total:break

        by_profile:dict[str,list[Candidate]]=defaultdict(list)
        for c in selected: by_profile[c.profile.name].append(c)
        profile_counts={p:len(by_profile.get(p,[])) for p in PROFILE_PRIORITY}
        profile_cells={p:len({c.cell for c in by_profile.get(p,[])}) for p in PROFILE_PRIORITY}
        gate_failures=list(minimum_failures)
        if len(selected)<args.target_total: gate_failures.append(f"total: {len(selected):,} < required {args.target_total:,}")
        for p,required in PROFILE_POSE_CELL_MINIMUMS.items():
            if profile_cells[p]<required: gate_failures.append(f"{p} pose cells: {profile_cells[p]:,} < required {required:,}")

        # Always emit an audit, even if the acceptance gate fails.
        source_counts=Counter(c.source.catalog_id for c in selected)
        audit={
            "policyVersion":POLICY_VERSION,"inputEntries":input_entries,
            "inputCatalogs":{s.catalog_id:len(s.entries) for s in sources},
            "classifiedCandidates":sum(classified.values()),"classifiedProfiles":dict(sorted(classified.items())),
            "selectedFaces":len(selected),"targetFaces":args.target_total,
            "selectedProfiles":profile_counts,"selectedProfilePoseCells":profile_cells,
            "selectedSources":dict(sorted(source_counts.items())),"rejections":dict(sorted(rejects.items())),
            "limits":PROFILE_CELL_LIMITS,"minimums":PROFILE_MINIMUMS,"poseCellMinimums":PROFILE_POSE_CELL_MINIMUMS,
            "gatePassed":not gate_failures,"gateFailures":gate_failures,
        }
        (output/"audit.json").write_text(json.dumps(audit,indent=2),encoding="utf-8")
        if gate_failures:
            print(json.dumps(audit,indent=2)); return 2

        selected.sort(key=lambda c:(c.yaw,c.pitch,c.profile.name,-c.score))
        pack_index=0;pack_size=0;handle:BinaryIO|None=None;output_entries:dict[str,list[dict[str,Any]]]=defaultdict(list)
        def append(payload:bytes)->tuple[str,int,int]:
            nonlocal pack_index,pack_size,handle
            if handle is None or (pack_size and pack_size+len(payload)>PACK_TARGET_BYTES):
                if handle:handle.close()
                name=f"clean_v2_faces_{pack_index:05d}.bin";pack_index+=1;pack_size=0;handle=(packs/name).open("wb")
            else:name=Path(handle.name).name
            offset=pack_size;handle.write(payload);pack_size+=len(payload);return name,offset,len(payload)
        for c in selected:
            payload=c.image_bytes
            if payload is None:raise RuntimeError("selected image missing")
            pack,offset,length=append(payload);source_slug=safe_slug(c.source.catalog_id);original=str(c.entry.get("id"))
            entry={**c.entry,"id":f"clean-v2-{source_slug}-{original}","pack":pack,"offset":offset,"length":length,
                   "cleanProfile":c.profile.name,"cleanGroup":c.profile.group,"cleanPolicy":POLICY_VERSION,
                   "cleanPurity":round(c.profile.purity,6),"cleanScore":round(c.score,6),"sourceCatalogId":c.source.catalog_id}
            output_entries[c.cell].append(entry)
        if handle:handle.close()
        cells_manifest={};shard_count=0
        for cell,items in sorted(output_entries.items(),key=lambda item:tuple(map(int,item[0].split(":")))):
            yaw,pitch=map(int,cell.split(":"));names=[]
            for start in range(0,len(items),SHARD_ENTRY_LIMIT):
                name=f"clean_v2_yaw_{pose_token(yaw)}_pitch_{pose_token(pitch)}_{start//SHARD_ENTRY_LIMIT:03d}.json"
                (shards/name).write_text(json.dumps({"cell":cell,"items":items[start:start+SHARD_ENTRY_LIMIT]},ensure_ascii=False,separators=(",",":")),encoding="utf-8")
                names.append(name);shard_count+=1
            cells_manifest[cell]={"count":len(items),"shards":names}
        manifest={
            "schemaVersion":3,"catalogId":"many-faces-clean-core-v2","generatedAt":datetime.now(timezone.utc).isoformat(),
            "totalFaces":len(selected),"sourceFaces":len(selected),"searchableFaces":len(selected),"poseStep":3,
            "bounds":{"yawMin":-45,"yawMax":45,"pitchMin":-36,"pitchMax":36},"outputSize":256,
            "shapeVersion":"mediapipe-projection-468-v4","featureSchema":"mediapipe-face-actions-v2","featureLength":FEATURE_LENGTH,
            "shardsContainGeometry":True,"indexFiles":[],"cells":cells_manifest,
            "stats":{"cleanCore":{"policyVersion":POLICY_VERSION,"selectedFaces":len(selected),"profileCounts":profile_counts,
                    "profilePoseCells":profile_cells,"sourceCatalogCounts":dict(sorted(source_counts.items())),
                    "gatePassed":True,"selection":{"strategy":"profile minimums, 3-degree breadth-first, identity diversity","targetTotal":args.target_total}},
                    "poseCells":len(cells_manifest),"packCount":pack_index,"shardCount":shard_count},
        }
        (catalog/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,separators=(",",":")),encoding="utf-8")
        with (output/"coverage.csv").open("w",encoding="utf-8",newline="") as f:
            writer=csv.writer(f);writer.writerow(("profile","cell","yaw","pitch","count","best_score"))
            for (p,cell),items in sorted(selected_by_group.items()):
                if items:
                    yaw,pitch=map(int,cell.split(":"));writer.writerow((p,cell,yaw,pitch,len(items),f"{max(c.score for c in items):.6f}"))
        for p,items in by_profile.items():write_contact_sheet(sheets/f"{p}.jpg",p,items)
        cards="\n".join(f"<section><h2>{html.escape(p)} — {profile_counts[p]:,} / {profile_cells[p]:,} pose cells</h2><img src='contact-sheets/{html.escape(p)}.jpg'></section>" for p in PROFILE_PRIORITY if profile_counts[p])
        (review/"index.html").write_text(f"<!doctype html><meta charset='utf-8'><title>Clean Core v2</title><style>body{{font:16px system-ui;margin:24px;background:#eee}}section,header{{background:white;padding:16px;margin:14px 0;border-radius:12px}}img{{max-width:100%}}</style><header><h1>Many Faces Clean Core v2</h1><p>{len(selected):,} physical images. Every advertised single-factor profile passed explicit count and 3-degree pose-coverage gates.</p></header>{cards}",encoding="utf-8")
        (output/"README.md").write_text(f"# Many Faces Clean Core v2\n\nPhysical searchable faces: **{len(selected):,}**.\n\nSee `audit.json`, `coverage.csv`, and `review/index.html`.\n",encoding="utf-8")
        print(json.dumps(audit,indent=2));return 0
    finally:
        for source in sources:source.close()

if __name__=="__main__":raise SystemExit(main())
