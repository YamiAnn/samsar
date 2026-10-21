import { describe, expect, it, vi } from 'vitest';
import { captureStageCanvas, captureAssistantStageImageData } from '../../src/utils/assistantFrameCapture.js';

function makeNode(id, initialVisible = true) {
  let visible = initialVisible;
  return {
    id: () => id,
    visible: vi.fn((next) => {
      if (next !== undefined) visible = next;
      return visible;
    }),
  };
}

function makeStage() {
  const transformer = makeNode('transformer');
  const mask = makeNode('maskGroup', false);
  const pencil = makeNode('pencilGroup');
  const box = makeNode('bbox_rect_7');
  const image = makeNode('image');
  const anonymous = { visible: vi.fn(() => true) };
  const canvas = { width: 800, height: 600, toDataURL: vi.fn(() => 'data:image/png;base64,original') };
  const stage = {
    find: vi.fn((selector) => {
      if (typeof selector === 'function') return [transformer, mask, pencil, box, image, anonymous].filter(selector);
      return { Transformer: [transformer], '#maskGroup': [mask], '#pencilGroup': [pencil], '#bbox_rect_7': [box] }[selector] || [];
    }),
    draw: vi.fn(),
    toCanvas: vi.fn(async () => {
      expect([transformer, mask, pencil, box].map((node) => node.visible())).toEqual([false, false, false, false]);
      expect(image.visible()).toBe(true);
      return canvas;
    }),
  };
  return { stage, transformer, mask, pencil, box, image, canvas };
}

describe('assistant frame capture', () => {
  it.each([undefined, null, {}, { current: null }])('handles a missing stage %j', async (ref) => {
    expect(await captureStageCanvas(ref)).toBeNull();
    expect(await captureAssistantStageImageData(ref)).toBeNull();
  });

  it('excludes editing overlays from capture and restores original node visibility', async () => {
    const fixture = makeStage();
    expect(await captureStageCanvas({ current: fixture.stage }, { pixelRatio: 2 })).toBe(fixture.canvas);
    expect(fixture.stage.toCanvas).toHaveBeenCalledWith({ pixelRatio: 2 });
    expect([fixture.transformer, fixture.mask, fixture.pencil, fixture.box].map((node) => node.visible()))
      .toEqual([true, false, true, true]);
    expect(fixture.stage.draw).toHaveBeenCalledOnce();
  });

  it('unwraps React-Konva stage references', async () => {
    const fixture = makeStage();
    const getStage = vi.fn(() => fixture.stage);
    expect(await captureStageCanvas({ current: { getStage } })).toBe(fixture.canvas);
    expect(getStage).toHaveBeenCalledOnce();
  });

  it('restores overlays after asynchronous canvas export rejects', async () => {
    const fixture = makeStage();
    fixture.stage.toCanvas.mockRejectedValue(new Error('Tainted canvas'));
    await expect(captureStageCanvas({ current: fixture.stage })).rejects.toThrow('Tainted canvas');
    expect(fixture.transformer.visible()).toBe(true);
    expect(fixture.mask.visible()).toBe(false);
    expect(fixture.box.visible()).toBe(true);
    expect(fixture.stage.draw).toHaveBeenCalledOnce();
  });

  it('supports custom overlay selectors and always hides bounding boxes', async () => {
    const fixture = makeStage();
    fixture.stage.toCanvas.mockImplementation(async () => {
      expect(fixture.transformer.visible()).toBe(true);
      expect(fixture.pencil.visible()).toBe(true);
      expect(fixture.box.visible()).toBe(false);
      return fixture.canvas;
    });
    await captureStageCanvas({ current: fixture.stage }, { hideSelectors: [] });
    expect(fixture.stage.find).toHaveBeenCalledTimes(1);
    expect(fixture.box.visible()).toBe(true);
  });

  it('restores a node once when it matches both a selector and the bounding-box filter', async () => {
    const fixture = makeStage();
    fixture.stage.toCanvas.mockResolvedValue(fixture.canvas);
    await captureStageCanvas({ current: fixture.stage }, { hideSelectors: ['#bbox_rect_7'] });
    expect(fixture.box.visible()).toBe(true);
  });

  it('returns a PNG directly when no resizing is necessary', async () => {
    const fixture = makeStage();
    expect(await captureAssistantStageImageData({ current: fixture.stage }))
      .toBe('data:image/png;base64,original');
    expect(fixture.canvas.toDataURL).toHaveBeenCalledWith('image/png');
  });

  it.each([
    [3000, 1500, 1500, 750],
    [1000, 4000, 375, 1500],
  ])('resizes a %sx%s frame proportionally before export', async (width, height, outputWidth, outputHeight) => {
    const fixture = makeStage();
    fixture.canvas.width = width;
    fixture.canvas.height = height;
    const drawImage = vi.fn();
    const scaled = { width: 0, height: 0, getContext: vi.fn(() => ({ drawImage })), toDataURL: vi.fn(() => 'data:image/png;base64,scaled') };
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag, options) => tag === 'canvas' ? scaled : originalCreateElement(tag, options));
    expect(await captureAssistantStageImageData({ current: fixture.stage }, { maxDimension: 1500 }))
      .toBe('data:image/png;base64,scaled');
    expect(scaled.width).toBe(outputWidth);
    expect(scaled.height).toBe(outputHeight);
    expect(drawImage).toHaveBeenCalledWith(fixture.canvas, 0, 0, outputWidth, outputHeight);
    expect(scaled.toDataURL).toHaveBeenCalledWith('image/png');
    expect(fixture.canvas.toDataURL).not.toHaveBeenCalled();
  });

  it('handles a zero-sized frame with the browser export behavior', async () => {
    const fixture = makeStage();
    fixture.canvas.width = fixture.canvas.height = 0;
    await captureAssistantStageImageData({ current: fixture.stage });
    expect(fixture.canvas.toDataURL).toHaveBeenCalledWith('image/png');
  });
});
