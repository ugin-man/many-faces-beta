#!/usr/bin/env python3
"""Create reproducible exact-image contact sheets for an unreviewed audit.

This script only prepares evidence; its samples are never an admission list.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import random
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--catalog', type=Path, default=Path('public/seed-catalog'))
    parser.add_argument('--audit-dir', type=Path, default=Path('work/catalog-quality/existing'))
    parser.add_argument('--merged', type=Path, default=Path('work/catalog-quality/merged-evidence.json'))
    parser.add_argument('--out', type=Path, default=Path('work/catalog-quality/review'))
    args = parser.parse_args()
    if not args.merged.is_file():
        parser.error('complete merged audit evidence is required before visual review')
    manifest = json.loads((args.catalog / 'manifest.json').read_text())
    names = sorted({name for cell in manifest['cells'].values()
                    for name in cell.get('shards', [cell.get('shard')]) if name})
    entries = {}
    for name in names:
        for entry in json.loads((args.catalog / 'shards' / name).read_text())['items']:
            if entry['id'] in entries:
                raise ValueError('duplicate catalog ID')
            entries[entry['id']] = entry
    audit = json.loads((args.audit_dir / 'occlusion.json').read_text())
    scores = {row['id']: row for row in audit['review90']}
    flagged = {row['id']: row for row in audit['excluded']}
    generator = random.Random(20261006)
    selected = set()
    samples = []

    def add(category, rows, count):
        rows = sorted((row for row in rows if row['id'] not in selected), key=lambda row: row['id'])
        if len(rows) > count:
            rows = generator.sample(rows, count)
        for row in rows:
            selected.add(row['id'])
            samples.append({'sample': f'Q{len(samples) + 1:03d}', 'stratum': category,
                            'id': row['id'], 'name': entries[row['id']].get('name', ''),
                            'storedYaw': entries[row['id']]['feature'][0] * 90,
                            'scores': scores.get(row['id']), 'priorFlag': flagged.get(row['id'])})

    for reason, key in [('sunglasses', 'sunglasses'), ('face_mask', 'mask')]:
        for low, high in [(.94, .99), (.99, .999), (.999, 1.000001)]:
            rows = [row for row in flagged.values() if row['reason'] == reason
                    and low <= row.get(key, -1) < high]
            add(f'{reason}:{low}-{high}', rows, 16)
    add('paint-title-challenge', [entry for entry in entries.values()
        if re.search(r'face.?paint|face.?painting|painted face', str(entry.get('name', '')), re.I)], 24)
    add('eyeglasses-title-challenge', [entry for entry in entries.values()
        if re.search(r'\bglasses\b|eyeglasses|spectacles', str(entry.get('name', '')), re.I)
        and not re.search(r'sunglasses|sun glasses|dark glasses', str(entry.get('name', '')), re.I)], 24)
    add('below-prior-flag-review90', [row for row in scores.values() if row['id'] not in flagged], 24)
    add('unflagged-random-control', [entry for entry in entries.values() if entry['id'] not in flagged], 36)
    args.out.mkdir(parents=True, exist_ok=True)
    handles = {}
    font = ImageFont.truetype('DejaVuSans.ttf', 12)
    try:
        for page in range(math.ceil(len(samples) / 36)):
            sheet = Image.new('RGB', (6 * 192, 6 * 240), '#f3f2f0')
            draw = ImageDraw.Draw(sheet)
            for index, sample in enumerate(samples[page * 36: (page + 1) * 36]):
                entry = entries[sample['id']]
                if entry.get('image'):
                    payload = (args.catalog / 'images' / entry['image']).read_bytes()
                else:
                    name = entry['pack']
                    if name not in handles:
                        handles[name] = (args.catalog / 'packs' / name).open('rb')
                    handle = handles[name]
                    handle.seek(entry['offset'])
                    payload = handle.read(entry['length'])
                    if len(payload) != entry['length']:
                        raise ValueError('truncated packed photograph')
                with Image.open(io.BytesIO(payload)) as source:
                    image = ImageOps.contain(ImageOps.exif_transpose(source).convert('RGB'), (188, 188))
                x, y = (index % 6) * 192, (index // 6) * 240
                sheet.paste(image, (x + (192 - image.width) // 2, y + (192 - image.height) // 2))
                values = sample['scores'] or {}
                text = f"{sample['sample']} yaw {sample['storedYaw']:+.0f}  "
                text += f"m{values.get('mask', -1):.3f} s{values.get('sunglasses', -1):.3f}"
                draw.text((x + 2, y + 193), text, font=font, fill='black')
                draw.text((x + 2, y + 207), sample['stratum'][:27], font=font, fill='black')
                draw.text((x + 2, y + 222), sample['name'][:26], font=font, fill='black')
                (args.out / (sample['sample'] + '.webp')).write_bytes(payload)
            sheet.save(args.out / f'contact-{page + 1:02d}.jpg', quality=95)
    finally:
        for handle in handles.values():
            handle.close()
    report = {'randomSeed': 20261006, 'catalogId': manifest['catalogId'],
              'sampling': 'stratified and challenge samples; not a prevalence estimate',
              'scoresAreCalibratedProbabilities': False, 'humanReviewComplete': False,
              'samples': samples}
    (args.out / 'sample-index.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'samples': len(samples), 'sheets': math.ceil(len(samples) / 36), 'out': str(args.out)}))


if __name__ == '__main__':
    main()
