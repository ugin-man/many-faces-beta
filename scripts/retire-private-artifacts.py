"""Remove only previously audited artifacts made from the retired personal video."""
import json
import os
import urllib.request
from pathlib import Path

ARTIFACT_PREFIXES = (
    'fullscreen-development-source-', 'clean-core-v5-promoted-build-',
    'demo-composite-qa-', 'fullscreen-ui-evidence-', 'verification-recovery-',
    'video-speed-', 'video-history-', 'video-capture-speed-', 'video-rank-speed-',
    'wink-runtime-', 'published-site-v55-regression-',
    'clean-core-v5-qa-summary-', 'clean-core-v5-qa-reports-',
)

def api(path, method='GET'):
    req = urllib.request.Request('https://api.github.com/repos/' + os.environ['GITHUB_REPOSITORY'] + path,
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json'}, method=method)
    with urllib.request.urlopen(req) as response:
        data = response.read()
        return json.loads(data) if data else None

report = Path('work/private-artifact-retirement.json')
report.parent.mkdir(exist_ok=True)
artifacts = {}
page = 1
while True:
    batch = api(f'/actions/artifacts?per_page=100&page={page}')['artifacts']
    for artifact in batch:
        artifacts[artifact['id']] = artifact
    if len(batch) < 100:
        break
    page += 1
result = {'deletedArtifacts': [], 'remainingMatchingArtifacts': None}
for artifact in artifacts.values():
    if artifact['name'].startswith(ARTIFACT_PREFIXES) and not artifact['expired']:
        api('/actions/artifacts/' + str(artifact['id']), 'DELETE')
        result['deletedArtifacts'].append({'id': artifact['id'], 'name': artifact['name']})
        report.write_text(json.dumps(result, indent=2) + '\n')
remaining = []
page = 1
while True:
    batch = api(f'/actions/artifacts?per_page=100&page={page}')['artifacts']
    remaining += [a['id'] for a in batch if a['name'].startswith(ARTIFACT_PREFIXES) and not a['expired']]
    if len(batch) < 100:
        break
    page += 1
result['remainingMatchingArtifacts'] = remaining
report.write_text(json.dumps(result, indent=2) + '\n')
assert not remaining
print(json.dumps({'deletedArtifacts': len(result['deletedArtifacts']), 'remainingMatchingArtifacts': len(remaining)}))
