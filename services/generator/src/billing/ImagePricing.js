export const IMAGE_PRICING_MULTIPLIER = 1.2;
const CREDITS_PER_USD = 100;

export function imageBillingError(message, code = 'IMAGE_BILLING_PENDING') {
  return Object.assign(new Error(message), { code, imageBillingPending: true });
}

function amount(value, label = 'adapter charge') {
  if (!['number', 'string'].includes(typeof value) ||
      (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw imageBillingError(`A valid ${label} is required.`);
  }
  return Number(value);
}

function count(value, label) {
  const n = amount(value, label);
  if (!Number.isInteger(n)) throw imageBillingError(`Invalid ${label}.`);
  return n;
}

export function imageBillingMode(payload = {}, env = process.env) {
  const edition = String(env.SAMSAR_DEPLOYMENT_EDITION || env.SAMSAR_EDITION || env.CURRENT_ENV || '').trim().toLowerCase();
  if (['standalone', 'community', 'docker'].includes(edition)) return 'standalone';
  // Only new, server-created jobs opt into completion billing. Existing jobs
  // may already have been paid for and must never receive a second debit.
  return payload.imageBillingPolicy === 'adapter' ? 'adapter'
    : payload.imageBillingPolicy === 'pipeline' ? 'pipeline' : 'legacy';
}

function nativeOpenAICharge({ model, usage }) {
  if (!/^gpt-image-2\.5-(sunburst|flare)(?:-|$)/.test(model || '')) {
    throw imageBillingError('The image model needs a complete adapter charge.');
  }
  // Standard direct Images API. Cached discounts do not apply to this API.
  // https://developers.openai.com/api/docs/pricing
  // https://developers.openai.com/api/docs/guides/image-generation
  const text = count(usage?.input_tokens_details?.text_tokens, 'text input tokens');
  const images = count(usage?.input_tokens_details?.image_tokens, 'image input tokens');
  const total = count(usage?.input_tokens, 'input tokens');
  const output = count(usage?.output_tokens, 'image output tokens');
  if (text + images !== total) throw imageBillingError('Incomplete image input token usage.');
  return (text * 5 + images * 8 + output * 30) / 1_000_000;
}

function nativeGoogleCharge({ model, usage, region = 'global' }) {
  const pro = /^gemini-3-pro-image(?:-|$)/.test(model || '');
  const flash = /^gemini-3\.1-flash-image(?:-|$)/.test(model || '');
  if (!pro && !flash) throw imageBillingError('The image model needs a complete adapter charge.');
  // Standard Vertex pricing. Image output is a separate token modality.
  // https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
  const input = count(usage?.promptTokenCount, 'input tokens');
  const cached = count(usage?.cachedContentTokenCount ?? 0, 'cached input tokens');
  const candidates = count(usage?.candidatesTokenCount, 'output tokens');
  const thoughts = count(usage?.thoughtsTokenCount ?? 0, 'reasoning tokens');
  const details = usage?.candidatesTokensDetails;
  if (!Array.isArray(details)) throw imageBillingError('Image output token details are required for the charge.');
  let imageOutput = 0;
  let textOutput = 0;
  for (const detail of details) {
    const tokens = count(detail?.tokenCount, 'output modality tokens');
    if (String(detail.modality).toUpperCase() === 'IMAGE') imageOutput += tokens;
    else if (String(detail.modality).toUpperCase() === 'TEXT') textOutput += tokens;
    else throw imageBillingError('Unknown image output token modality.');
  }
  if (cached > input || imageOutput + textOutput !== candidates) {
    throw imageBillingError('Inconsistent image token usage.');
  }
  const regional = region && region !== 'global' ? 1.1 : 1;
  return ((input - cached) * (pro ? 2 : 0.5) + cached * (pro ? 0.2 : 0.05) +
    imageOutput * (pro ? 120 : 60) + (textOutput + thoughts) * (pro ? 12 : 3)) * regional / 1_000_000;
}

function nativeAlibabaCharge({ model, outputImages, inputImages = 0, resolution, region = 'international' }) {
  // https://www.alibabacloud.com/help/en/model-studio/model-pricing
  const outputs = count(outputImages, 'output image count');
  const inputs = count(inputImages, 'input image count');
  const international = region === 'international';
  if (!['international', 'china', 'global'].includes(region)) {
    throw imageBillingError('The image region needs a complete adapter charge.');
  }
  if (model === 'wan2.7-image-pro') return outputs * (international ? 0.075 : 0.068761);
  if (model === 'qwen-image-3.0-pro') {
    const size = String(resolution).toUpperCase();
    if (!['1K', '2K'].includes(size)) throw imageBillingError('The output resolution needs an adapter charge.');
    const unit = international ? (size === '2K' ? 0.075 : 0.04) : (size === '2K' ? 0.068761 : 0.03438);
    return inputs * (international ? 0.003 : 0.00275) + outputs * unit;
  }
  throw imageBillingError('The image model needs a complete adapter charge.');
}

export function calculateImageCallCredits(receipt = {}) {
  let costUsd;
  let costSource = 'adapter_reported';
  if (Object.hasOwn(receipt, 'costUsd')) costUsd = amount(receipt.costUsd);
  else if (Array.isArray(receipt.calls) && receipt.calls.length) {
    costSource = 'native_usage';
    costUsd = receipt.calls.reduce((sum, call) => sum + calculateImageCallCredits(call).costUsd, 0);
  }
  else {
    costSource = 'native_usage';
    if (receipt.adapter === 'openai') costUsd = nativeOpenAICharge(receipt);
    else if (receipt.adapter === 'googleCloud') costUsd = nativeGoogleCharge(receipt);
    else if (receipt.adapter === 'alibabaCloud') costUsd = nativeAlibabaCharge(receipt);
    else throw imageBillingError('A complete image adapter charge is required.');
  }
  const credits = Math.round(costUsd * CREDITS_PER_USD * IMAGE_PRICING_MULTIPLIER * 10_000) / 10_000;
  if (!Number.isFinite(credits)) throw imageBillingError('Invalid image adapter charge.');
  return { costUsd, credits, costSource, adapter: receipt.adapter, model: receipt.model };
}

/** Called only on a trusted adapter response, never on client request fields. */
export function reportedImageCharge(response = {}) {
  const candidates = [response?.billing?.cost_usd, response?.billing?.costUsd,
    response?.cost_usd, response?.costUsd, response?.usage?.cost,
    response?.usage?.total_cost, response?.usage?.cost_usd];
  const value = candidates.find(value => value !== undefined && value !== null);
  return value === undefined ? {} : { costUsd: value };
}
