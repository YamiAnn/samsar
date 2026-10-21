# Client coverage and regression baseline

Run existing Node regressions and jsdom component/unit tests with `npm test`.
Run the Chromium component tests with `npm run test:browser` (requires
`npm run test:browser:install` and permission to start a local server/browser).
The browser suite drives real components using Playwright-backed Vitest locators;
network/authentication and external media services are controlled at their boundaries.

## Whole-source coverage

Install the isolated, pinned, test-only Istanbul tools once:

```sh
npm install --prefix test/coverage --ignore-scripts
npm run test:coverage
```

This uses Istanbul's instrumenter for original JavaScript/JSX/TypeScript/TSX,
with source maps retained by Vite. No application file is rewritten on disk.
The runner always executes Node, jsdom, and Chromium tiers, including after
an earlier tier fails, and preserves each exit status in `coverage/run-results.json`.
Coverage from failed assertions still records the code that actually executed.

Every executable file under `src/` is included, including untouched legacy editors.
Only tests, styles, and non-code assets are outside the denominator. The merged
report is seeded with zero counters from each original source file, then combines
all instrumented execution counters. Reports are generated even when a tier fails:

- `coverage/index.html`: line and branch annotations.
- `coverage/coverage-final.json`: detailed counters for every source file.
- `coverage/coverage-summary.json`: per-file and aggregate percentages.
- `coverage/lcov.info`: CI/editor integration.
- `coverage/unit-results.json`, `coverage/chromium-results.json`: test results.
- `coverage/coverage-scope.json`: source scope, counts and suite exit codes.

`npm run test:coverage:check` additionally requires **98% lines and 98% branches**.
This is an explicit target check, not a claim that the current baseline meets it.
`node scripts/test-coverage.mjs --report-only` regenerates reports from retained
raw counters; it does not rerun tests. Normal test commands do not instrument code.

If these standard tools are already installed elsewhere, setting
`SAMSAR_COVERAGE_TOOLS` to that package root avoids another installation. The
2026-10-20 sandbox run used the existing sibling `samsar_admin` installation
because npm DNS was unavailable. This override affects only coverage tooling.
Node tests that use their own Vite SSR server do not automatically inherit the
instrumentation plugin; corresponding modules exercised by the jsdom suite do.
The report counts only observed instrumented executions and keeps unobserved
code at zero.

## Interpreting failures

Regression assertions deliberately specify expected product behavior. Existing
failures are ordinary failing tests, without `skip`, `todo`, expected-failure
markers, or source changes to make the baseline pass. Fix production code in a
separate change and demonstrate each failure turning green alongside existing
passing tests. Test fixtures use reserved example domains and deterministic media,
request, clock and random boundaries.

A sandbox failure to bind the Vitest browser server (`listen EPERM`) means the
Chromium tests did **not** execute. A jsdom diagnostic or static review cannot
establish Chromium behavior, image decoding, native drag and drop, or layout.
