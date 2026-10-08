#!/usr/bin/env python3
"""Fresh, deterministic, post-publication visual holdout. No automatic pass claims."""
import hashlib, io, json, math, random
from collections import Counter
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT=Path("public/seed-catalog")
OUT=Path("work/final-holdout")
SEED="many-faces-independent-final-holdout-2026-10-08-v1"
TARGET={"center":120,"left":100,"right":100,"wink":40}
manifest_bytes=(ROOT/"manifest.json").read_bytes()
manifest=json.loads(manifest_bytes)
assert manifest["totalFaces"]==manifest["searchableFaces"]==70000
assert len(manifest["cells"])==775
expected="fe90b250e37093bcf1ecb46b820cec98ece91e5bf2319681e0d3a3933767b03a"
assert hashlib.sha256(manifest_bytes).hexdigest()==expected, "Do not inspect a different catalog"
previous=json.loads(Path("data/catalog-previously-inspected.json").read_text())
seen={x["encodedSha256"] for x in previous["images"]}
entries=[]
for cell in manifest["cells"].values():
 for shard_name in cell.get("shards",[cell.get("shard")]):
  if not shard_name:continue
  shard=json.loads((ROOT/"shards"/shard_name).read_text())
  for entry in shard["items"]:
   yaw=float(entry["feature"][0])*90
   group="left" if yaw<=-12 else "right" if yaw>=12 else "center"
   entries.append((entry,group))
assert len(entries)==70000
# Wink metadata are used only as an extra challenge stratum, not as visual truth.
def is_wink(e):
 p=str(e.get("cleanProfile","")).lower()
 return "wink" in p or "wink" in str(e.get("name","")).lower()
groups={k:[] for k in TARGET}
for entry,pose in entries:
 h=entry.get("admissionSha256")
 if h in seen:continue
 group="wink" if is_wink(entry) else pose
 if group not in groups:group=pose
 score=hashlib.sha256((SEED+"|"+entry["id"]).encode()).hexdigest()
 groups[group].append((score,entry))
for group in groups:groups[group].sort(key=lambda x:x[0])
selected=[]
for group,n in TARGET.items():
 assert len(groups[group])>=n,(group,len(groups[group]))
 selected.extend((group,e) for _,e in groups[group][:n])
assert len(selected)==360
OUT.mkdir(parents=True,exist_ok=True)
photos=OUT/"images";photos.mkdir(exist_ok=True)
font=ImageFont.load_default()
rows=[];sheet=Image.new("RGB",(1200,1100),"#1b1b1b")
for i,(group,e) in enumerate(selected):
 pack=ROOT/"packs"/e["pack"]
 with pack.open("rb") as fh:
  fh.seek(e["offset"]);payload=fh.read(e["length"])
 digest=hashlib.sha256(payload).hexdigest()
 assert digest==e["admissionSha256"],("image admission mismatch",e["id"])
 if digest in seen:raise RuntimeError("Previously inspected photo sampled")
 with Image.open(io.BytesIO(payload)) as im:
  rgb=im.convert("RGB")
  rgb.thumbnail((188,145))
  thumb=rgb.copy()
 idx=f"H{i+1:03d}"
 (photos/(idx+".webp")).write_bytes(payload)
 if i%30==0:
  sheet=Image.new("RGB",(1200,1100),"#1b1b1b")
 x=(i%5)*240;y=((i//5)%6)*180
 sheet.paste(thumb,(x+(240-thumb.width)//2,y+5))
 draw=ImageDraw.Draw(sheet)
 draw.text((x+8,y+151),f"{idx} {group} yaw={e['feature'][0]*90:+.1f}",font=font,fill="#ffffff")
 rows.append({"sample":idx,"id":e["id"],"sha256":digest,"group":group,"yaw":e["feature"][0]*90,"profile":e.get("cleanProfile"),"source":e.get("sourceName"),"image":f"images/{idx}.webp","visualDecision":"unreviewed"})
 if i%30==29:
  sheet.save(OUT/f"sheet-{i//30+1:02d}.png",optimize=True)
assert len({r["sha256"] for r in rows})==360
report={"schemaVersion":1,"status":"unreviewed","humanVerified":False,"assistantVisualReviewCompleted":False,"independentOfPriorSample":True,"seed":SEED,"manifestSha256":expected,"catalogTotal":70000,"previouslyInspectedExcluded":len(seen),"sampleCount":360,"strata":dict(Counter(r["group"] for r in rows)),"notes":["Deterministic challenge-stratified sample; not a population prevalence estimate.","Contact sheets and original exact WebP bytes are provided for independent visual inspection.","No pass/fail decision has been fabricated."],"samples":rows}
(OUT/"report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
print("FINAL_HOLDOUT "+json.dumps({"samples":len(rows),"strata":report["strata"],"sheets":12,"status":"unreviewed"}))
