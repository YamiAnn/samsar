# Samsar client repaired baseline — 2026-10-20

All **33 previously failing unit assertions now pass**. All **1,137 original unit cases** remain present and green, alongside **67 additional regression cases**. No tests were skipped or marked as expected failures to establish this baseline.

The source client and its synced monorepo copy each pass **191 Node tests and 1,204 unit/component tests**. Both native production builds succeeded. Chromium and Docker image building remain blocked by this runtime; those are not reported as passing.

## Changes to review

Application fixes are in the source `samsar_client` project and synced into `samsar/apps/samsar-client`. Existing user changes were preserved. Changes touch 21 application files, regression tests, and the coverage-output ignore rule. No dependency upgrades, commits, pushes, deployments, or container starts were performed. The monorepo remains on `develop`.

| Area | Corrected behavior | Main source files |
| --- | --- | --- |
| Authentication | Pending login/recovery submissions are guarded synchronously and disabled; blank recovery email is rejected; reset inputs have associated labels. Malformed/inaccessible cookies do not crash authentication, and blocked cookie writes do not invalidate stored credentials or logout. Browser-normalized external redirect inputs are rejected. | `src/components/auth/`, `src/utils/web.jsx`, `src/utils/authRedirect.js` |
| Initial routing and token handoff | Public query options survive root/mobile/legacy redirects while credential fields are removed. One-use tokens exchange once across effect replay. Context changes cancel old route results, and late replies cannot reset a newer login or navigate after unmount. | `src/components/landing/Home.tsx` |
| Image and video editors | Authentication failure leaves controls idle. Fresh image zoom matches Reset at 100%. Old scene/request results cannot replace a different canvas, select old scenes, clear a newer pending indicator, or start stale polling. AI-video rejection releases pending state. | `src/components/image/ImageStudioHome.jsx`, `src/components/video/VideoEditorContainer.jsx` |
| Image review | Raw-only image candidates and accepted URL aliases display the resolved image. | `src/components/oneshot_editor/StepImageReviewPanel.jsx` |
| Audio preview | Zero gain stays silent; automation fades correctly to/from silence. Blob/data recording URLs remain usable. Browsers without AudioContext retain manual music gain while ducking. | `src/components/video/util/audioPreviewDucking.js`, `src/components/video/PreviewPlaybackController.jsx` |
| Canvas and timeline | Frame capture restores overlapping hidden overlays; glitch shifts use original pixels across every slice row; subtitle-only export tolerates missing audio metadata; fallback frame/pixel conversion uses consistent scale. Invalid scene duration cannot update session data. | `src/utils/assistantFrameCapture.js`, `src/utils/frame_animation/GlitchUtils.jsx`, `src/utils/sessionTimelineText.js`, `src/components/video/util/viewportGeometry.js`, `src/components/video/toolbars/frame_toolbar/index.jsx` |
| Lifecycle and state | Confirmation callbacks are stored without running. Stale preference reads cannot replace newer values/saves. Cancelled transcription setup releases late microphone streams and ignores stale handshake work. Audio generation/join polling cannot restart after unmount. | `src/contexts/AlertDialogContext.jsx`, `src/hooks/useModelAdapterPreferences.js`, `src/hooks/useRealtimeTranscription.js`, `src/components/audio/AudioStudioHome.jsx` |

Independent review found and corrected two additional races in the initial fixes: stale AI-video rejection clearing a newer scene's pending state, and cached root destination lookup reusing obsolete query/account context. Both now have targeted regressions.

The ignore rule now targets `/coverage/`, allowing the test-only `test/coverage/` support files to be tracked while keeping generated root reports ignored.

## Final validation

| Check | Result |
| --- | --- |
| Source Node suite | 191 passed, 0 failed |
| Source React/jsdom suite | 1,204 passed, 0 failed, 0 skipped across 41 files |
| Original baseline preservation | All 1,137 original unit cases remain; all 33 original failures now pass |
| Monorepo client Node suite | 191 passed, 0 failed |
| Monorepo client React/jsdom suite | 1,204 passed, 0 failed, 0 skipped |
| Monorepo integrity suite | 13 passed, 0 failed |
| Source production build | Passed; output `samsar_client/dist_build/` |
| Monorepo standalone staging production build | Passed; output `samsar/apps/samsar-client/dist_build/` |
| Source-to-monorepo sync | Included client files checksum-verified identical |
| Whitespace checks | Passed |
| Supplemental browser diagnostics | 98 passed; 11 native-only cases excluded from this temporary diagnostic |
| Chromium component suite | Blocked before collection; 128 cases defined |
| Docker image rebuild | Blocked; no image produced |

The native monorepo build uses the client Dockerfile's staging mode with standalone metadata and local processor/client endpoints (`localhost:3002` / `localhost:3000`). Its production build remains local and was not served or deployed.

## Sync scope

Only the client was synced. Unrelated monorepo services and existing deployment/configuration edits were left intact. The sync follows `scripts/sync-projects.sh` exclusions, preserves environment files and installed dependencies, excludes generated builds/test outputs, and explicitly includes the test coverage support directory. A checksum dry run confirms no included file differences remain.

## Runtime limits

Chromium cannot start its test server: `listen EPERM: operation not permitted ::1:63315`. The temporary jsdom browser diagnostic is supplemental; it does not establish native browser layout, image/video decoding, or drag behavior. Those 11 diagnostic exclusions do not add committed test skips.

Docker's configured daemon socket is absent. Docker Desktop could not be launched because the system application-launch service is unavailable. The Compose build attempt also encountered a denied write to Docker's buildx activity metadata. Consequently, **the local static client bundle is rebuilt, but the Docker image is not**. No `compose up`, container restart, remote action, or deployment was performed.

## Measured coverage

The post-fix instrumented run also passes all 191 Node and 1,204 unit tests. Across all 271 executable source files, measured coverage is **31.56% lines** and **28.46% branches**. The earlier near-100% goal remains unmet; the 98% target check is separate from this passing Node/jsdom baseline. Chromium contributed no execution counters.

## Suggested manual verification

1. Sign in and request a recovery email while clicking/pressing Enter repeatedly; verify only one request is pending. Check required recovery email and reset-field label focus.
2. Open a root/mobile project link with public query options, then complete a token login. Verify one-use token authentication remains signed in and route options survive.
3. Generate an image or AI video, switch scenes while its request is pending, and trigger a request failure. Verify the selected scene and newer request state stay intact and controls recover.
4. Check fresh canvas zoom and Reset, raw-only review images, positive scene-duration validation, and overlay visibility after capture.
5. Preview muted audio and automation fades, then leave Audio Studio or transcription while startup/polling is pending. Verify silence is retained and late work does not restart on the previous screen.

## Evidence

- `test-results/fixes-summary.json`: machine-readable outcome.
- `test-results/fixes-baseline-comparison.json`: all original cases preserved and failures turned green.
- `test-results/fixes-source-changes.json`: the 21 changed application files.
- `test-results/fixes-final-node.log`, `test-results/fixes-final-unit.json`, `test-results/fixes-final-unit.log`: source test results.
- `test-results/fixes-source-build.log`: source build.
- `test-results/fixes-browser-diagnostic.json`, `test-results/fixes-browser-start.log`: diagnostic results and actual Chromium blocker.
- `test-results/fixes-final-coverage.log`, `coverage/`: post-fix instrumented results and reports.
- `test-results/fixes-monorepo-sync.log`: local client sync.
- Monorepo client `test-results/fixes-monorepo-{node,unit,build}.log` and unit JSON: synced-copy validation.

The earlier [test-only failing baseline](testing-baseline-2026-10-20.md) is retained for comparison.
