import { expect, it, vi } from 'vitest';
import { runClientSuites } from '../../scripts/test-all.mjs';

it('runs Node, unit, and real Chromium even when an earlier tier fails', () => {
  const run = vi.fn().mockReturnValueOnce({ status: 1 })
    .mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 0 });
  expect(runClientSuites(run)).toEqual([
    { suite: 'node', exitCode: 1 },
    { suite: 'unit', exitCode: 0 },
    { suite: 'chromium', exitCode: 0 },
  ]);
  expect(run.mock.calls[2][0]).toContain('vitest.browser.config.mjs');
});

it('records launch errors and termination signals without skipping later tiers', () => {
  const run = vi.fn().mockImplementationOnce(() => { throw new Error('runner unavailable'); })
    .mockReturnValueOnce({ status: null, signal: 'SIGTERM' })
    .mockReturnValueOnce({ status: null, error: new Error('browser unavailable') });
  expect(runClientSuites(run)).toEqual([
    { suite: 'node', exitCode: 1, error: 'runner unavailable' },
    { suite: 'unit', exitCode: 1, signal: 'SIGTERM' },
    { suite: 'chromium', exitCode: 1, error: 'browser unavailable' },
  ]);
  expect(run).toHaveBeenCalledTimes(3);
});
