import Konva from 'konva';

// Define the custom glitch filter
Konva.Filters.CustomGlitch = function(imageData) {
  const data = imageData.data;
  const width = imageData.width;
  const height = imageData.height;

  // Parameters for glitch effect
  const shiftAmount = 10; // Maximum pixels to shift
  const sliceHeight = 5;  // Height of each glitch slice

  // Apply glitch effect by shifting random horizontal slices
  for (let y = 0; y < height; y += sliceHeight) {
    if (Math.random() < 0.1) { // 10% chance to glitch this slice
      const shift = Math.round((Math.random() - 0.5) * 2 * shiftAmount);
      const sliceEnd = Math.min(y + sliceHeight, height);
      // Keep the source intact while writing overlapping destinations. Copy
      // only this slice so large canvases do not require a second full image.
      const sourceData = data.slice(y * width * 4, sliceEnd * width * 4);
      for (let row = y; row < sliceEnd; row++) {
        for (let x = 0; x < width; x++) {
          const sourceIndex = ((row - y) * width + x) * 4;
          const shiftedX = x + shift;
          if (shiftedX >= 0 && shiftedX < width) {
            const destIndex = (row * width + shiftedX) * 4;
            data[destIndex] = sourceData[sourceIndex];
            data[destIndex + 1] = sourceData[sourceIndex + 1];
            data[destIndex + 2] = sourceData[sourceIndex + 2];
            data[destIndex + 3] = sourceData[sourceIndex + 3];
          }
        }
      }
    }
  }
};

export function applyGlitchEffect(node) {
  // Ensure the node is cached for filters to work
  if (!node.isCached()) {
    node.cache();
  }

  // Set the custom glitch filter
  node.filters([Konva.Filters.CustomGlitch]);

  // Optionally adjust filter parameters based on `params` and `t`
  // Currently, the filter doesn't accept parameters, but you can modify it to do so

  // Redraw the layer to apply the filter
  node.getLayer().batchDraw();
}
