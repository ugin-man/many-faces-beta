# Verification recovery — 2026-10-04 JST

## Current target

Repository: `ugin-man/many-faces-beta`, branch `astra/realtime-hardening`, draft PR #3. Tested application commit: `c1d5faa883f139beb9c51d41402cf87c87e76e2d`. Source-content build ID: `3268c1736ea0d3fd`. Runtime version: `verification-recovery-v2`.

The priority of this change is to let the user finish a validation run, not claim completed tracking quality. The existing full-screen two-mode UI, complete 23.3-second bundled recording and all 70,000 catalog photographs are retained. Catalog tree remains `559f7f39e3a8eed452ef7eb6a3355a318235c307`. There is no reduced catalog, replacement Site, package or main/base merge.

## Reproduced video failure

The original implementation counted a completed matched frame as progress, but not intermediate shard downloads or decoded entries. A frontal search still loads 99 pose files before ranking its first frame. Its original 90-second liveness check could therefore kill a genuinely advancing operation. The request timeout also stopped covering the request once headers arrived, leaving response.json() outside that timeout.

The regression test builds the exact original `d9cbc1966a7c38847b231bdc963a0f9c7a0c13b1` and the exact new commit, with no application-source edits in CI. Both use the same full catalog and a one-second segment derived from the existing recording at 12 samples/second. A local HTTP proxy passes real response bodies in 32 KiB chunks, once per 170 ms per request, with the application's original four-request concurrency. No landmarks or matching results are mocked and no watchdog value is shortened to force a result.

Original: failed after 97.175 seconds from file selection with the actual visible error `「必要な角度の顔だけ読み込み・照合中」で90秒以上進捗がありません。処理を停止しました。`.

Repaired: still correctly active at 152.755 seconds, with zero completed matched frames but 95,703,554 received bytes, 98 completed files and 15,289 decoded entries. It then completed at 206.950 seconds: 12 planned/detected/sequence frames, zero image failures, and a nonblank output canvas. Across this short moving segment it loaded 118 files, 17,750 records and 110,298,888 logical response-body bytes. The extra files reflect changes in the input pose; no neighborhood reduction was used to pass the test. These are response-body bytes, not a general claim about compressed on-wire traffic.

## Repair

`app/live/asset-reader.ts` streams response bodies, reports only newly received bytes, enforces size limits, distinguishes HTTP/invalid-JSON/idle failures, and covers body consumption with cancellation and deadlines. Empty chunks, repeated sequence counters and mere timer ticks do not count as progress. Per-asset idle timeout is 20 seconds and total duration is bounded.

`review-search.worker.ts` now owns JSON decoding, detailed candidate ranking and sequence optimization. Candidate decoding yields in batches of 32. It reports actual bytes, decoded entries, completed files and completed frames. `review-search.ts` accepts only increasing progress sequences, terminates the worker on cancellation/failure/completion, and checks its build identity. The UI updates its liveness clock immediately from these messages, before waiting for React rendering. The 90-second inactivity check is still present; it is not disabled or replaced with a spinner heartbeat.

The existing 12/15-degree pose window, 18/21-degree expansion, full catalog and ranking/sequence options are retained. Shared catalog-vector decoding replaces the slower duplicate decoder. This patch does not solve the large initial detailed-JSON working set. On a genuinely slow connection, initial validation can still take minutes; that is now shown as actual loading progress rather than falsely treated as a crash.

## Camera startup and the 8-second boundary

The user's precise physical-camera failure remains unconfirmed because their hardware/hosted browser session was not accessible. The old implementation could run a second CPU-engine creation/probe inside a live frame after slow GPU inference, making startup work part of a nominally bounded live-frame operation.

The recovery path uses a single CPU Face Landmarker engine as the compatibility baseline. Model and WASM bytes are fetched once with real download progress. A custom WASM binary Blob URL uses those acquired bytes; no security policy is relaxed. The first actual inference is executed during startup using an acquired input frame. Only after it succeeds does the worker announce ready and the live frame pump begin. There is no mid-frame GPU/CPU probe or second engine. Startup has its own 45-second no-progress deadline and 10-minute absolute limit; stop terminates its worker and releases tracks. The original 8-second live-frame/input stall checks remain. Unrelated catalog network activity cannot hide a hung in-flight inference.

