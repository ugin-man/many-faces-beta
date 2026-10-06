import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {admittedCoreWink, boundedWinkIndex} from '../scripts/rebuild-clean-wink-support.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = await readFile(new URL('../.github/workflows/clean-core-v5-promote.yml', import.meta.url), 'utf8');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const policySha256 = 'a'.repeat(64), receiptSha256 = 'b'.repeat(64), recordsSha256 = 'c'.repeat(64);
const pilot = JSON.parse(await readFile(new URL('../data/wink-pilot/catalog.json', import.meta.url)));

// These retained photographs exercise serialization only. This fixture does not
// admit them into a catalog or override the independent image-quality denials.
const originals = await Promise.all(['left', 'right'].map(async side => {
  const original = pilot.items.find(row => row.side === side);
  const bytes = await readFile(new URL('../data/wink-pilot/images/' + original.image, import.meta.url));
  return {side, original, bytes, encodedSha256: sha256(bytes)};
}));
const reviewText = JSON.stringify({
  schemaVersion: 1, documentKind: 'clean-core-wink-expression-review', mode: 'confirmed-side-only',
  candidateAuditSha256: receiptSha256, recordsSha256,
  reviewer: 'assistant-visual-review', humanVerified: false, reviewedOn: '2026-10-06',
  reviews: originals.map(({side, encodedSha256}) => ({encodedSha256, decision: 'confirmed', side,
    reason: 'Retained original-pixel fixture for the serializer/promotion contract.'})),
});
const reviewSha256 = sha256(reviewText);
const winkReview = {sha256: reviewSha256, stamp: {reviewSha256},
  sides: new Map(originals.map(({side, encodedSha256}) => [encodedSha256, side]))};

function generatedFixture(cleanTier = 'observed') {
  const core = originals.map(({side, original, bytes, encodedSha256}) => {
    const entry = {...original, id: 'clean-v5-' + encodedSha256.slice(0, 28),
      pack: 'final.bin', offset: 0, length: bytes.length,
      admissionSha256: encodedSha256, admissionPolicySha256: policySha256,
      cleanProfile: side === 'left' ? 'winkLeft' : 'winkRight', cleanTier,
      winkExpressionEvidence: {schemaVersion: 1, encodedSha256, side, reviewSha256}};
    delete entry.image;
    return entry;
  });
  const items = core.map((entry, index) => admittedCoreWink(entry, originals[index].bytes, policySha256, winkReview));
  const header = {schemaVersion: 3, baseCatalogId: 'serializer-contract-fixture',
    baseCatalogManifestSha256: 'd'.repeat(64), policySha256,
    winkExpressionReviewSha256: reviewSha256, originalFaces: 70000, addedPhotographs: 0};
  // Cross the actual JSON boundary: the runtime parser's derived supportSide
  // field must not be available to the promotion workflow's raw-file checks.
  return {core, wink: JSON.parse(JSON.stringify(boundedWinkIndex(items, header)))};
}

const observed = generatedFixture(), strict = generatedFixture('strict');
for (const row of [...observed.wink.items, ...strict.wink.items]) {
  assert(['left', 'right'].includes(row.side));
  assert.equal(Object.hasOwn(row, 'supportSide'), false);
}

const cases = [];
function add(name, mutate = () => {}, accepted = false, fixture = observed) {
  const value = structuredClone(fixture);
  mutate(value.wink, value.core);
  cases.push({name, ...value, accepted});
}
add('promotion accepts serialized generator output for both observed sides', undefined, true);
add('promotion accepts serialized generator output for both strict sides', undefined, true, strict);
add('promotion rejects an opposite raw left-wink side', wink => {wink.items.find(row => row.side === 'left').side = 'right';});
add('promotion rejects an opposite raw right-wink side', wink => {wink.items.find(row => row.side === 'right').side = 'left';});
add('promotion rejects a missing serialized side', wink => {delete wink.items[0].side;});
add('promotion rejects supportSide-only runtime metadata', wink => {
  for (const row of wink.items) {row.supportSide = row.side; delete row.side;}
});
add('promotion rejects a wrong side even with a matching supportSide', wink => {
  for (const row of wink.items) {
    row.supportSide = row.side;
    row.side = row.side === 'left' ? 'right' : 'left';
  }
});
add('promotion rejects an absent core identity', wink => {wink.items[0].id = 'clean-v5-unavailable';});
add('promotion rejects a repeated core identity', wink => {wink.items.push(wink.items[0]);});
add('promotion rejects separate photo assets', wink => {wink.items[0].image = 'external.webp';});
add('promotion rejects an addition instead of a bound core row', wink => {wink.items[0].supportKind = 'addition';});
add('promotion rejects a changed packed-photo address', wink => {wink.items[0].offset += 1;});
add('promotion rejects a changed image digest', wink => {wink.items[0].imageSha256 = 'f'.repeat(64);});
add('promotion rejects a changed expression profile', wink => {wink.items[0].cleanProfile = 'backgroundEyes';});
add('promotion rejects a changed expression tier', wink => {wink.items[0].cleanTier = 'background';});
add('promotion rejects missing reviewed expression evidence', wink => {delete wink.items[0].winkExpressionEvidence;});
add('promotion rejects a different review file even if the core repeats it', (wink, core) => {
  const row = wink.items[0], changed = {...row.winkExpressionEvidence, reviewSha256: 'f'.repeat(64)};
  row.winkExpressionEvidence = changed;
  core.find(entry => entry.id === row.id).winkExpressionEvidence = changed;
});

