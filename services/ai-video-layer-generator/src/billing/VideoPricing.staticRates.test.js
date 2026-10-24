import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVideoCallCredits } from './VideoPricing.js';

const calls = [
  [{ adapter: 'runway', model: 'gen4.5', seconds: 5 }, 72],
  [{ adapter: 'googleCloud', model: 'veo-3.1-fast-generate-001', seconds: 8,
    resolution: '720p', generateAudio: false, outputCount: 1 }, 76.8],
  [{ adapter: 'alibabaCloud', model: 'happyhorse-1.1-i2v', seconds: 5,
    resolution: '720P', region: 'international' }, 84],
  [{ adapter: 'hailuo', model: 'MiniMax-Hailuo-02', seconds: 6, resolution: '768P' }, 33.6],
  [{ adapter: 'gmicloud', model: 'SEEDANCE2.0I2V', seconds: 5, resolution: '720p' }, 91.2],
];

for (const [configuration, expected] of calls) {
  test(`${configuration.adapter} uses constant base USD plus exactly 20%, independently of reported charge`, () => {
    for (const extra of [{}, { costUsd: 999 }, { costUsd: 0 }, { costUsd: null }, { costUsd: -1 }]) {
      const billed = calculateVideoCallCredits({ ...configuration, ...extra });
      assert.equal(billed.credits, expected);
    }
  });
}

test('unknown adapter/model cannot be billed from an arbitrary reported charge', () => {
  for (const adapter of ['samsar', 'custom', 'gmicloud']) {
    assert.throws(() => calculateVideoCallCredits({ adapter, model: 'UNKNOWN', seconds: 5, costUsd: 0.5 }), /verified static tariff/);
  }
});
