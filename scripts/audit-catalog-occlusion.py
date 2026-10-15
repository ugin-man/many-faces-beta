#!/usr/bin/env python3
import argparse, io, json, hashlib
from pathlib import Path
import cv2, numpy as np, onnxruntime as ort
from PIL import Image
def resize_pad(image,size=(128,128)):
 dh,dw=size;h,w=image.shape[:2];scale=min(dh/h,dw/w);nh,nw=int(np.floor(h*scale)),int(np.floor(w*scale))
 if dh/h<dw/w:nh=dh
 else:nw=dw
 resized=cv2.resize(image,(nw,nh),interpolation=cv2.INTER_AREA if scale<1 else cv2.INTER_LINEAR)
 canvas=np.zeros((dh,dw,3),dtype=np.uint8);top,left=(dh-nh)//2,(dw-nw)//2;canvas[top:top+nh,left:left+nw]=resized;return canvas
def blob(payload):
 with Image.open(io.BytesIO(payload)) as im:rgb=np.asarray(im.convert("RGB"))
 bgr=cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR);padded=resize_pad(bgr);rgb=cv2.cvtColor(padded,cv2.COLOR_BGR2RGB)
 return np.transpose(rgb.astype(np.float32)/255.0,(2,0,1))
def read_image(root,entry,handles):
 if entry.get("image"):return (root/"images"/entry["image"]).read_bytes()
 pack=entry["pack"];h=handles.get(pack)
 if h is None:h=(root/"packs"/pack).open("rb");handles[pack]=h
 h.seek(int(entry["offset"]));return h.read(int(entry["length"]))
def main():
 ap=argparse.ArgumentParser();ap.add_argument("--root",default="public/seed-catalog");ap.add_argument("--model",required=True);ap.add_argument("--out",required=True);ap.add_argument("--batch",type=int,default=128);args=ap.parse_args()
 root=Path(args.root);manifest=json.loads((root/"manifest.json").read_text());files=sorted({f for c in manifest["cells"].values() for f in c.get("shards",[c.get("shard")]) if f});rows=[]
 for f in files:rows.extend(json.loads((root/"shards"/f).read_text())["items"])
 assert len(rows)==70000,len(rows)
 session=ort.InferenceSession(args.model,providers=["CPUExecutionProvider"]);inp=session.get_inputs()[0].name;out=session.get_outputs()[0].name;handles={};flagged=[];scores=[];model_hash=hashlib.sha256(Path(args.model).read_bytes()).hexdigest()
 try:
  for start in range(0,len(rows),args.batch):
   batch=rows[start:start+args.batch];tensors=[];valid=[]
   for entry in batch:
    try:tensors.append(blob(read_image(root,entry,handles)));valid.append(entry)
    except Exception as e:flagged.append({"id":entry.get("id"),"reason":"decode_error","error":str(e)})
   if tensors:
    values=np.asarray(session.run([out],{inp:np.stack(tensors)})[0]).reshape(-1,5)
    for entry,v in zip(valid,values):
     mask=float(v[3]);sunglasses=float(v[4]);name=str(entry.get("name","")).lower();title_mask=any(t in name for t in ("face mask","facemask","surgical mask","n95","kn95","masked face"));title_sun=any(t in name for t in ("sunglasses","sun glasses","shades"));reason=None
     if sunglasses>=.985 or (sunglasses>=.94 and title_sun):reason="sunglasses"
     elif mask>=.985 or (mask>=.94 and title_mask):reason="face_mask"
     if reason:flagged.append({"id":entry.get("id"),"reason":reason,"mask":round(mask,6),"sunglasses":round(sunglasses,6),"name":entry.get("name"),"yaw":round(float(entry.get("feature",[0])[0])*90,2) if entry.get("feature") else None})
     if mask>=.90 or sunglasses>=.90:scores.append({"id":entry.get("id"),"mask":round(mask,6),"sunglasses":round(sunglasses,6),"name":entry.get("name")})
   print(f"OCCLUSION_PROGRESS {min(start+args.batch,len(rows))}/70000",flush=True)
 finally:
  for h in handles.values():h.close()
 payload={"schemaVersion":1,"catalogId":manifest.get("catalogId"),"catalogFaces":len(rows),"model":"FaceAttribNet","modelSha256":model_hash,"thresholdPolicy":{"hard":.985,"titleCorroborated":.94},"excluded":flagged,"review90":scores,"ordinaryEyeglassesAllowed":True,"facePaintNotExcludedByPolicy":True}
 Path(args.out).parent.mkdir(parents=True,exist_ok=True);Path(args.out).write_text(json.dumps(payload,ensure_ascii=False,indent=2));print("OCCLUSION_RESULT "+json.dumps({"excluded":len(flagged),"review90":len(scores),"modelSha256":model_hash}),flush=True)
if __name__=="__main__":main()
