"""Read-only inventory. No media, face geometry or credentials enter the report."""
import json
import os
import re
import subprocess
import urllib.request
from pathlib import Path


def git(*args):
    return subprocess.check_output(['git', *args], text=True)


def sensitive(path):
    return bool(re.search(r'(reference-face-motion|IMG_3665|fixed-video-profile)', path, re.I))


objects = []
media = []
for line in git('rev-list', '--objects', '--all').splitlines():
    sha, _, path = line.partition(' ')
    if sensitive(path):
        objects.append({'sha': sha, 'path': path})
    if re.search(r'\.(mp4|mov|webm|zip|tar|tgz|gz|png|jpe?g)$', path, re.I) and not re.search(r'(seed-catalog|wink-support|catalog|faces|dataset)', path):
        media.append({'sha': sha, 'path': path})

refs = []
for line in git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin/').splitlines():
    ref, sha = line.split()
    paths = [p for p in git('ls-tree', '-r', '--name-only', sha).splitlines() if sensitive(p)]
    refs.append({'ref': ref, 'sha': sha, 'paths': paths})

artifacts = []
page = 1
while True:
    req = urllib.request.Request(f'https://api.github.com/repos/{os.environ["GITHUB_REPOSITORY"]}/actions/artifacts?per_page=100&page={page}', headers={'Authorization': f'Bearer {os.environ["GH_TOKEN"]}', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(req) as response:
        batch = json.load(response)['artifacts']
    artifacts.extend({k: a.get(k) for k in ['id', 'name', 'expired', 'created_at', 'size_in_bytes', 'workflow_run']} for a in batch)
    if len(batch) < 100:
        break
    page += 1

Path('work').mkdir(exist_ok=True)
Path('work/privacy-inventory.json').write_text(json.dumps({'refs': refs, 'sensitiveObjects': objects, 'otherMedia': media, 'artifacts': artifacts}, indent=2) + '\n')
print(json.dumps({'refs': len(refs), 'sensitiveObjects': len(objects), 'otherMedia': len(media), 'artifacts': len(artifacts)}))
