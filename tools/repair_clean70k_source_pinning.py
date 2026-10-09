#!/usr/bin/env python3
"""Fail-closed, checkout-local repair for post-promotion Clean70k source drift.

Only edits .github/workflows/clean-core-v5-candidate.yml in a trusted, reviewed
checkout. It does not run GitHub Actions, push commits, alter assets or publish.
"""
from pathlib import Path
import sys

PATH = Path('.github/workflows/clean-core-v5-candidate.yml')
SOURCE_SHA = '8f209747dbf5edfd627707734ad01a19be43e897'


def replace_exact(document: str, before: str, after: str, count: int) -> str:
    n = document.count(before)
    if n != count:
        raise ValueError(f'Expected {count} occurrences; found {n}: {before[:100]!r}')
    return document.replace(before, after)


def main() -> int:
    if not PATH.is_file():
        raise SystemExit('Run from the repository root with .github/workflows/clean-core-v5-candidate.yml present')
    source = PATH.read_text(encoding='utf-8')
    if 'ORIGINAL_AUDIT_SOURCE_COMMIT' in source:
        raise SystemExit('Workflow already modified for source pinning; inspect manually before reapplying')
    result = replace_exact(
        source,
        '  FFHQ_SOURCE_COMMIT: 9d10fb37a825a5f90e5a3671a9564a1f1e9bef53\n',
        '  FFHQ_SOURCE_COMMIT: 9d10fb37a825a5f90e5a3671a9564a1f1e9bef53\n'
        f'  ORIGINAL_AUDIT_SOURCE_COMMIT: {SOURCE_SHA}\n',
        1,
    )
    before_checkout = (
        '          sparse-checkout: public/seed-catalog\n'
        '          persist-credentials: false\n'
        '      - uses: actions/setup-python@v5'
    )
    after_checkout = (
        '          sparse-checkout: public/seed-catalog\n'
        '          persist-credentials: false\n'
        '      - name: Check out immutable original admission sources before v55 promotion\n'
        '        uses: actions/checkout@v4\n'
        '        with:\n'
        '          ref: ${{ env.ORIGINAL_AUDIT_SOURCE_COMMIT }}\n'
        '          path: work/pinned-admission-original\n'
        '          fetch-depth: 1\n'
        '          sparse-checkout: |\n'
        '            public/seed-catalog\n'
        '            public/wink-support/v1\n'
        '          persist-credentials: false\n'
        '      - uses: actions/setup-python@v5'
    )
    result = replace_exact(result, before_checkout, after_checkout, 2)
    before_prepare = (
        '          test "$(git -C work/pinned-ffhq rev-parse HEAD)" = "$FFHQ_SOURCE_COMMIT"\n'
        '          mkdir -p work/source-catalogs work/catalog-quality work/models\n'
        '          mv work/pinned-ffhq/public/seed-catalog work/source-catalogs/ffhq-main\n'
        '          python tools/prepare_wink_candidates.py \\\n'
        '            --source public/wink-support/v1 \\\n'
        '            --out work/source-catalogs/wink-extras'
    )
    after_prepare = (
        '          test "$(git -C work/pinned-ffhq rev-parse HEAD)" = "$FFHQ_SOURCE_COMMIT"\n'
        '          test "$(git -C work/pinned-admission-original rev-parse HEAD)" = "$ORIGINAL_AUDIT_SOURCE_COMMIT"\n'
        '          mkdir -p work/source-catalogs work/catalog-quality work/models\n'
        '          mv work/pinned-ffhq/public/seed-catalog work/source-catalogs/ffhq-main\n'
        '          mv work/pinned-admission-original/public/seed-catalog work/source-catalogs/current\n'
        '          python tools/prepare_wink_candidates.py \\\n'
        '            --source work/pinned-admission-original/public/wink-support/v1 \\\n'
        '            --out work/source-catalogs/wink-extras'
    )
    result = replace_exact(result, before_prepare, after_prepare, 2)
    current_name = 'current=public/seed-catalog'
    instances = result.count(current_name)
    if instances < 5:
        raise ValueError(f'Expected at least five source references; found {instances}')
    result = result.replace(current_name, 'current=work/source-catalogs/current')
    result = replace_exact(result, "'current': 'public/seed-catalog'", "'current': 'work/source-catalogs/current'", 1)
    if 'current=public/seed-catalog' in result or '--source public/wink-support/v1' in result:
        raise ValueError('Unconverted source references remain')
    if result.count('work/pinned-admission-original') < 6:
        raise ValueError('Unexpectedly few original-input references')
    PATH.write_text(result, encoding='utf-8')
    print(f'Repaired {PATH} locally; changed {instances} current-source references.')
    print('Next: inspect git diff, commit, run CI; do not publish until independent QA passes.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
