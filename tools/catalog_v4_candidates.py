#!/usr/bin/env python3
"""Re-evaluate exact encoded pixels before admitting a candidate to any pack."""
from __future__ import annotations
import argparse, base64, csv, hashlib, io, json, math, os, struct, time
from collections import Counter
from pathlib import Path
import cv2
import numpy as np
import onnxruntime as ort
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
from PIL import Image, ImageOps
from build_face_catalog import BLEND_KEYS, face_geometry, pose_from_matrix
from catalog_v4_policy import VERSION, visibility_reason, pose_cell, opposite_pose, mirror_consistent, expression_tag


def blob(image):
    rgb = np.asarray(image.convert('RGB'))
    h,w = rgb.shape[:2]
    scale = min(128/h, 128/w)
    nh,nw = max(1,int(math.floor(h*scale))), max(1,int(math.floor(w*scale)))
    if 128/h < 128/w: nh = 128
    else: nw = 128
    resized = cv2.resize(rgb, (nw,nh), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
    padded = np.zeros((128,128,3),dtype=np.uint8)
    top,left = (128-nh)//2,(128-nw)//2
    padded[top:top+nh,left:left+nw] = resized
    return np.transpose(padded.astype(np.float32)/255, (2,0,1))[None]

def encode(values):
    if not all(math.isfinite(x) and -8 <= x <= 32767/4096 for x in values):
        raise ValueError('Geometry cannot be encoded without clipping')
    return base64.b64encode(struct.pack('<'+'h'*len(values),*[round(x*4096) for x in values])).decode()

def features(result):
    pose = pose_from_matrix(result.facial_transformation_matrixes[0])
    values = [pose[0],pose[1]*1.4,pose[2]]
    scores = {x.category_name:float(x.score) for x in result.face_blendshapes[0]}
    return values + [scores.get(key,0.) for key in BLEND_KEYS]

def seed_rows(root, part, parts):
    manifest = json.loads((root/'manifest.json').read_text())
    files = sorted({f for c in manifest['cells'].values() for f in c.get('shards',[c.get('shard')]) if f})
    index = 0
    for file in files:
        entries = json.loads((root/'shards'/file).read_text())['items']
        handles = {}
        try:
            for entry in entries:
                take = index % parts == part
                index += 1
                if not take: continue
                if entry.get('image'): payload = (root/'images'/entry['image']).read_bytes()
                else:
                    pack = entry['pack']
                    if pack not in handles: handles[pack] = (root/'packs'/pack).open('rb')
                    handle = handles[pack]
                    handle.seek(entry['offset']); payload = handle.read(entry['length'])
                    if len(payload) != entry['length']: raise ValueError('Truncated source pack')
                yield entry,payload
        finally:
            for handle in handles.values(): handle.close()
    if index != 70000: raise ValueError(f'Incomplete source: {index}')

def staged_rows(root):
    with (root/'metadata.csv').open(newline='',encoding='utf-8-sig') as handle:
        rows = list(csv.DictReader(handle))
    for row in sorted(rows,key=lambda r:r['relative_path']):
        source = (root/row['relative_path']).resolve()
        if not source.is_relative_to(root.resolve()): raise ValueError('Unsafe source path')
        with Image.open(source) as original:
            image = ImageOps.exif_transpose(original).convert('RGB')
            image.thumbnail((384,384),Image.Resampling.LANCZOS)
            encoded = io.BytesIO(); image.save(encoded,'WEBP',quality=90,method=4)
        payload = encoded.getvalue()
        yield {'id':'v4-'+hashlib.sha256(payload).hexdigest()[:24], 'name':row['title'],
            'sourceName':row['source_name'],'sourceUrl':row['source_url'],'creator':row['creator'],
            'license':row['license'],'licenseUrl':row['license_url'],
            'sourceImageId':row.get('open_images_id'), 'changes':'Face crop, resize and WebP conversion; no reflection or generated expression.'},payload

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--kind',choices=['seed','source'],required=True)
    parser.add_argument('--part',type=int,default=0); parser.add_argument('--parts',type=int,default=4)
    parser.add_argument('--root',type=Path,required=True); parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--attribute-model',type=Path,required=True); parser.add_argument('--face-model',type=Path,required=True)
    parser.add_argument('--limit',type=int,default=0)
    args = parser.parse_args(); args.out.mkdir(parents=True,exist_ok=True)
    if (args.out/'items.jsonl').exists(): raise ValueError('Output already exists')
    options = ort.SessionOptions(); options.intra_op_num_threads = 2; options.inter_op_num_threads = 1
    attribute = ort.InferenceSession(str(args.attribute_model),sess_options=options,providers=['CPUExecutionProvider'])
    input_name = attribute.get_inputs()[0].name
    def attributes(image):
        values = np.asarray(attribute.run(None,{input_name:blob(image)})[0]).reshape(-1).tolist()
        visibility_reason(values)  # Validate schema even for passing values.
        return values
    landmark_options = vision.FaceLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=str(args.face_model)), running_mode=vision.RunningMode.IMAGE,
        num_faces=2,output_face_blendshapes=True,output_facial_transformation_matrixes=True,
        min_face_detection_confidence=.5,min_face_presence_confidence=.5,min_tracking_confidence=.5)
    rows = seed_rows(args.root,args.part,args.parts) if args.kind == 'seed' else staged_rows(args.root)
    summary = {'policy':VERSION,'kind':args.kind,'part':args.part,'parts':args.parts,'scanned':0,'accepted':0,
        'rejected':Counter(),'expressions':Counter(),'poseCells':Counter(),'pixelSource':'exact-final-encoded-bytes',
        'attributeModelSha256':hashlib.sha256(args.attribute_model.read_bytes()).hexdigest(),
        'faceModelSha256':hashlib.sha256(args.face_model.read_bytes()).hexdigest(),'humanVerified':False}
    start = time.monotonic(); pack_index=0; pack_bytes=0; pack=None; known=set()
    preview = args.out/'previews'; preview.mkdir(exist_ok=True); preview_counts=Counter()
    def reject(entry,reason,payload,extra=None):
        summary['rejected'][reason]+=1
        rejection.write(json.dumps({'id':entry.get('id'),'reason':reason,**(extra or {})},ensure_ascii=False)+'\n')
        if preview_counts[reason] < 16:
            (preview/(reason+'-'+str(preview_counts[reason])+'.webp')).write_bytes(payload)
            preview_counts[reason]+=1
    with vision.FaceLandmarker.create_from_options(landmark_options) as detector, (args.out/'items.jsonl').open('w') as admitted, (args.out/'rejected.jsonl').open('w') as rejection:
        try:
            for entry,payload in rows:
                if args.limit and summary['scanned'] >= args.limit: break
                summary['scanned']+=1
                digest=hashlib.sha256(payload).hexdigest()
                if digest in known: reject(entry,'duplicate_pixels',payload); continue
                if not all(entry.get(k) for k in ('sourceUrl','creator','license')):
                    reject(entry,'missing_provenance',payload); continue
                try:
                    with Image.open(io.BytesIO(payload)) as opened: image=opened.convert('RGB')
                except (OSError,ValueError): reject(entry,'unreadable',payload); continue
                values=attributes(image); reason=visibility_reason(values)
                if reason: reject(entry,reason,payload,{'attributes':values}); continue
                result=detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB,data=np.ascontiguousarray(image)))
                if len(result.face_landmarks)!=1 or not result.face_blendshapes or not result.facial_transformation_matrixes:
                    reject(entry,'no_single_face',payload); continue
                points=result.face_landmarks[0]; feature=features(result)
                geometry=face_geometry(points)
                if geometry is None: reject(entry,'invalid_geometry',payload); continue
                layout=geometry[3]; cx,cy,w,h=layout
                if h*image.height < 60 or min(w,h)<=0:
                    reject(entry,'insufficient_face_pixels',payload); continue
                critical=(33,133,362,263,13,14,61,291,1)
                if any(not(.01 <= points[i].x <= .99 and .01 <= points[i].y <= .99) for i in critical):
                    reject(entry,'critical_region_truncated',payload); continue
                left=max(0,int((cx-w*.6)*image.width)); right=min(image.width,int(math.ceil((cx+w*.6)*image.width)))
                top=max(0,int((cy-h*.6)*image.height)); bottom=min(image.height,int(math.ceil((cy+h*.6)*image.height)))
                tight=attributes(image.crop((left,top,right,bottom)))
                reason=visibility_reason(tight)
                if reason: reject(entry,reason,payload,{'attributes':tight}); continue
                cell=pose_cell(feature)
                if cell is None or abs(feature[2]*90)>65: reject(entry,'pose_outside_supported_range',payload); continue
                yaw=feature[0]*90; previous_yaw=float(entry.get('feature',[feature[0]])[0])*90
                if args.kind=='seed' and opposite_pose(previous_yaw,yaw):
                    reject(entry,'yaw_contradiction',payload,{'storedYaw':previous_yaw,'freshYaw':yaw}); continue
                mirror_yaw=None
                if abs(yaw)>=12:
                    mirrored=detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB,data=np.ascontiguousarray(np.asarray(image)[:,::-1])))
                    if len(mirrored.face_landmarks)!=1 or not mirrored.facial_transformation_matrixes:
                        reject(entry,'pose_unstable_under_check',payload); continue
                    mirror_yaw=features(mirrored)[0]*90
                    if not mirror_consistent(yaw,mirror_yaw): reject(entry,'pose_unstable_under_check',payload); continue
                gray=cv2.cvtColor(np.asarray(image.crop((left,top,right,bottom)).resize((128,128))),cv2.COLOR_RGB2GRAY)
                sharpness=float(cv2.Laplacian(gray,cv2.CV_64F).var()); contrast=float(gray.std()); brightness=float(gray.mean())
                if sharpness<18 or contrast<15 or not(25<=brightness<=235):
                    reject(entry,'poor_visible_detail',payload); continue
                try:
                    shape,mesh,projection=[encode(list(x)) for x in geometry[:3]]
                except ValueError: reject(entry,'unencodable_geometry',payload); continue
                if pack is None or pack_bytes+len(payload)>7000000:
                    if pack: pack.close()
                    name=f'{args.kind}-{args.part}-{pack_index:03d}.bin'; pack_index+=1; pack_bytes=0
                    pack=(args.out/name).open('wb')
                offset=pack_bytes; pack.write(payload); pack_bytes+=len(payload)
                clean={k:v for k,v in entry.items() if k not in ('pack','offset','length','image','feature','shape','mesh','projection','layout','qualityV4')}
                clean.update({'pack':name,'offset':offset,'length':len(payload),'feature':feature,
                    'shape':shape,'mesh':mesh,'projection':projection,'layout':layout,
                    'qualityV4':{'policy':VERSION,'pixelSha256':digest,'attributes':values,'faceAttributes':tight,
                        'sourceKind':args.kind,'storedYaw':previous_yaw,'freshYaw':yaw,'mirrorYaw':mirror_yaw,
                        'sharpness':sharpness,'expression':expression_tag(feature),'cell':cell,'humanVerified':False}})
                admitted.write(json.dumps(clean,ensure_ascii=False,separators=(',',':'))+'\n'); known.add(digest)
                summary['accepted']+=1; summary['expressions'][expression_tag(feature)]+=1; summary['poseCells'][cell]+=1
                if summary['accepted']<=16: (preview/f'accepted-{summary["accepted"]}.webp').write_bytes(payload)
                if summary['scanned']%250==0:
                    print('CANDIDATE_PROGRESS '+json.dumps({k:summary[k] for k in ('kind','part','scanned','accepted')}),flush=True)
        finally:
            if pack: pack.close()
    summary['seconds']=round(time.monotonic()-start,2)
    (args.out/'receipt.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    print('CANDIDATE_RECEIPT '+json.dumps({**summary,'poseCells':len(summary['poseCells'])},ensure_ascii=False),flush=True)

if __name__=='__main__': main()
