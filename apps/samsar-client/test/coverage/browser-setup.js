import { afterAll } from 'vitest';
import { commands } from 'vitest/browser';
afterAll(async () => {
  await commands.writeSamsarCoverage(globalThis.__coverage__ || {});
});