// Execute the workflow's own AST nodes, including its actual core-reference
// projection and raw wink loop. This never executes artifact download, staging,
// Git, inference or deployment statements, and does not duplicate the validator.
const python = String.raw`
import ast
import json
from pathlib import Path
import re
import sys
import tempfile
import textwrap

sys.path.insert(0, str(Path('tools').resolve()))
from clean_core_selection_review import WinkExpressionReview

payload = json.load(sys.stdin)
blocks = re.findall(r"(?ms)^ {10}python - <<'PY'\n(.*?)^ {10}PY$", payload['workflow'])
matches = []
for block in blocks:
    tree = ast.parse(textwrap.dedent(block))
    loops = [node for node in tree.body if isinstance(node, ast.For)
             and isinstance(node.iter, ast.Call) and isinstance(node.iter.func, ast.Attribute)
             and isinstance(node.iter.func.value, ast.Name) and node.iter.func.value.id == 'wink'
             and node.iter.func.attr == 'get']
    if loops:
        assert len(loops) == 1
        matches.append((tree, loops[0]))
assert len(matches) == 1, 'Expected exactly one production raw-index validation loop'
tree, wink_loop = matches[0]

def single(nodes, label):
    assert len(nodes) == 1, 'Expected exactly one production ' + label
    return nodes[0]

require_node = single([node for node in tree.body if isinstance(node, ast.FunctionDef)
                       and node.name == 'require'], 'require function')
side_node = single([node for node in tree.body if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == 'wink_sides'
                            for target in node.targets)], 'side mapping')
reference_node = single([node for node in ast.walk(tree) if isinstance(node, ast.Assign)
                         and any(isinstance(target, ast.Subscript)
                                 and isinstance(target.value, ast.Name) and target.value.id == 'references'
                                 for target in node.targets)], 'physical core reference projection')
ids_node = single([node for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'wink_ids'
                           for target in node.targets)], 'specialist ID set')

def compiled(nodes):
    return compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])),
                   '.github/workflows/clean-core-v5-promote.yml', 'exec')

setup = compiled([require_node, side_node, ids_node])
project = compiled([reference_node])
validate = compiled([wink_loop])
results = []
with tempfile.TemporaryDirectory(prefix='promotion-wink-contract-') as directory:
    review_path = Path(directory) / 'review.json'
    review_path.write_text(payload['reviewText'], encoding='utf-8')
    review = WinkExpressionReview(review_path, payload['receiptSha256'], payload['recordsSha256'])
    for case in payload['cases']:
        scope = {'references': {}, 'wink_review': review, 'wink': case['wink']}
        exec(setup, scope)
        for entry in case['core']:
            scope.update(entry=entry, identity=entry['id'])
            exec(project, scope)
        try:
            exec(validate, scope)
            results.append({'name': case['name'], 'accepted': True,
                            'count': len(scope['wink_ids'])})
        except (ValueError, KeyError, AssertionError) as error:
            results.append({'name': case['name'], 'accepted': False, 'error': str(error)})
print(json.dumps(results))
`;
const execution = spawnSync('python3', ['-c', python], {
  cwd: root, input: JSON.stringify({workflow, reviewText, receiptSha256, recordsSha256, cases}),
  encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
});
assert.equal(execution.status, 0, execution.stderr || execution.error?.message);
const results = JSON.parse(execution.stdout);
assert.equal(results.length, cases.length);
for (const [index, expected] of cases.entries()) {
  test(expected.name, () => {
    const actual = results[index];
    assert.equal(actual.name, expected.name);
    assert.equal(actual.accepted, expected.accepted, actual.error || 'Unexpected acceptance');
    if (expected.accepted) assert.equal(actual.count, expected.wink.items.length);
  });
}
