import { videoBillingError } from './VideoPricing.js';

// Provider base USD only. VideoPricing applies the single 20% markup.
// Retain dated snapshots: a submitted or completed call must never be repriced
// by a provider response or by a later deployment.
export const STATIC_VIDEO_TARIFF_VERSION = '2026-10-24';
const gmiModel = (modelId, rateUsd, configuration = {}) => Object.freeze({ modelId, rateUsd, ...configuration });
export const GMI_VIDEO_TARIFFS_2026_10_24 = Object.freeze({
  'VEO3.1': gmiModel('veo-3.1-generate-001', null),
  'VEO3.1I2V': gmiModel('veo-3.1-generate-001', null),
  'VEO3.1FLIV': gmiModel('veo-3.1-generate-001', null),
  'VEO3.1FAST': gmiModel('veo-3.1-fast-generate-001', null),
  'VEO3.1I2VFAST': gmiModel('veo-3.1-fast-generate-001', null),
  SEEDANCEI2V: gmiModel('seedance-1-5-pro-251215', 0.051, { resolution: '720p' }),
  'SEEDANCE2.0I2V': gmiModel('seedance-2-0-260128', null),
  'SEEDANCE2.5I2V': gmiModel('seedance-2-5-260628', 0.231, { resolution: '720p' }),
  KLINGIMGTOVID3PRO: gmiModel('kling-v3-image-to-video', null),
  KLINGIMGTOVIDTURBO: gmiModel('kling-3.0-turbo-i2v', 0.112, { resolution: '720p' }),
  KLINGIMGTOVIDPRO: gmiModel('Kling-Image2Video-V1.6-Pro', 0.098),
  'KLINGIMGTOVID2.1MASTER': gmiModel('Kling-Image2Video-V2.1-Master', 0.28),
  'KLINGIMGTOVID2.1PRO': gmiModel('Kling-Image2Video-V2.1-Pro', 0.098),
  'KLINGIMGTOVID2.1STANDARD': gmiModel('Kling-Image2Video-V2.1-Standard', 0.056),
  HAPPYHORSEI2V: gmiModel('happyhorse-1.1-i2v', null),
});

// The adapter submits 1080P, while the account card's undifferentiated $0.06
// rate has a 768P default. Preserve the previous completion-reported charge
// until the 1080P provider base tariff can be verified; never fetch a price.
export function usesLegacyGmiReportedPricing(receipt = {}) {
  return receipt.adapter === 'gmicloud' && receipt.model === 'HAILUOPRO';
}
export const STATIC_VIDEO_TARIFF_VERSIONS = Object.freeze({
  '2026-10-24': Object.freeze({
    runway: Object.freeze({ source: 'https://docs.dev.runwayml.com/guides/pricing/',
      gen45UsdPerSecond: 0.12 }),
    googleCloud: Object.freeze({ source: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
      standardUsdPerSecond: Object.freeze({ silent: 0.20, audio: 0.40 }),
      fastUsdPerSecond: Object.freeze({
        '720p': Object.freeze({ silent: 0.08, audio: 0.10 }),
        '1080p': Object.freeze({ silent: 0.10, audio: 0.12 }),
      }) }),
    alibabaCloud: Object.freeze({ source: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
      happyHorse720UsdPerSecond: Object.freeze({ international: 0.14, global: 0.123769, china: 0.123769 }) }),
    hailuo: Object.freeze({ source: 'https://platform.minimax.io/docs/guides/pricing-paygo',
      hailuo02At768UsdPerVideo: Object.freeze({ 6: 0.28, 10: 0.56 }) }),
    // One-time authenticated account model-card snapshot 2026-10-24. Prices
    // are micro-USD in price_info; pricing_details/price_chart carry tiers.
    // All account discounts were 0%. No runtime catalog or price request.
    gmicloud: Object.freeze({ source: 'https://console.gmicloud.ai/',
      models: GMI_VIDEO_TARIFFS_2026_10_24,
      seedance20UsdPerSecond: Object.freeze({ '480p': 0.07, '720p': 0.152, '1080p': 0.374 }),
      veoUsdPerSecond: Object.freeze({
        standard: Object.freeze({ '720p': [0.20, 0.40], '1080p': [0.20, 0.40], '4k': [0.40, 0.60] }),
        fast: Object.freeze({ '720p': [0.10, 0.15], '1080p': [0.10, 0.15], '4k': [0.30, 0.35] }),
      }),
      happyHorseUsdPerSecond: Object.freeze({ '720P': 0.14, '1080P': 0.28 }),
      kling3ProUsdPerSecond: Object.freeze({ silent: 0.168, audio: 0.252 }) }),
  }),
});

function positive(value, name) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' ||
      !Number.isFinite(Number(value)) || Number(value) <= 0) {
    throw videoBillingError(`The submitted video ${name} is missing or invalid.`);
  }
  return Number(value);
}

