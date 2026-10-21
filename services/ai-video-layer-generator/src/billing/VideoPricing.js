import { isStandaloneEdition } from '../utils/Environment.js';

export function videoBillingError(message) {
  return Object.assign(new Error(message), { videoBillingPending: true, code: 'VIDEO_BILLING_PENDING' });
}

export function videoBillingMode(payload = {}, env = process.env) {
  if (isStandaloneEdition(env)) return 'standalone';
  return ['adapter', 'pipeline'].includes(payload.videoBillingPolicy) ? payload.videoBillingPolicy : 'legacy';
}

function nonnegative(value, name) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' ||
      !Number.isFinite(Number(value)) || Number(value) < 0) throw videoBillingError(`Invalid video ${name}.`);
  return Number(value);
}

/** Provider charges take precedence over native tariffs, including free calls.
 * Native receipts must describe the actual submitted configuration, never the
 * scene duration after trimming, padding, or stitching. */
export function calculateVideoCallCredits(receipt = {}) {
  let costUsd;
  if (Object.hasOwn(receipt, 'costUsd')) costUsd = nonnegative(receipt.costUsd, 'adapter charge');
  else {
    const seconds = nonnegative(receipt.seconds, 'billable duration');
    if (!seconds) throw videoBillingError('Completed video duration is missing.');
    if (receipt.adapter === 'runway' && receipt.model === 'gen4.5') costUsd = seconds * 0.12;
    else if (receipt.adapter === 'googleCloud' && /^veo-3\.1-(fast-)?generate/.test(receipt.model || '')) {
      if (typeof receipt.generateAudio !== 'boolean' || !['720p', '1080p'].includes(receipt.resolution)) {
        throw videoBillingError('The submitted Google video configuration is incomplete.');
      }
      const fast = receipt.model.includes('-fast-');
      const rate = fast ? (receipt.generateAudio ? (receipt.resolution === '1080p' ? 0.12 : 0.10)
        : (receipt.resolution === '1080p' ? 0.10 : 0.08)) : (receipt.generateAudio ? 0.40 : 0.20);
      const outputs = nonnegative(receipt.outputCount, 'output count');
      if (!Number.isInteger(outputs) || outputs < 1) throw videoBillingError('Completed video output count is missing.');
      costUsd = seconds * rate * outputs;
    } else if (receipt.adapter === 'alibabaCloud' && receipt.model === 'happyhorse-1.1-i2v' && receipt.resolution === '720P') {
      if (!['international', 'global', 'china'].includes(receipt.region)) throw videoBillingError('Unknown Alibaba video region.');
      costUsd = seconds * (receipt.region === 'international' ? 0.14 : 0.123769);
    } else if (receipt.adapter === 'hailuo' && receipt.model === 'MiniMax-Hailuo-02' && receipt.resolution === '768P' && [6, 10].includes(seconds)) {
      costUsd = seconds === 6 ? 0.28 : 0.56;
    } else throw videoBillingError('The video adapter charge is not available yet.');
  }
  return { adapter: receipt.adapter, model: receipt.model, costUsd,
    credits: Math.round(costUsd * 120 * 10_000) / 10_000 };
}

export function reportedVideoCharge(response = {}) {
  const values = [response.billing?.cost_usd, response.billing?.costUsd, response.cost_usd,
    response.costUsd, response.usage?.cost, response.usage?.total_cost];
  const costUsd = values.find(value => value !== undefined && value !== null);
  return costUsd === undefined ? {} : { costUsd };
}
