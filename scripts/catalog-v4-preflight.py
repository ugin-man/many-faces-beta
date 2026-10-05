#!/usr/bin/env python3
"""Recover reproducible inputs and repair the known newline defect, not the app."""
from __future__ import annotations
import ast, hashlib, io, json, os, subprocess, urllib.request, zipfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data/catalog-v4/preflight'
REPO = 'ugin-man/many-faces-beta'
AUDIT_RUN = 37363088388
SOURCE_RUN = 32559210408

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def api(path: str):
    request = urllib.request.Request('https://api.github.com/repos/' + REPO + '/' + path,
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)

def archive(artifact):
    request = urllib.request.Request(artifact['archive_download_url'],
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN']})
    try:
        response = urllib.request.build_opener(NoRedirect).open(request, timeout=60)
    except urllib.error.HTTPError as error:
        if error.code not in (301,302,303,307,308): raise
        # Signed object URLs do not receive the GitHub authorization header.
        response = urllib.request.urlopen(error.headers['Location'], timeout=120)
    with response:
        payload = response.read()
    expected = artifact.get('digest')
    digest = hashlib.sha256(payload).hexdigest()
    if expected and expected != 'sha256:' + digest:
        raise ValueError('Artifact digest mismatch: ' + artifact['name'])
    return zipfile.ZipFile(io.BytesIO(payload)), digest

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    builder = ROOT / 'tools/build_clean_core_v3.py'
    original = builder.read_text()
    bad = chr(92) + 'n    if not args.quality_exclusions.is_file()'
    fixed = original.replace(bad, '\n    if not args.quality_exclusions.is_file()')
    ast.parse(fixed)
    if len(fixed.splitlines()) < 450 or 'def main()' not in fixed:
        raise ValueError('Refusing a truncated builder')
    builder.write_text(fixed)
    from packaging.requirements import Requirement
    requirements = ROOT / 'tools/requirements-catalog.txt'
    for line in requirements.read_text().splitlines():
        if line.strip() and not line.startswith('#'): Requirement(line)
    old_sources = api(f'actions/runs/{SOURCE_RUN}/artifacts?per_page=100')['artifacts']
    audit_assets = api(f'actions/runs/{AUDIT_RUN}/artifacts?per_page=100')['artifacts']
    records, receipts = {}, []
    for artifact in sorted(audit_assets, key=lambda a:a['created_at']):
        if artifact.get('expired'): continue
        if not artifact['name'].startswith(('catalog-yaw-', 'catalog-occlusion-')): continue
        z, digest = archive(artifact)
        for filename in z.namelist():
            base = Path(filename).name
            if base == 'occlusion.json' or (base.startswith('yaw-') and base.endswith('.json')):
                value = json.loads(z.read(filename))
                records[base] = value
                (OUT / base).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')))
        receipts.append({'id':artifact['id'], 'name':artifact['name'], 'sha256':digest})
    occlusion = records.get('occlusion.json', {})
    yaw = [value for name,value in records.items() if name.startswith('yaw-')]
    summary = {
        'schemaVersion':1, 'baseCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
        'builderNewlineRepaired':original != fixed, 'builderParses':True,
        'legacySourceRun':SOURCE_RUN, 'availableLegacySourceArtifacts':len([a for a in old_sources if not a.get('expired')]),
        'auditRun':AUDIT_RUN, 'recoveredArtifacts':receipts,
        'occlusionScreened':occlusion.get('catalogFaces'),
        'occlusionFlags':dict(Counter(row.get('reason') for row in occlusion.get('excluded',[]))),
        'completedYawParts':sorted(name for name in records if name.startswith('yaw-')),
        'yawSamples':sum(value.get('samples',0) for value in yaw),
        'yawContradictions':sum(len(value.get('contradictions',[])) for value in yaw),
        'flagsAreHumanVerified':False, 'newCatalogBuilt':False, 'runtimeAssetsChanged':False,
    }
    (OUT / 'receipt.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2)+'\n')
    print('PREFLIGHT_RECEIPT '+json.dumps(summary,ensure_ascii=False),flush=True)

if __name__ == '__main__': main()
