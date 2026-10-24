function sceneIndex(value) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    value = Number(value);
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Narrative identity must survive copies and timeline edits. Never infer it from
// connectedLayerIndex, which describes the current timeline position.
export function getSourceSceneMetadata(layer = {}) {
  const reference = [layer.sourceSceneRef, layer.imageSession?.sourceSceneRef]
    .find((value) => value && typeof value === 'object' && !Array.isArray(value));
  const sourceSceneIndex = [reference?.sceneIndex, layer.sourceSceneIndex, layer.imageSession?.sourceSceneIndex]
    .map(sceneIndex)
    .find((value) => value !== null);
  return {
    ...(sourceSceneIndex !== undefined ? { sourceSceneIndex } : {}),
    ...(reference ? { sourceSceneRef: JSON.parse(JSON.stringify(reference)) } : {}),
  };
}
