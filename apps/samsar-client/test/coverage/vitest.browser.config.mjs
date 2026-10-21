import { mergeConfig } from 'vitest/config';
import base from '../../vitest.browser.config.mjs';
import { coverageInstrumentation, root, writeCoverage } from './instrumentation.mjs';
export default mergeConfig(base, {
  root,
  plugins: [coverageInstrumentation()],
  test: {
    setupFiles: ['./test/coverage/browser-setup.js'],
    browser: { commands: { writeSamsarCoverage: (_context, coverage) => writeCoverage(coverage, 'chromium') } },
  },
});
