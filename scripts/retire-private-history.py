"""One-time, bounded retirement authorized by the owner. No source media exports."""
import base64
import json
import os
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path.cwd()
CLEAN = ROOT / 'work' / 'retired-history.git'
REPORT = ROOT / 'work' / 'privacy-retirement.json'
PATHS = {
    'public/test-fixtures/reference-face-motion.mp4',
    'public/test-fixtures/reference-face-motion-analysis.json',
    'public/test-fixtures/reference-face-motion-rankings.json',
    'tests/fixtures/fixed-video-profile-20261015.json',
}
BLOBS = {'c4aecaa809cc9bf44f432b884b151c08450a2d13', '5ff5d73bac2ed48fafe6fee9bb4d349b1c7c7efd', 'dadf7703586b82a2ed491375f8eeba3f1b4f019d', '0d6a4d72b4efdd2aa40e1b6bdea11bdc0d68df09'}
# These workflows used the retired recording in source bundles, rendered builds,
# video benchmarks, or screenshots. Catalog-only and public-camera artifacts stay.
ARTIFACT_PREFIXES = (
    'fullscreen-development-source-', 'clean-core-v5-promoted-build-',
    'demo-composite-qa-', 'fullscreen-ui-evidence-', 'verification-recovery-',
    'video-speed-', 'video-history-', 'video-capture-speed-', 'video-rank-speed-',
    'wink-runtime-', 'published-site-v55-regression-',
    'clean-core-v5-qa-summary-', 'clean-core-v5-qa-reports-',
)

def git(*args, clean=False, env=None):
    return subprocess.check_output(['git', *args], cwd=CLEAN if clean else ROOT, env=env, text=True).strip()


def api(path, method='GET'):
    req = urllib.request.Request('https://api.github.com/repos/' + os.environ['GITHUB_REPOSITORY'] + path,
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json'}, method=method)
    with urllib.request.urlopen(req) as response:
        data = response.read()
        return json.loads(data) if data else None


def tree(sha, clean=False):
    return {line.split('\t', 1)[1]: line.split('\t', 1)[0] for line in git('ls-tree', '-r', sha, clean=clean).splitlines()}


ROOT.joinpath('work').mkdir(exist_ok=True)
refs = {}
for line in git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin/').splitlines():
    ref, sha = line.split()
    if ref.endswith('/HEAD'):
        continue
    refs['refs/heads/' + ref.removeprefix('refs/remotes/origin/')] = sha
assert len(refs) == 12, 'Unexpected branch inventory; stop for review'
assert refs['refs/heads/astra/realtime-hardening'] == os.environ['GITHUB_SHA']
assert not git('tag', '--list'), 'Unexpected tags; stop rather than omit refs'
old_trees = {ref: {p: v for p, v in tree(sha).items() if p not in PATHS} for ref, sha in refs.items()}
subprocess.run(['git', 'init', '--bare', str(CLEAN)], check=True, stdout=subprocess.DEVNULL)
git('fetch', '--no-tags', str(ROOT), '+refs/remotes/origin/*:refs/heads/*', clean=True)
args = ['filter-repo', '--sensitive-data-removal', '--no-fetch', '--invert-paths', '--replace-refs', 'delete-no-add', '--force']
for p in sorted(PATHS):
    args += ['--path', p]
git(*args, clean=True)
new_refs = {}
for line in git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/', clean=True).splitlines():
    ref, sha = line.split()
    new_refs[ref] = sha
assert set(new_refs) == set(refs)
for ref, sha in new_refs.items():
    assert tree(sha, clean=True) == old_trees[ref], 'Non-private file changed on ' + ref
objects = git('rev-list', '--objects', '--all', clean=True).splitlines()
assert not any(line.split(' ', 1)[0] in BLOBS for line in objects), 'Private blob still reachable'
assert not any(line.partition(' ')[2] in PATHS for line in objects), 'Private path still reachable'
result = {'removedPaths': sorted(PATHS), 'refs': [{'ref': r, 'old': refs[r], 'new': new_refs[r]} for r in refs],
          'allOtherHeadFilesUnchanged': True, 'privateBlobsReachable': False, 'pushed': False, 'deletedArtifacts': [],
          'limitations': ['GitHub cached SHA/PR views require provider purge', 'Existing third-party clones cannot be erased here', 'Sites historical versions require provider removal']}
REPORT.write_text(json.dumps(result, indent=2) + '\n')
# Atomic update: every branch is leased against its audited old head. Concurrent
# work aborts the whole push. No branch is deleted and no non-private file changes.
env = dict(os.environ)
env.update({'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'http.https://github.com/.extraheader',
            'GIT_CONFIG_VALUE_0': 'AUTHORIZATION: basic ' + base64.b64encode(('x-access-token:' + os.environ['GH_TOKEN']).encode()).decode()})
remote = 'https://github.com/' + os.environ['GITHUB_REPOSITORY'] + '.git'
args = ['push', '--atomic'] + ['--force-with-lease=' + r + ':' + refs[r] for r in refs] + [remote] + [new_refs[r] + ':' + r for r in refs]
git(*args, clean=True, env=env)
result['pushed'] = True
REPORT.write_text(json.dumps(result, indent=2) + '\n')
artifacts = {}
page = 1
while True:
    batch = api(f'/actions/artifacts?per_page=100&page={page}')['artifacts']
    for a in batch:
        artifacts[a['id']] = a
    if len(batch) < 100:
        break
    page += 1
for a in artifacts.values():
    if a['name'].startswith(ARTIFACT_PREFIXES) and not a['expired']:
        api('/actions/artifacts/' + str(a['id']), 'DELETE')
        result['deletedArtifacts'].append({'id': a['id'], 'name': a['name']})
        REPORT.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'pushed': result['pushed'], 'branches': len(refs), 'deletedArtifacts': len(result['deletedArtifacts'])}))