The actual native Chromium virtual camera was tested with the real bundled motion stimulus. A separate proxy streamed the real WASM binary in 32 KiB chunks every 40 ms. At 14.691 seconds the client was still in startup, receiving data, with zero in-flight live frames; it did not trigger the 8-second live timeout. By 17.203 seconds it had produced 35 processed frames, 30 face frames and 8 output changes with zero image failures. Stop, restart and mode change released all camera tracks. This is a cold-download functional test, not a measured reproduction of the user's exact 8-second failure and not physical-device/Safari certification.

## Complete retained recording and input regressions

The normal full-screen browser suite also completed the entire existing 23.3-second video at 12 samples/second: 279 planned frames, 244 face-detected and sequence frames, 103 selected images, zero image failures, nonblank output. Processing took 97.719 seconds in that CI run. Sampling density is not realtime processing speed; this single result is not a controlled speedup comparison. Detection coverage was 87.46%, not 100%, and fine matching quality remains unresolved.

Playback past five seconds, seeking, frame stepping, paired mirroring, full-screen mobile/desktop layout, native virtual-camera output, swipe exit, restart and cancellation passed. All 156 unit tests passed without skips; build passed; lint had zero errors and 13 pre-existing warnings. No claim of an independent full-repository TypeScript typecheck is made.

The separate input-regression suite passed the retained real-photo yaw checks, decoded-frame pixel checks, native policy/permission failures, absent-callback/direct-video-bitmap compatibility injection, and actual five-second video input at 12/20/30 samples per second. The normal realtime and adversarial audit workflows also completed successfully.

## Site identity and deployment boundary

`/api/runtime` returns the source-content build ID and Git revision with no-store caching. The client diagnostics show the client and server identities; the camera/search workers check their identity against the client. In the tested application, client, server and camera worker all reported `3268c1736ea0d3fd`.

A bounded unauthenticated GET to the previously used hosted address `https://many-faces-prototype.uginn-poppo.chatgpt.site/api/runtime` returned HTTP 404 and `Not Found`. This only establishes that the new identity endpoint was not available on that route at the time; it does not independently prove which source version the entire Site served or that hosting caused the original failure. The hosted Site was not rebuilt or changed in this run. Do not describe Git/CI success as a verified deployment to the user's Site.

To deploy, update the EXISTING Work Site from this branch, keeping its project settings and full catalog, and rebuild without reimplementing the source. Confirm version `verification-recovery-v2`, client/server build `3268c1736ea0d3fd` and matching worker build in Settings > Image information / diagnostics. An old ZIP or an already built Site does not update automatically when this Git branch changes.

## Completed evidence

- Slow-body baseline/recovery, cold camera startup, lifecycle and identity: https://github.com/ugin-man/many-faces-beta/actions/runs/37136939394 . Artifact 11278947946, SHA-256 `d160e981fa9942dd899166571e6092021783fff9a56422986ff350863b2c7fff`.
- Full recording and full-screen UI: https://github.com/ugin-man/many-faces-beta/actions/runs/37136939322 . Artifact 11278014370, SHA-256 `9967febd287b47024409e2219aefdf4bd48e0e88248865eeeae83a0caba77a0e`.
- Native input regressions: https://github.com/ugin-man/many-faces-beta/actions/runs/37136939299 .
- Realtime lifecycle and resource checks: https://github.com/ugin-man/many-faces-beta/actions/runs/37136939357 .
- Adversarial audit: https://github.com/ugin-man/many-faces-beta/actions/runs/37136939433 .
- Repository CI: https://github.com/ugin-man/many-faces-beta/actions/runs/37136942202 .

The two downloaded evidence archives were hash-verified, their raw reports read, and the result screen visually inspected. Only the already bundled reference asset was reused; no new private camera footage was uploaded.