function unavailable(receipt) {
  return videoBillingError(`Video ${receipt.adapter || '<missing>'}/${receipt.model || '<missing>'} has no verified static tariff for its submitted configuration.`);
}

export function buildStaticVideoReceipt(receipt = {}, version = STATIC_VIDEO_TARIFF_VERSION,
  versions = STATIC_VIDEO_TARIFF_VERSIONS) {
  const tariff = versions[version]?.[receipt.adapter];
  if (!tariff) throw unavailable(receipt);
  const seconds = positive(receipt.seconds, 'duration');
  let rateUsd, unit = 'second', quantity = seconds, upstreamModel;
  if (receipt.adapter === 'runway' && receipt.model === 'gen4.5') {
    rateUsd = tariff.gen45UsdPerSecond;
  } else if (receipt.adapter === 'googleCloud' && /^veo-3\.1-(fast-)?generate-(?:001|preview)$/.test(receipt.model || '')) {
    if (typeof receipt.generateAudio !== 'boolean' || !['720p', '1080p'].includes(receipt.resolution)) throw unavailable(receipt);
    const audio = receipt.generateAudio ? 'audio' : 'silent';
    rateUsd = receipt.model.includes('-fast-') ? tariff.fastUsdPerSecond[receipt.resolution][audio]
      : tariff.standardUsdPerSecond[audio];
  } else if (receipt.adapter === 'alibabaCloud' && receipt.model === 'happyhorse-1.1-i2v' && receipt.resolution === '720P') {
    rateUsd = tariff.happyHorse720UsdPerSecond[receipt.region];
  } else if (receipt.adapter === 'hailuo' && receipt.model === 'MiniMax-Hailuo-02' && receipt.resolution === '768P') {
    rateUsd = tariff.hailuo02At768UsdPerVideo[seconds];
    unit = 'video';
    quantity = 1;
  } else if (receipt.adapter === 'gmicloud') {
    const model = tariff.models[receipt.model];
    if (!model || (model.resolution && model.resolution !== receipt.resolution)) throw unavailable(receipt);
    upstreamModel = model.modelId;
    if (receipt.model.startsWith('VEO3.1')) {
      if (typeof receipt.generateAudio !== 'boolean') throw unavailable(receipt);
      rateUsd = tariff.veoUsdPerSecond[receipt.model.includes('FAST') ? 'fast' : 'standard']
        [receipt.resolution]?.[Number(receipt.generateAudio)];
    } else if (receipt.model === 'SEEDANCE2.0I2V' && seconds <= 15) {
      rateUsd = tariff.seedance20UsdPerSecond[receipt.resolution];
    } else if (receipt.model === 'HAPPYHORSEI2V') {
      rateUsd = tariff.happyHorseUsdPerSecond[receipt.resolution];
    } else if (receipt.model === 'KLINGIMGTOVID3PRO') {
      if (typeof receipt.generateAudio !== 'boolean' || receipt.mode !== 'pro') throw unavailable(receipt);
      rateUsd = tariff.kling3ProUsdPerSecond[receipt.generateAudio ? 'audio' : 'silent'];
    } else {
      rateUsd = model.rateUsd;
    }
  }
  if (!Number.isFinite(rateUsd) || rateUsd < 0) throw unavailable(receipt);
  const { costUsd: _reportedCost, ...configuration } = receipt;
  return { ...configuration, staticVideoTariffVersion: version, tariffRateUsd: rateUsd,
    tariffUnit: unit, submittedQuantity: quantity, tariffSource: tariff.source,
    tariffVerifiedOn: version,
    ...(upstreamModel ? { upstreamModel } : {}) };
}

export function calculateStaticVideoUsd(receipt = {}, versions = STATIC_VIDEO_TARIFF_VERSIONS) {
  const version = receipt.staticVideoTariffVersion || STATIC_VIDEO_TARIFF_VERSION;
  const expected = buildStaticVideoReceipt(receipt, version, versions);
  if (receipt.staticVideoTariffVersion && (receipt.tariffUnit !== expected.tariffUnit ||
      receipt.tariffRateUsd !== expected.tariffRateUsd || receipt.submittedQuantity !== expected.submittedQuantity)) {
    throw videoBillingError('The sealed static video tariff is invalid.');
  }
  let outputs = 1;
  if (receipt.adapter === 'googleCloud') {
    outputs = positive(receipt.outputCount, 'output count');
    if (!Number.isInteger(outputs)) throw videoBillingError('The completed video output count is invalid.');
  }
  return { costUsd: expected.tariffRateUsd * expected.submittedQuantity * outputs,
    staticVideoTariffVersion: version, tariffRateUsd: expected.tariffRateUsd,
    billingBasis: expected.tariffUnit, billableQuantity: expected.submittedQuantity * outputs,
    tariffVerifiedOn: expected.tariffVerifiedOn, tariffSource: expected.tariffSource };
}
