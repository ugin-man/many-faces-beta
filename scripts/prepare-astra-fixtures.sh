#!/usr/bin/env bash
set -euo pipefail
mkdir -p work/astra-fixtures work/astra-evidence
if ! command -v ffmpeg >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends ffmpeg
fi
python - <<'PY'
import json
from pathlib import Path
root=Path('public/seed-catalog')
manifest=json.loads((root/'manifest.json').read_text())
chosen=[]
for n,target in enumerate([-18,0,18]):
    keys=sorted(manifest['cells'],key=lambda k:(float(k.split(':')[0])-target)**2+float(k.split(':')[1])**2)
    item=None
    for key in keys:
        cell=manifest['cells'][key]
        files=cell.get('shards') or ([cell['shard']] if cell.get('shard') else [])
        if not files: continue
        items=json.loads((root/'shards'/files[0]).read_text())['items']
        item=next((x for x in items if x.get('id') not in [v['id'] for v in chosen]),None)
        if item: break
    if item is None: raise SystemExit('No real-photo fixture found')
    if item.get('image'):
        data=(root/'images'/item['image']).read_bytes()
    else:
        with (root/'packs'/item['pack']).open('rb') as f:
            f.seek(item['offset']); data=f.read(item['length'])
    Path(f'work/astra-fixtures/face-{n}.webp').write_bytes(data)
    chosen.append({'id':item['id'],'cell':key,'source':item.get('sourceUrl'),'creator':item.get('creator')})
Path('work/astra-evidence/fixture-provenance.json').write_text(json.dumps({'type':'three-real-photographs-not-physical-camera','privateUserVideoUsed':False,'faces':chosen},indent=2)+'\n')
PY
for n in 0 1 2; do
  ffmpeg -hide_banner -loglevel error -y -loop 1 -i work/astra-fixtures/face-${n}.webp \
    -t 1 -r 30 -vf "scale=480:480:force_original_aspect_ratio=decrease,pad=480:480:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p" \
    -an -c:v libx264 -preset ultrafast work/astra-fixtures/part-${n}.mp4
done
printf "file 'part-0.mp4'\nfile 'part-1.mp4'\nfile 'part-2.mp4'\n" > work/astra-fixtures/parts.txt
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i work/astra-fixtures/parts.txt \
  -pix_fmt yuv420p -f yuv4mpegpipe work/astra-fixtures/moving.y4m
