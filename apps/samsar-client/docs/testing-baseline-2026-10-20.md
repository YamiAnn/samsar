# Samsar client test baseline — 2026-10-20

This is the historical test-only snapshot before application fixes. See the [repaired baseline](testing-baseline-fixed-2026-10-20.md) for current results.

Application code and existing tests are unchanged. SHA-256 comparison against the session-start source snapshot confirms all existing `src/` files are identical; no source files were added. Existing user edits were preserved. Changes are new tests, test-only coverage tools/documentation, and two package scripts.

**Near-100% coverage was not achieved.** Measured whole-source coverage is **31.02% lines and 28.07% branches**. The explicit 98% target check fails. Chromium is blocked before test collection by the execution environment.

## Test additions

- **1,205 new test cases**: 1,096 unit/component integration cases across 34 new files and 109 Chromium cases across 7 new files.
- React now has 1,137 cases across 40 files. Chromium defines 128 cases across 10 files.
- Coverage includes real hooks, contexts, route guards, editor screens/controllers, undo/redo, payloads, stale responses, polling, audio clocks/ducking, source URLs, canvas capture/filter math, forms, uploads, and accessible controls.
- External request/media boundaries are controlled; races use deferred requests and deterministic clocks/randomness. No new skipped, expected-failure, TODO, or focused tests were introduced.

## Final execution

| Tier | Passed | Failed | Executed | Result |
| --- | ---: | ---: | ---: | --- |
| Node regression | 191 | 0 | 191 | Passed |
| React/jsdom unit and integration | 1,104 | 33 | 1,137 | Failing baseline; 0 skipped |
| Chromium component | — | — | 0 | Blocked; 128 cases defined |
| Combined executed | 1,295 | 33 | 1,328 | Failing baseline |

The pre-expansion baseline passed 191 Node and 41 unit tests. Its browser run had the same environment blocker. The final standard `npm test` run and the final instrumented run reproduce the same 1,104 unit passes and 33 failures.

Final all-tier coverage command (exit 1):

```sh
SAMSAR_COVERAGE_TOOLS=../samsar_admin npm run test:coverage:check
```

This runner attempts every tier after earlier failures and generates reports. Existing local Istanbul tools were used because npm access failed with `ENOTFOUND registry.npmjs.org`. A clean checkout can install isolated tools with `npm install --prefix test/coverage --ignore-scripts`; see [coverage setup](../test/coverage/README.md).

Chromium startup failed with `listen EPERM: operation not permitted ::1:63315`: the sandbox refuses the local Vitest server socket. No Chromium pass/fail claim is made. Browser layout, media decoding, and native keyboard drag remain unverified.

## Coverage

| Metric | Covered | Total | Coverage |
| --- | ---: | ---: | ---: |
| Lines | 9,178 | 29,582 | 31.02% |
| Branches | 7,541 | 26,861 | 28.07% |
| Statements | 9,562 | 30,873 | 30.97% |
| Functions | 1,931 | 6,168 | 31.30% |

All **271 executable source files** under `src/**/*.{js,jsx,mjs,ts,tsx}` are counted, including untested legacy screens. Tests, styles, and assets are outside the denominator. No coverage exclusions were added to inflate results. **20,404 executable lines and 19,320 branches remain uncovered.**

Original-source Istanbul counters combine Node and jsdom executions, including code reached before failed assertions. Chromium contributed no counters. Node tests that start private Vite SSR servers do not inherit the instrumentation plugin; corresponding jsdom execution counts, while unobserved code stays at zero. This is conservative instrumented coverage.

Largest remaining gaps:

| Source | Uncovered lines | Line coverage | Branch coverage |
| --- | ---: | ---: | ---: |
| `src/components/video/VideoHome.jsx` | 2,005 | 0.00% | 0.00% |
| `src/components/oneshot_editor/OneshotEditor.jsx` | 1,511 | 50.94% | 40.15% |
| `src/components/video/toolbars/audio/RecordSpeechSection.jsx` | 1,410 | 0.00% | 0.00% |
| `src/components/video/toolbars/frame_toolbar/index.jsx` | 1,322 | 47.28% | 33.12% |
| `src/components/video/editor/VideoCanvasContainer.jsx` | 850 | 0.00% | 0.00% |
| `src/components/quick_editor/QuickEditor.jsx` | 716 | 0.00% | 0.00% |
| `src/components/video/VideoEditorContainer.jsx` | 667 | 45.41% | 40.07% |
| `src/components/oneshot_editor/ProgressIndicator.jsx` | 627 | 0.00% | 0.00% |
| `src/components/video/toolbars/VideoEditorToolbar.jsx` | 507 | 0.00% | 0.00% |
| `src/components/video/editor/VideoCanvas.jsx` | 440 | 0.00% | 0.00% |

