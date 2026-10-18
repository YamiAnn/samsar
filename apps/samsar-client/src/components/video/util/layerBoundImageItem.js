const VISUAL_TRACK_FRAMES_PER_SECOND = 30;

function toFiniteNumber(value) {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function getLayerBoundImageTiming(layer = {}, framesPerSecond = VISUAL_TRACK_FRAMES_PER_SECOND) {
  const startTime = Math.max(0, toFiniteNumber(layer?.durationOffset) ?? 0);
  const durationSeconds = Math.max(
    1 / framesPerSecond,
    toFiniteNumber(layer?.duration) ?? 0
  );
  const startFrame = Math.max(0, Math.round(startTime * framesPerSecond));
  const durationFrames = Math.max(
    1,
    Math.round((startTime + durationSeconds) * framesPerSecond) - startFrame
  );
  const endFrame = startFrame + durationFrames;

  return {
    startFrame,
    endFrame,
    startTime,
    endTime: startTime + durationSeconds,
    durationFrames,
  };
}

export function createLayerBoundImageItem({
  layer,
  framesPerSecond = VISUAL_TRACK_FRAMES_PER_SECOND,
  config,
  startFrame,
  endFrame,
  startTime,
  endTime,
  ...item
}) {
  const layerTiming = getLayerBoundImageTiming(layer, framesPerSecond);
  const resolvedStartFrame = Math.max(
    0,
    Math.round(toFiniteNumber(startFrame) ?? layerTiming.startFrame)
  );
  const resolvedEndFrame = Math.max(
    resolvedStartFrame + 1,
    Math.round(toFiniteNumber(endFrame) ?? layerTiming.endFrame)
  );
  const resolvedStartTime =
    toFiniteNumber(startTime) ?? resolvedStartFrame / framesPerSecond;
  const resolvedEndTime = Math.max(
    resolvedStartTime + (1 / framesPerSecond),
    toFiniteNumber(endTime) ?? resolvedEndFrame / framesPerSecond
  );
  const existingConfig = config && typeof config === 'object' ? config : {};
  const configuredRate = Number(existingConfig.frameRate || existingConfig.framesPerSecond);
  const sourceRate = configuredRate > 0 ? configuredRate : framesPerSecond;
  const sourceOffset = toFiniteNumber(existingConfig.frameOffset);
  const sourceDuration = toFiniteNumber(existingConfig.frameDuration);
  const nativeOffset = sourceOffset === null ? null : Math.round(sourceOffset * framesPerSecond / sourceRate);
  const nativeDuration = sourceDuration === null ? null
    : Math.round(((sourceOffset ?? 0) + sourceDuration) * framesPerSecond / sourceRate) - (nativeOffset ?? 0);

  return {
    ...item,
    type: 'image',
    startFrame: resolvedStartFrame,
    endFrame: resolvedEndFrame,
    startTime: resolvedStartTime,
    endTime: resolvedEndTime,
    config: {
      ...existingConfig,
      frameRate: framesPerSecond,
      frameOffset: Math.max(
        0,
        Math.round(
          nativeOffset ??
            (resolvedStartFrame - layerTiming.startFrame)
        )
      ),
      frameDuration: Math.max(
        1,
        Math.round(
          nativeDuration ??
            (resolvedEndFrame - resolvedStartFrame)
        )
      ),
    },
  };
}
