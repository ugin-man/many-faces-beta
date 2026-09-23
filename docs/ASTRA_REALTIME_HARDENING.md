# Many Faces realtime handoff — 2026-09-24 JST

## Canonical target

Repository: `ugin-man/many-faces-beta`. Branch: `astra/realtime-hardening`. Draft PR #3 targets `work/coverage-driven-200k`; base/main are not merged by this work.

Keep the existing full 70,000-image catalog. Realtime review is `/live/astra` in the existing ChatGPT Work Site flow; `/live` is the fixed-video reference. Do not create a reduced catalog or alternate portable application. No hosted Site deployment or new ZIP was performed in this input-repair pass.

## Current user-facing repair

Read [ASTRA_INPUT_RECOVERY.md](ASTRA_INPUT_RECOVERY.md) first. It supersedes earlier input/orientation assumptions and records exact reproduction cases, executed checks and limitations.

The input implementation completed specialized browser verification at `5f0a0b136f9d5a5898608f75aa3d4ad7849438b1`. The subsequent CSS-only revision `99548fe830adfa81d0dc6d01947684926ed2dd77` passed repository CI and full-catalog realtime browser verification, including the 390x844 viewport. Its JavaScript is identical to the specialized-tested revision. Later documentation updates do not change that application.

The screen marker is **INPUT RECOVERY V1** and diagnostic build is `input-recovery-v1`. The old ZIP built from `8eb47b7d...` does not contain these repairs. Updating Git does not update a previously downloaded package or an already built Site: rebuild the Site from this branch and confirm the marker before reporting results.

### Changes

The browser had read MediaPipe's packed transformation matrix with Python row-major offsets. A shared catalog-pose helper now translates the Web column-major representation. On 18 real catalog photographs, yaw-sign agreement with stored catalog values changed from 0/18 to 18/18. This is a yaw convention check, not a guarantee of all pose components or final matching quality.

Camera/video analysis now uses original unmirrored pixels. Camera mirror presentation affects BOTH panes; video defaults to original orientation. A checkbox changes presentation only.

Fixed-video acquisition is atomic: callback registration precedes seeking, followed by actual decoded-frame readback with position/source/readiness checks. Already displayed paused frames no longer require a nonexistent future callback. Cancellation and timeout remain fail-closed. The previous 「目的フレームの描画待ちがタイムアウトしました」 was reproduced in the old code.

Camera startup now separates permission, input-video readiness, model startup and running stages. It includes explicit device selection, constrained permission retry rules, late-grant cleanup, a decoded-canvas bitmap path, a stalled-presentation-callback fallback and error-coded diagnostics. Embedded camera-policy denial explains the restriction and offers 「サイトを別タブで開く」.

## Executed verification and boundary

The specialized suite ran actual MediaPipe on 18 public photographs, checked expected pixels for nine File-equivalent WebM acquisitions, injected two live-browser API failures while preserving real capture/inference, checked native iframe policy denial and permission denial, and exercised the actual fixed-video screen at 12/20/30-fps analysis densities.

For a five-second public-photo MP4, planned/face-detected/sequence counts were 60/60/60, 100/100/100 and 150/150/150, with zero image failures and non-blank output. Playback/pause/frame-step checks passed. Those analysis densities are not realtime performance measurements.

The user's physical camera/OS/hosted iframe was not accessible. Its exact failure remains unconfirmed. The compatibility checks are not evidence that the user's hardware is fixed. No private IMG_3665.mp4 was used or uploaded. Actual Work Site, Safari, continuous human movement and long sessions remain unverified.

## Retained architecture and assets

The classic worker remains responsible for MediaPipe and candidate matching. The UI remains responsible for input capture, controls, bounded image cache and presentation. One frame is in flight; old results are discarded. Camera stop/restart cancels old sessions and releases media/worker/bitmap resources.

Catalog reads remain pinned to the full seed. The parsed cache remains 48 shards with default LRU, the active set at most 24 pose-local shards, and every active candidate is considered by the exact bounded coarse top-k calculation before detailed comparison of 48 candidates. This is not global exhaustive detailed search of all 70,000 faces. Image storage remains bounded to 64 decoded images / 32 MiB and up to three requests.

The catalog assets are unchanged from the packaged baseline, whose catalog tree is `559f7f39e3a8eed452ef7eb6a3355a318235c307`.

For historical numerical/performance work, see [ASTRA_RESOURCE_AUDIT.md](ASTRA_RESOURCE_AUDIT.md) and [ASTRA_ADVERSARIAL_AUDIT.md](ASTRA_ADVERSARIAL_AUDIT.md). Their measured throughput precedes the yaw correction; a green non-blank/performance test did not prove correct orientation. Do not use those numbers as certification of the repaired matching fidelity.

## Next priority

User review should run the rebuilt **INPUT RECOVERY V1** Site. A remaining camera failure should be accompanied by its visible code or scalar diagnostic JSON, not guessed from the generic word "camera". Then evaluate held-out head/eye/mouth motion and matching quality before more optimization.

Non-destructive coarse/detail asset separation, rare-expression coverage, startup/MIME behavior, physical-device/Safari/long-session coverage and catalog-write authorization remain open. Do not promote or deploy merely because functional CI passes.