## Retained failures

These **33 assertions** remain ordinary failing tests for the next fix cycle. Tests were reviewed against source behavior and observable contracts; no application fixes were made.

| Test file | Failures | Observed behavior |
| --- | ---: | --- |
| `test/unit/AssistantFrameCapture.test.jsx` | 1 | An overlay matching two hide mechanisms remains hidden after capture. |
| `test/unit/AudioStudioHome.test.jsx` | 1 | An in-flight status response restarts polling after unmount. |
| `test/unit/CanvasEffects.test.jsx` | 2 | Glitch changes one row of a five-row slice and reuses overwritten pixels during right shifts. |
| `test/unit/EditorContexts.test.jsx` | 1 | Opening a dialog executes the supplied confirmation callback with null. |
| `test/unit/FrameToolbar.integration.test.jsx` | 1 | Scene duration -5 is forwarded to session updates. |
| `test/unit/HomeRouting.test.jsx` | 4 | Mobile/root routes lose public query options; a duplicate one-use login-token exchange resets the authenticated user. |
| `test/unit/ImageStudioIntegration.test.jsx` | 2 | Auth expiry leaves generation pending; fresh zoom is 50% while Reset restores 100%. |
| `test/unit/ModelAdapterPreferencesHook.test.jsx` | 1 | An older preference response overwrites the newer response. |
| `test/unit/PreviewPlaybackTiming.test.jsx` | 2 | Muted audio starts at full gain; fallback music playback overwrites manual automation. |
| `test/unit/RealtimeTranscription.test.jsx` | 1 | A late token creates a peer and reports startup after unmount. |
| `test/unit/StepImageReviewPanel.test.jsx` | 1 | A raw-only candidate accepted by the model renders an empty image src. |
| `test/unit/VideoEditorContainer.integration.test.jsx` | 3 | Guest/failed video generation remain pending; an old scene response replaces the selected canvas. |
| `test/unit/audioPreviewTiming.test.js` | 6 | Zero-volume fallbacks/envelopes restore full volume; blob/data sources receive an API prefix. |
| `test/unit/authRedirectFlows.test.js` | 3 | Three inputs pass sanitization although URL normalization resolves to an external origin. |
| `test/unit/sessionTimelineTiming.test.js` | 1 | Subtitle-only export dereferences missing audio metadata. |
| `test/unit/viewportTiming.test.js` | 1 | Fallback frame/pixel conversions disagree on scale. |
| `test/unit/webAuthStorage.test.js` | 2 | Malformed cookie encoding throws; blocked cookie writes propagate after token persistence. |

The viewport/local-URL cases establish helper interoperability failures; their wider impact needs follow-up. Sanitizer tests establish acceptance of external-origin-normalizing input, without claiming a confirmed deployed exploit.

Complete assertion names and first-line errors are in `test-results/failures.json`; full details remain in `coverage/unit-results.json` and the logs.

## Supplemental browser diagnostics

A temporary jsdom adapter checked browser-test contracts separately. These results are excluded from canonical totals and coverage:
- Forms/password/extension: 59 passed, 3 failed out of 62. Failures concern duplicate sign-in requests, blank recovery emails, and unassociated reset-input labels.
- Five upload rejection diagnostics passed; nine media cases require Chromium.
- Editor controls: 31 passed; native image decoding and keyboard drag were excluded.
The diagnostic adapter is outside the repository. Committed browser tests continue to use the actual Chromium provider.

## Evidence

- `test-results/final-node-unit.log`: ordinary run.
- `test-results/final-coverage.log`: instrumented all-tier run and target check.
- `coverage/unit-results.json`, `coverage/chromium-results.json`, `coverage/run-results.json`: outcomes.
- `coverage/index.html`, `coverage/coverage-final.json`, `coverage/coverage-summary.json`, `coverage/lcov.info`: source coverage.
- `coverage/coverage-scope.json`: measured scope and exit codes.
- `test-results/source-integrity.json`: source preservation check.

The next fix cycle can turn the 33 assertions green while retaining the 1,295 executed passing tests. Chromium needs a runtime that permits its test server and browser launch. The whole-source coverage gap still requires substantial additional tests.
