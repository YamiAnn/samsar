# Studio layout, timing and media verification

43 regressions were demonstrated failing before their fixes and now pass. The finalized tests were also replayed against isolated copies of the original working-tree sources: 43 failed, zero passed. Existing uncommitted work was retained in the baseline.

## Fail-to-pass results

| Area | Original sources | Fixed sources | Coverage |
| --- | ---: | ---: | --- |
| Timeline geometry and boundaries | 13 failed | 13 passed | 16/24/30 FPS ruler coordinates, audio movement across differently scaled scenes, bottom-strip gaps, exclusive end boundaries, FPS-aware trim minimum |
| Toolbar controls | 7 failed | 7 passed | Text timing save, effect bounds, 1.25/1.5 speed, legacy text timing conversion, scene navigation, vertical scene gaps |
| Session reconciliation and active images | 4 failed | 4 passed | Reorder/copy adopt authoritative duration and connected audio; failed saves clear pending state; failed active images hold playback until refreshed credentials decode |
| Video/audio preview | 7 failed | 7 passed | One-frame drift tolerance at 16/24/30 FPS, equivalent snapshot audio reuse, credential rotation, video error recovery callback, buffering clock pause/resume |
| Waveforms | 2 failed | 2 passed | Shared timeline click coordinates and decoded-buffer reuse after credential rotation |
| Nested panel menus | 2 failed | 2 passed | Scene and shared action menus escape scrolling panel clipping; scene action still executes after pointer-down |
| VidGenie readiness | 2 failed | 2 passed | Image failure/timeout cannot mark media ready |
| Processor source FPS | 6 failed | 6 passed | Real FFmpeg extraction from 24000/1001 and 30000/1001 inputs into 16/24/30 FPS projects |
| **Total** | **43 failed** | **43 passed** | |

Per-test names, original assertion failures for component tests, and before/after source hashes are recorded in `docs/verification/studio-f2p-2026-10-20.json`.

## Changes

- Scene rows, ruler ticks, audio movement, waveforms, automation points and bottom thumbnails use the same frame-to-viewport mapping. Explicit timeline gaps remain visible. Cumulative row overlaps, conflicting handle sizes and global height transitions were removed.
- Text/effect timing preserves native FPS and relative boundaries. Speed controls keep fractional values. Previous/next controls select adjacent scenes. Failed saves preserve pending edits.
- Reorder, copy and layer-save responses update the complete client session snapshot, including connected audio and duration. Late responses for a different session are ignored. Polling compares timing/content as well as generation status.
- Studio shares decoded images across preloading and rendering through an editor-scoped bounded pool. Speculative loading has two workers and discards obsolete lookahead queues. Credential rotation retains asset identity and content-version distinctions; refresh merges credentials without replacing unsaved content. Waveform buffers are also scoped and bounded.
- Preview timing waits for active visuals, including successful image decoding, and resumes without adding buffering wall time. Equivalent audio snapshots retain the existing playback graph. VidGenie failures/timeouts remain unready and can retry.
- Studio, VidGenie, Audio Studio and Settings adopt common panel surfaces, workspace offsets, field/status colors and light/dark tokens. Expanded toolbar headers wrap/scroll; anchored menus render outside nested scroll containers. Inner timeline lanes reserve native scrollbar space consistently.
- Processor extraction explicitly rounds the final source timestamp to the project frame boundary. The tested fractional-FPS inputs previously produced 33/49/61 frames instead of 32/48/60. The shared helper's legacy two-argument default remains compatible with independently deployed workers; only this processor path opts into rounding.

## Full runnable verification

| Check | Result |
| --- | --- |
| Client unit/component suite | 1,241 passed, 0 failed |
| Client Node suite | 201 passed, 0 failed |
| Processor frame-drift suite | 24 passed, 0 failed |
| Client production build | Passed |
| Source repository whitespace checks | Passed |
| Browser layout suite | **Blocked: 10 defined cases, 0 executed** |

The 43 regressions are included in these totals. The targeted client command runs 45 tests: 35 component regressions, two VidGenie regressions and eight media-pool compatibility checks. The processor's 24 tests include its six new FFmpeg regressions and the legacy extraction-default compatibility check.

Run from `samsar_client`:

```sh
npm run test:studio-f2p:unit
npm run test:unit
npm run test:node
npm run build
```

Run from `samsar_processor`:

```sh
npm run test:frame-drift
```

Run the browser cases in a browser-enabled environment from `samsar_client`:

```sh
npm run test:studio-f2p
```

The default targeted command includes the browser suite and returns failure when browser execution is unavailable; `:unit` explicitly selects the runnable Node/component checks.

## Verification limits and remaining checks

Vitest's browser server was denied permission to listen on `::1:63315` (`EPERM`). A direct local Chrome launch was also restricted. No browser geometry or visual result is counted as passed. The ten browser cases cover rendered ruler/row alignment, cumulative scene-border drift, light/dark tab reachability at two widths, trim-handle dimensions and unrelated height transitions. Their red/green status remains unverified.

Component tests exercise real client components and algorithms with mocked HTTP, media/browser facilities and selected leaf UI boundaries. Processor tests generate and extract real small video fixtures. These checks do not establish deployed API-gateway behavior or complete rendered-export synchronization.

The next verification step is to run the browser suite, then inspect Studio expanded/collapsed panels, nested scrollbars, bottom controls, VidGenie, Audio Studio and Settings at common desktop/mobile widths in both themes. Use mixed-FPS media, cold/warm caches, an expired media grant and scene jumps during buffering. Confirm the gateway returns the same complete session contracts exercised by the reconciliation tests. Request ordering within one session and cross-service render synchronization remain integration checks.

Only the task's changed files are mirrored into `samsar/apps/samsar-client` and `samsar/services/processor`. No deployment or Docker rebuild was performed.
