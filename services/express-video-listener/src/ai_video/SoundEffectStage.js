function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStatus(value) {
  return normalizeString(value).toUpperCase();
}

function normalizeType(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeId(value) {
  const normalized = value?.toString?.().trim?.() || '';
  return normalized || null;
}

export function isSoundEffectLayer(layer = {}) {
  // Terminal failures rewrite layerAiVideoType to `ai_video`. A saved failed
  // status keeps the optional sound-effect stage visible even on older layers
  // without layerBaseAiImageType.
  return normalizeType(layer?.layerBaseAiImageType) === 'sound_effect'
    || normalizeType(layer?.layerAiVideoType) === 'sound_effect'
    || normalizeStatus(layer?.soundEffectVideoGenerationStatus) === 'FAILED'
    || layer?.soundEffectGenerationPending === true;
}

export function shouldRequestAudioVideoLayer(layer = {}, model, audioVideoModels = []) {
  return isSoundEffectLayer(layer) && audioVideoModels.includes(model);
}

export function hasReusableBaseAiVideo(layer = {}) {
  return Boolean(
    layer?.hasAiVideoLayer
    || normalizeString(layer?.aiVideoLayer)
    || normalizeString(layer?.aiVideoRemoteLink)
  );
}

export function hasRenderReadyBaseAiVideo(layer = {}) {
  const status = normalizeStatus(layer?.aiVideoGenerationStatus);
  return layer?.hasAiVideoLayer === true
    && layer?.aiVideoGenerationPending !== true
    && status !== 'FAILED'
    && status !== 'PENDING'
    && Boolean(normalizeString(layer?.aiVideoLayer));
}

export function hasSoundEffectOutput(layer = {}) {
  return Boolean(
    layer?.hasSoundEffectVideoLayer
    && (
      normalizeString(layer?.soundEffectVideoLayer)
      || normalizeString(layer?.soundEffectRemoteLink)
    )
  );
}

function isTrackedSoundEffectLayer(layer = {}) {
  return Boolean(
    !layer?.isAudioVideoLayer
    && isSoundEffectLayer(layer)
    && hasReusableBaseAiVideo(layer)
  );
}

export function assessSoundEffectStage(layers = []) {
  const assessments = (Array.isArray(layers) ? layers : [])
    .filter(isTrackedSoundEffectLayer)
    .map((layer, layerIndex) => {
      const status = normalizeStatus(layer?.soundEffectVideoGenerationStatus) || 'INIT';
      const hasOutput = hasSoundEffectOutput(layer);
      let state = 'INCOMPLETE';
      if (status === 'FAILED') {
        state = 'SKIPPED';
      } else if (status === 'COMPLETED' && hasOutput) {
        state = 'COMPLETED';
      } else if (status === 'COMPLETED') {
        state = 'SKIPPED';
      } else if (layer?.soundEffectGenerationPending || status === 'PENDING') {
        state = 'PENDING';
      }
      return {
        layer,
        layerIndex,
        layerId: normalizeId(layer?._id),
        status,
        hasOutput,
        state,
      };
    });

  const failed = assessments.filter((assessment) => assessment.status === 'FAILED');
  const skipped = assessments.filter((assessment) => assessment.state === 'SKIPPED');
  const incomplete = assessments.filter((assessment) => assessment.state === 'INCOMPLETE');
  const pending = assessments.filter((assessment) => assessment.state === 'PENDING');
  const completed = assessments.filter((assessment) => assessment.state === 'COMPLETED');
  const missingBase = [...skipped, ...incomplete].find((assessment) =>
    !hasRenderReadyBaseAiVideo(assessment.layer)
  );
  let state = 'NOT_REQUIRED';
  if (pending.length) {
    state = 'PENDING';
  } else if (missingBase) {
    state = 'NO_BASE_VIDEO';
  } else if (skipped.length || incomplete.length) {
    // Sound effects are optional. Once no requests remain pending, any
    // terminal/missing output falls back to the already generated base video.
    state = 'FALLBACK';
  } else if (assessments.length && completed.length === assessments.length) {
    state = 'COMPLETED';
  }

  return {
    state,
    required: assessments,
    failed,
    skipped,
    incomplete,
    pending,
    completed,
    missingBase,
  };
}

export function getSoundEffectFailureMessage(assessment = {}) {
  const layer = assessment?.layer || {};
  const layerId = assessment?.layerId || normalizeId(layer?._id) || 'unknown';
  const existingError = normalizeString(
    layer?.soundEffectVideoGenerationError
    || layer?.soundEffectGenerationError,
  );
  if (existingError) {
    return existingError;
  }
  if (normalizeStatus(layer?.soundEffectVideoGenerationStatus) === 'COMPLETED') {
    return `Sound-effect generation completed without a reusable output for layer ${layerId}.`;
  }
  return `Sound-effect generation ended without a completed output for layer ${layerId}.`;
}
