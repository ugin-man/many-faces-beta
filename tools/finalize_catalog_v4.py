#!/usr/bin/env python3
"""Finalize an already physically repacked catalog; never introduce new images."""
from __future__ import annotations
import argparse, hashlib, html, json
from collections import Counter
from pathlib import Path
from catalog_v4_policy import VERSION, pose_cell, visibility_reason

STALE_LABELS={'cleanProfile','cleanGroup','cleanTier','cleanPolicy','cleanPurity','cleanScore'}
MAX_OBJECT=8*1024*1024

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('catalog',type=Path)
    parser.add_argument('--baseline',type=Path,default=Path('public/seed-catalog/manifest.json'))
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args(); root=args.catalog
    manifest=json.loads((root/'manifest.json').read_text()); before=manifest['catalogId']
    baseline=json.loads(args.baseline.read_text())
    if manifest['totalFaces']!=70000: raise ValueError('A complete physical 70k is required')
    if set(manifest['cells'])!=set(baseline['cells']): raise ValueError('Original pose coverage is not complete')
    fingerprint=hashlib.sha256(VERSION.encode()); seen=set(); pixels=set(); packs={}; sources=Counter()
    attributions=[]; removed_fields=Counter(); attributes_max=[0.,0.]
    for cell,metadata in sorted(manifest['cells'].items()):
        count=0
        for filename in metadata['shards']:
            source=root/'shards'/filename; payload=json.loads(source.read_text())
            if payload['cell']!=cell: raise ValueError('Shard cell mismatch')
            for entry in payload['items']:
                identity=entry['id']; quality=entry['qualityV4']
                if identity in seen or quality['pixelSha256'] in pixels: raise ValueError('Duplicate selected photo')
                if quality['policy']!=VERSION or visibility_reason(quality['attributes']) or visibility_reason(quality['faceAttributes']): raise ValueError('Unadmitted row')
                if pose_cell(entry['feature'])!=cell or quality['cell']!=cell: raise ValueError('Wrong pose bin')
                seen.add(identity); pixels.add(quality['pixelSha256']); count+=1
                for field in STALE_LABELS:
                    if field in entry: removed_fields[field]+=1; entry.pop(field)
                packs.setdefault(entry['pack'],[]).append((entry['offset'],entry['length'],quality['pixelSha256']))
                for i,index in enumerate((3,4)):
                    attributes_max[i]=max(attributes_max[i],quality['attributes'][index],quality['faceAttributes'][index])
                sources[entry['sourceUrl']]+=1
                attributions.append({key:entry.get(key,'') for key in ('id','name','creator','sourceUrl','license','licenseUrl','changes')})
            data=json.dumps(payload,ensure_ascii=False,separators=(',',':')).encode()
            if len(data)>MAX_OBJECT: raise ValueError('Shard exceeds API object budget')
            source.write_bytes(data); fingerprint.update(filename.encode()); fingerprint.update(b'\0'); fingerprint.update(data)
        if count!=metadata['count']: raise ValueError('Cell count mismatch')
    total_bytes=0
    for name,ranges in sorted(packs.items()):
        payload=(root/'packs'/name).read_bytes(); cursor=0
        if len(payload)>MAX_OBJECT: raise ValueError('Pack exceeds API object budget')
        for offset,length,digest in sorted(ranges):
            if offset!=cursor or length<=0: raise ValueError('Unreferenced or overlapping physical image bytes')
            image=payload[offset:offset+length]
            if hashlib.sha256(image).hexdigest()!=digest: raise ValueError('Image bytes do not match admitted pixels')
            if image[:4]!=b'RIFF' or image[8:12]!=b'WEBP': raise ValueError('Unexpected image encoding')
            cursor+=length
        if cursor!=len(payload): raise ValueError('Unused bytes remain in physical pack')
        total_bytes+=cursor
    if len(seen)!=70000 or len(pixels)!=70000: raise ValueError('Physical image count mismatch')
    catalog_id='many-faces-visible-v4-'+fingerprint.hexdigest()[:16]
    manifest['catalogId']=catalog_id
    manifest['sourceFaces']=manifest['totalFaces']=manifest['searchableFaces']=70000
    manifest.pop('outputSize',None)
    manifest['imageSizing']={'uniformDimensions':False,'originalAdmittedPixelsPreserved':True,'newPhotosMaxDimension':384}
    manifest['stats']['quality'].update({'revisionIncludesDescriptorData':True,'postSelectionExclusionList':False,
        'staleV3ExpressionLabelsRemoved':True,'physicalByteCoverageVerified':True,'humanVerified':False})
    (root/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')))
    (root/'attribution.json').write_text(json.dumps(attributions,ensure_ascii=False,separators=(',',':')))
    esc=lambda text:html.escape(str(text),quote=True)
    def link(url,label):
        return '<a href="'+esc(url)+'" rel="noopener noreferrer">'+esc(label)+'</a>' if str(url).startswith(('https://','http://')) else esc(label)
    rows=[]
    for a in attributions:
        rows.append('<article id="'+esc(a['id'])+'"><strong>'+esc(a['id'])+'</strong><p>'+esc(a['creator'])+' — '+link(a['sourceUrl'],'元画像')+'</p><p>'+link(a['licenseUrl'],a['license'])+'</p><small>'+esc(a['changes'] or '顔の切り出し・縮小。表示する写真そのものを解析して登録。')+'</small></article>')
    (root/'ATTRIBUTION.html').write_text('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Many Faces — 画像の出典</title><style>body{max-width:860px;margin:32px auto;padding:0 16px;font:14px/1.7 system-ui}article{border-bottom:1px solid #ddd;padding:14px 0;overflow-wrap:anywhere}</style><h1>画像の出典・利用条件</h1><p>自動検査を通過した実写真だけを収録したカタログです。各画像の元の利用条件が引き続き適用されます。人物による本アプリの推奨を意味するものではありません。</p>'+''.join(rows)+'</html>')
    report={'previousCandidateId':before,'catalogId':catalog_id,'physicalImages':70000,'physicalImageBytes':total_bytes,
        'poseCells':len(manifest['cells']),'unreferencedPackBytes':0,'overlappingPackRanges':0,'duplicatePixelHashes':0,
        'maximumAcceptedMaskScore':attributes_max[0],'maximumAcceptedSunglassesScore':attributes_max[1],
        'removedStaleLabelFields':dict(removed_fields),'uniqueSourceUrls':len(sources),
        'sourceUrlsWithMultipleCrops':sum(count>1 for count in sources.values()),
        'sourceUrlMultiplicityIsNotIdentityVerification':True,'humanVerified':False,'runtimeDeployed':False}
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print('PHYSICAL_CATALOG_FINALIZED '+json.dumps(report,ensure_ascii=False))

if __name__=='__main__': main()
