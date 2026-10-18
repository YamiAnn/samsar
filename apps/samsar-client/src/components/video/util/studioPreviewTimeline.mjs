export const STUDIO_DISPLAY_FRAMES_PER_SECOND = 30;

export function secondsToDisplayFrames(value, framesPerSecond = STUDIO_DISPLAY_FRAMES_PER_SECOND) {
  return Math.max(
    0,
    Math.round((Number(value) || 0) * framesPerSecond)
  );
}

export function getLayerDisplayFrameRange(layer, framesPerSecond = STUDIO_DISPLAY_FRAMES_PER_SECOND) {
  const startFrame = secondsToDisplayFrames(layer?.durationOffset, framesPerSecond);
  const durationFrames = Math.max(1,
      secondsToDisplayFrames((Number(layer?.durationOffset) || 0) + (Number(layer?.duration) || 0), framesPerSecond)
      - secondsToDisplayFrames(layer?.durationOffset, framesPerSecond));

  return {
    startFrame,
    endFrame: startFrame + durationFrames,
  };
}

export function getLayerDisplayFrameRanges(layers, framesPerSecond = STUDIO_DISPLAY_FRAMES_PER_SECOND) {
  if (!Array.isArray(layers)) {
    return [];
  }

  let previousEndTime = 0;
  return layers.map((layer) => {
    const rawOffset = layer?.durationOffset;
    const hasExplicitOffset = rawOffset !== undefined
      && rawOffset !== null && rawOffset !== '' && Number.isFinite(Number(rawOffset));
    const configuredStartTime = hasExplicitOffset ? Math.max(0, Number(rawOffset)) : previousEndTime;
    // Insertions can expose stale offsets briefly; retain monotonic scene ordering.
    const startTime = Math.max(previousEndTime, configuredStartTime);
    const endTime = startTime + Math.max(0, Number(layer?.duration) || 0);
    const startFrame = secondsToDisplayFrames(startTime, framesPerSecond);
    const endFrame = Math.max(startFrame + 1, secondsToDisplayFrames(endTime, framesPerSecond));
    previousEndTime = endTime;
    return { startFrame, endFrame };
  });
}

export function findLayerIndexAtDisplayFrame(layers, displayFrame, framesPerSecond = STUDIO_DISPLAY_FRAMES_PER_SECOND) {
  if (!Array.isArray(layers) || layers.length === 0) {
    return -1;
  }

  const resolvedFrame = Math.max(0, Number(displayFrame) || 0);
  const layerRanges = getLayerDisplayFrameRanges(layers, framesPerSecond);
  const exactLayerIndex = layerRanges.findIndex(({ startFrame, endFrame }) => {
    return resolvedFrame >= startFrame && resolvedFrame < endFrame;
  });
  if (exactLayerIndex >= 0) {
    return exactLayerIndex;
  }

  for (let index = layers.length - 1; index >= 0; index -= 1) {
    if (resolvedFrame >= layerRanges[index].startFrame) {
      return index;
    }
  }

  return 0;
}

export function resolveLayerSelectionAtDisplayFrame(
  layers,
  displayFrame,
  currentLayerId = null,
  framesPerSecond = STUDIO_DISPLAY_FRAMES_PER_SECOND
) {
  const activeLayerIndex = findLayerIndexAtDisplayFrame(layers, displayFrame, framesPerSecond);
  const activeLayer = activeLayerIndex >= 0 ? layers[activeLayerIndex] : null;
  const activeLayerId = activeLayer?._id?.toString?.()
    || activeLayer?._id
    || activeLayer?.id?.toString?.()
    || activeLayer?.id
    || null;
  const normalizedCurrentLayerId = currentLayerId?.toString?.() || currentLayerId || null;

  return {
    activeLayer,
    activeLayerId,
    activeLayerIndex,
    shouldUpdate: Boolean(activeLayer && activeLayerId !== normalizedCurrentLayerId),
  };
}

export function resolveTimelineDuration(layers, sessionDetails = {}) {
  const explicitDuration = Number(sessionDetails?.totalDuration ?? sessionDetails?.duration);
  if (Number.isFinite(explicitDuration) && explicitDuration > 0) {
    return explicitDuration;
  }

  const sessionLayers = Array.isArray(layers) ? layers : [];
  let previousEndTime = 0;

  sessionLayers.forEach((layer) => {
    const rawOffset = layer?.durationOffset;
    const hasExplicitOffset = rawOffset !== undefined
      && rawOffset !== null
      && rawOffset !== ''
      && Number.isFinite(Number(rawOffset));
    const configuredStartTime = hasExplicitOffset
      ? Math.max(0, Number(rawOffset))
      : previousEndTime;
    const startTime = Math.max(previousEndTime, configuredStartTime);
    previousEndTime = startTime + Math.max(0, Number(layer?.duration) || 0);
  });

  return previousEndTime;
}
