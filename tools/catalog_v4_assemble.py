#!/usr/bin/env python3
"""Build physical packs from admitted images only; never pad a failed quota."""
from __future__ import annotations
import argparse, hashlib, io, json, math, shutil, time
from collections import Counter, defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps
from catalog_v4_policy import VERSION, expression_tag, pose_cell, visibility_reason


def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--inputs',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True); parser.add_argument('--baseline',type=Path,default=Path('public/seed-catalog/manifest.json'))
    args=parser.parse_args(); args.out.mkdir(parents=True,exist_ok=True)
    receipts=[]; candidates=[]; known_pixels=set(); duplicates=0
    files=sorted(args.inputs.rglob('items.jsonl'))
    for file in files:
        receipt=json.loads((file.parent/'receipt.json').read_text())
        receipts.append(receipt)
        counted=0
        for line in file.open():
            entry=json.loads(line); counted+=1; q=entry['qualityV4']
            if q['policy'] != VERSION or visibility_reason(q['attributes']) or visibility_reason(q['faceAttributes']):
                raise ValueError('Non-admitted candidate in staging pack')
            if pose_cell(entry['feature']) != q['cell']: raise ValueError('Pose cell contradicts exact-pixel analysis')
            pixel=q['pixelSha256']
            if pixel in known_pixels: duplicates+=1; continue
            known_pixels.add(pixel); entry['_root']=str(file.parent); candidates.append(entry)
        if counted != receipt['accepted']: raise ValueError('Candidate receipt count mismatch')
    partitions={(r['kind'],r['part']) for r in receipts}
    expected={(kind,i) for kind in ('seed','source') for i in range(4)}
    if partitions != expected: raise ValueError(f'Missing/duplicate partitions: {expected-partitions}')
    if sum(r['scanned'] for r in receipts if r['kind']=='seed') != 70000: raise ValueError('Did not re-evaluate all original 70k')
    models={(r['attributeModelSha256'],r['faceModelSha256']) for r in receipts}
    if len(models)!=1: raise ValueError('Candidate parts used different models')
    rejected=Counter()
    for receipt in receipts: rejected.update(receipt['rejected'])
    baseline=json.loads(args.baseline.read_text()); original_cells=set(baseline['cells'])
    summary={'schemaVersion':1,'policy':VERSION,'inputReceipts':receipts,'admittedUniqueCandidates':len(candidates),
        'deduplicatedPixelCopies':duplicates,'rejections':dict(rejected),'targetFaces':70000,
        'humanVerified':False,'runtimePromoted':False,'runtimeCodeChanged':False,'candidateArtifactBuilt':False}
    if len(candidates)<70000:
        summary['shortfall']=70000-len(candidates)
        (args.out/'receipt.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
        print('ASSEMBLY_INCOMPLETE '+json.dumps({k:v for k,v in summary.items() if k!='inputReceipts'}),flush=True)
        raise SystemExit(2)
    def score(entry):
        q=entry['qualityV4']
        visibility=1-max(q['attributes'][3:5]+q['faceAttributes'][3:5])
        return visibility + min(1,math.log1p(q['sharpness'])/math.log1p(800))*.2 + (0.03 if q['sourceKind']=='seed' else 0)
    groups=defaultdict(list)
    for entry in candidates: groups[(pose_cell(entry['feature']),expression_tag(entry['feature']))].append(entry)
    for key in groups: groups[key]=deque(sorted(groups[key],key=lambda e:(-score(e),e['id'])))
    # Uniform rounds across pose/expression combinations, not a frontal count fill.
    def priority(key):
        cell,expr=key; yaw,pitch=map(int,cell.split(':'))
        return (0 if 'wink' in expr else 1, abs(yaw)+abs(pitch),yaw,pitch,expr)
    keys=sorted(groups,key=priority); selected=[]; selected_ids=set(); used=Counter()
    while len(selected)<70000:
        added=0
        for key in keys:
            queue=groups[key]
            while queue and queue[0]['id'] in selected_ids: queue.popleft()
            if not queue: continue
            entry=queue.popleft(); selected.append(entry); selected_ids.add(entry['id']); used[key]+=1; added+=1
            if len(selected)==70000: break
        if not added: raise ValueError('Insufficient distinct IDs after deduplication')
    cells=defaultdict(list)
    for entry in selected: cells[pose_cell(entry['feature'])].append(entry)
    missing=sorted(original_cells-set(cells))
    catalog=args.out/'catalog'; packs=catalog/'packs'; shards=catalog/'shards'
    packs.mkdir(parents=True); shards.mkdir(parents=True)
    manifest_cells={}; all_hashes=[]; photos=Counter(); exprs=Counter(); input_handles={}
    chosen_images=[]; preview_keys=set()
    try:
        for cell,entries in sorted(cells.items(),key=lambda p:tuple(map(int,p[0].split(':')))):
            yaw,pitch=map(int,cell.split(':'))
            token=lambda x: ('p' if x>=0 else 'n')+f'{abs(x):03d}'
            stem=f'clean_v4_yaw_{token(yaw)}_pitch_{token(pitch)}'
            pack_name=stem+'.bin'; rows=[]; offset=0
            with (packs/pack_name).open('wb') as pack:
                for entry in entries:
                    source=Path(entry['_root'])/entry['pack']
                    if source not in input_handles: input_handles[source]=source.open('rb')
                    handle=input_handles[source]; handle.seek(entry['offset']); payload=handle.read(entry['length'])
                    digest=hashlib.sha256(payload).hexdigest()
                    if digest!=entry['qualityV4']['pixelSha256']: raise ValueError('Selected bytes differ from tested pixels')
                    pack.write(payload)
                    clean={k:v for k,v in entry.items() if k not in ('_root','pack','offset','length')}
                    clean.update({'pack':pack_name,'offset':offset,'length':len(payload)}); offset+=len(payload); rows.append(clean)
                    all_hashes.append(digest); photos[entry['qualityV4']['sourceKind']]+=1
                    expr=expression_tag(entry['feature']); exprs[expr]+=1
                    preview_key=(int(yaw/15),int(pitch/15),expr)
                    if preview_key not in preview_keys and len(chosen_images)<320:
                        chosen_images.append((entry['id'],yaw,pitch,expr,payload)); preview_keys.add(preview_key)
            names=[]
            for start in range(0,len(rows),512):
                filename=f'{stem}_{start//512:03d}.json'; names.append(filename)
                (shards/filename).write_text(json.dumps({'cell':cell,'items':rows[start:start+512]},ensure_ascii=False,separators=(',',':')))
            manifest_cells[cell]={'count':len(rows),'shards':names}
            if (packs/pack_name).stat().st_size!=sum(row['length'] for row in rows): raise ValueError('Unexpected bytes in physical pack')
    finally:
        for handle in input_handles.values(): handle.close()
    if len(all_hashes)!=70000 or len(set(all_hashes))!=70000: raise ValueError('Final physical count or duplicate mismatch')
    catalog_id='many-faces-visible-v4-'+hashlib.sha256(''.join(sorted(all_hashes)).encode()).hexdigest()[:16]
    manifest={k:v for k,v in baseline.items() if k not in ('cells','stats','catalogId','generatedAt','totalFaces','searchableFaces','indexFiles')}
    manifest.update({'catalogId':catalog_id,'generatedAt':datetime.now(timezone.utc).isoformat(),'totalFaces':70000,'searchableFaces':70000,
        'schemaVersion':3,'featureLength':55,'poseStep':3,'shardsContainGeometry':True,'shapeVersion':'mediapipe-projection-468-v4',
        'cells':manifest_cells,'stats':{'cleanCore':{'policyVersion':VERSION,'selectedFaces':70000,'runtimeImagePolicy':'real-photo-only-v1',
            'knownSyntheticFaces':0,'gatePassed':not missing,'sourceKindCounts':dict(photos),'expressionCombinations':dict(exprs)},
            'poseCells':len(cells),'packCount':len(cells),'shardCount':sum(len(x['shards']) for x in manifest_cells.values()),
            'quality':{'policy':VERSION,'exactEncodedPixelsChecked':70000,'postSelectionExclusionList':False,
                'allSelectedPassedAutomaticAdmission':True,'humanVerified':False,'missingOriginalPoseCells':missing,
                'attributeModelSha256':next(iter(models))[0],'faceModelSha256':next(iter(models))[1]}}})
    (catalog/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')))
    previews=args.out/'previews'; previews.mkdir(exist_ok=True)
    for start in range(0,len(chosen_images),40):
        subset=chosen_images[start:start+40]; sheet=Image.new('RGB',(8*144,5*176),'white'); draw=ImageDraw.Draw(sheet)
        for i,(identity,yaw,pitch,expr,payload) in enumerate(subset):
            with Image.open(io.BytesIO(payload)) as photo: tile=ImageOps.contain(photo.convert('RGB'),(144,144))
            x,y=(i%8)*144,(i//8)*176; sheet.paste(tile,(x+(144-tile.width)//2,y))
            draw.text((x+2,y+145),identity[-14:],fill='black'); draw.text((x+2,y+158),f'{yaw:+d},{pitch:+d} '+expr[:10],fill='black')
        sheet.save(previews/f'candidate-{start//40:02d}.jpg',quality=90)
    summary.update({'candidateArtifactBuilt':True,'catalogId':catalog_id,'physicalFaces':70000,'selectedSources':dict(photos),
        'selectedExpressions':dict(exprs),'poseCells':len(cells),'missingOriginalPoseCells':missing,
        'allSelectedPassedAutomaticAdmission':True,'readyForRuntime':False,
        'pending':['Independent visual QA','Wink-index rebuild against new packs','Full application regression with new catalog']})
    (args.out/'receipt.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    print('ASSEMBLY_RECEIPT '+json.dumps({k:v for k,v in summary.items() if k!='inputReceipts'},ensure_ascii=False),flush=True)

if __name__=='__main__': main()
