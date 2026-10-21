// Scenes keep readable minimum rows; gaps and scene intervals still occupy the
// same time domain. Every ruler, lane and pointer uses these exact segments.
export function buildTimelineViewportGeometry(metadata, frameRange, height, minimumSceneHeight = 20) {
  const frameStart = Math.max(0, Math.round(frameRange[0]));
  const frameEnd = Math.max(frameStart + 1, Math.round(frameRange[1]));
  const totalPixels = Math.max(0, Math.floor(Number(height) || 0));
  const records = [];
  let cursor = frameStart;
  for (const meta of metadata) {
    const start = Math.max(cursor, frameStart, meta.startFrame);
    const end = Math.min(frameEnd, meta.endFrame);
    if (end <= start) continue;
    if (start > cursor) records.push({ kind: 'gap', layerId: null, frameStart: cursor, frameEnd: start });
    records.push({ kind: 'scene', layerId: String(meta.layer?._id || meta.originalIndex), frameStart: start, frameEnd: end });
    cursor = end;
  }
  if (cursor < frameEnd) records.push({ kind: 'gap', layerId: null, frameStart: cursor, frameEnd });
  const sceneCount = records.filter(record => record.kind === 'scene').length;
  const baseHeight = Math.min(minimumSceneHeight, totalPixels / Math.max(1, sceneCount));
  const distributable = Math.max(0, totalPixels - sceneCount * baseHeight);
  let rawPixelEnd = 0;
  let pixelEnd = 0;
  const segments = records.map(record => {
    const pixelStart = pixelEnd;
    rawPixelEnd += (record.kind === 'scene' ? baseHeight : 0)
      + distributable * (record.frameEnd - record.frameStart) / (frameEnd - frameStart);
    pixelEnd = Math.min(totalPixels, Math.round(rawPixelEnd));
    return { ...record, pixelStart, pixelEnd, pixelHeight: pixelEnd - pixelStart };
  });
  return { segments, totalPixels, frameStart, frameEnd };
}
