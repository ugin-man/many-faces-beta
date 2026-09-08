# Archived one-time workflow patches

These two historical source-rewriting workflows contained multiline Python string literals outside their YAML `run` block indentation. GitHub was reporting failed workflow validations even on unrelated pushes. They are preserved here byte-for-byte, outside `.github/workflows`, so they no longer register as executable workflows on this branch.

- `patch-live-static-search.yml.disabled`: one-time replacement of the older responsive client.
- `promote-clean-core-v2-gate.yml.disabled`: one-time rewriting of the older catalog v2 launch gate.

The active source already contains the static-search helper import and the project has advanced to Clean Core v3. These archived files are historical records, not current setup steps. The existing `main` and `work/coverage-driven-200k` branches were not modified by this archival change.

The Astra workflow validates exact checked-out source with read-only repository permissions. It must not apply patches or push source changes while reporting that an earlier commit passed.
