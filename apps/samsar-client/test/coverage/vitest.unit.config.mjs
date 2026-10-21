import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config.mjs';
import { coverageInstrumentation, root } from './instrumentation.mjs';
export default mergeConfig(base, {
  root,
  plugins: [coverageInstrumentation()],
  test: { setupFiles: ['./test/coverage/setup.js'] },
});
