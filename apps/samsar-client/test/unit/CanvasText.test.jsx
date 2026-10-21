import { describe, expect, it, vi } from 'vitest';
import { getTextConfigForCanvas, normalizeActiveTextItemListForCanvas } from '../../src/constants/TextConfig.jsx';
import { drawCanvasTextItem } from '../../src/utils/canvasText.js';

function makeContext() {
  return Object.fromEntries([
    'save', 'restore', 'setTransform', 'translate', 'rotate', 'beginPath', 'rect', 'clip',
    'strokeText', 'fillText', 'moveTo', 'lineTo', 'stroke',
  ].map((key) => [key, vi.fn()]).concat([
    ['measureText', vi.fn((text) => ({ width: Array.from(text).length * 10 }))],
  ]));
}

describe('persisted canvas text configuration', () => {
  it('sizes and centers text defaults on the current canvas', () => {
    expect(getTextConfigForCanvas({}, { width: 320, height: 480 }))
      .toMatchObject({ x: 160, y: 240, width: 240, height: 120, fontSize: 32, textAlign: 'center' });
    expect(getTextConfigForCanvas({}, { width: 2000, height: 2000 }))
      .toMatchObject({ x: 1000, y: 1000, width: 600, height: 220 });
  });

  it('repairs malformed numeric fields and clamps geometry and effects to safe minima', () => {
    expect(getTextConfigForCanvas({
      x: 'bad', y: Infinity, width: -4, height: 0, fontSize: -1, fontFamily: ' ',
      strokeWidth: -3, shadowBlur: -1, textAlign: 'justify', fillColor: 'red', strokeColor: '#zzzzzz',
      lineHeight: -1, letterSpacing: 'bad', shadowOffsetX: 'bad', shadowOffsetY: Infinity,
      rotationAngle: 'bad',
    })).toMatchObject({
      x: 512, y: 512, width: 1, height: 1, fontSize: 1, fontFamily: 'Arial',
      strokeWidth: 0, shadowBlur: 0, textAlign: 'center', fillColor: '#ffffff', strokeColor: '#ffffff',
      lineHeight: 0.1, letterSpacing: 0, shadowOffsetX: 0, shadowOffsetY: 2, rotationAngle: 0,
    });
  });

  it('retains supported styling and finite negative offsets', () => {
    expect(getTextConfigForCanvas({
      x: '12.5', y: -3, width: '50', height: '20', fontSize: '17', fontFamily: 'Noto Sans Bengali',
      fillColor: '#abc', strokeColor: '#Ab12Cd', textAlign: 'right', letterSpacing: -2,
      shadowOffsetX: -5, shadowOffsetY: -7, rotationAngle: -90, autoWrap: false, capitalizeLetters: 1,
    })).toMatchObject({
      x: 12.5, y: -3, width: 50, height: 20, fontSize: 17, fontFamily: 'Noto Sans Bengali',
      fillColor: '#abc', strokeColor: '#Ab12Cd', textAlign: 'right', letterSpacing: -2,
      shadowOffsetX: -5, shadowOffsetY: -7, rotationAngle: -90, autoWrap: false, capitalizeLetters: true,
    });
    expect(getTextConfigForCanvas({ fontFamily: 32, autoWrap: null }).autoWrap).toBe(true);
  });

  it('normalizes only text items, preserving image identity and caller data', () => {
    const image = { id: 'image', type: 'image' };
    const text = { id: 'title', type: 'text', text: 'Title', config: { fontSize: 42 } };
    const input = [null, image, text];
    const result = normalizeActiveTextItemListForCanvas(input, { width: 640, height: 480 });
    expect(result[0]).toBeNull();
    expect(result[1]).toBe(image);
    expect(result[2]).toMatchObject({ id: 'title', text: 'Title', config: { fontSize: 42, x: 320, y: 240 } });
    expect(result[2]).not.toBe(text);
    expect(text.config).toEqual({ fontSize: 42 });
    expect(normalizeActiveTextItemListForCanvas(null, undefined, null)).toEqual([]);
  });

  it('merges fallback styling in the requested direction for a matching item id', () => {
    const text = [{ id: 'a', type: 'text', config: { fontSize: 40, fillColor: '#111111' } }];
    const fallback = [{ id: 'a', config: { fontSize: 20, bold: true } }];
    expect(normalizeActiveTextItemListForCanvas(text, undefined, fallback)[0].config)
      .toMatchObject({ fontSize: 40, bold: true, fillColor: '#111111' });
    expect(normalizeActiveTextItemListForCanvas(text, undefined, fallback, { preferFallbackTextConfig: true })[0].config)
      .toMatchObject({ fontSize: 20, bold: true, fillColor: '#111111' });
    expect(normalizeActiveTextItemListForCanvas([{ id: 'b', type: 'text' }], undefined, [null])[0].config.fontSize)
      .toBe(32);
  });
});

describe('canvas text drawing', () => {
  it.each([null, { type: 'image', text: 'x' }, { type: 'text', text: '' }, { type: 'text', text: ' \n ' }])
    ('does not draw a non-text or empty item %j', (item) => {
      const ctx = makeContext();
      drawCanvasTextItem(ctx, item);
      expect(ctx.save).not.toHaveBeenCalled();
      expect(() => drawCanvasTextItem(null, item)).not.toThrow();
    });

  it('clips in local coordinates, applies rotation, stroke and capitalization, then restores context', () => {
    const ctx = makeContext();
    drawCanvasTextItem(ctx, { type: 'text', text: 'hello', config: {
      x: 100, y: 80, width: 100, height: 50, fontSize: 20, fontFamily: 'Arial',
      bold: true, italic: true, capitalizeLetters: true, rotationAngle: 90,
      fillColor: '#123', strokeColor: '#456', strokeWidth: 2, autoWrap: false,
    } });
    expect(ctx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    expect(ctx.translate).toHaveBeenCalledWith(50, 55);
    expect(ctx.rotate).toHaveBeenCalledWith(Math.PI / 2);
    expect(ctx.rect).toHaveBeenCalledWith(0, 0, 100, 50);
    expect(ctx.font).toBe('italic bold 20px Arial');
    expect(ctx.strokeText).toHaveBeenCalledWith('HELLO', 50, 0);
    expect(ctx.fillText).toHaveBeenCalledWith('HELLO', 50, 0);
    expect(ctx.strokeText.mock.invocationCallOrder[0]).toBeLessThan(ctx.fillText.mock.invocationCallOrder[0]);
    expect(ctx.restore).toHaveBeenCalledOnce();
  });

  it('wraps at word boundaries and retains explicit empty paragraphs', () => {
    const ctx = makeContext();
    drawCanvasTextItem(ctx, { type: 'text', text: 'one two three\n\nfour', config: {
      width: 75, fontSize: 10, lineHeight: 1.5, textAlign: 'left',
    } });
    expect(ctx.fillText.mock.calls).toEqual([
      ['one two', 0, 0], ['three', 0, 15], ['', 0, 30], ['four', 0, 45],
    ]);
    expect(ctx.rotate).not.toHaveBeenCalled();
    expect(ctx.strokeText).not.toHaveBeenCalled();
  });

  it('does not wrap long words or collapse explicit lines when wrapping is disabled', () => {
    const ctx = makeContext();
    drawCanvasTextItem(ctx, { type: 'text', text: 'abc def\nlongword', config: {
      width: 20, fontSize: 10, autoWrap: false, textAlign: 'right',
    } });
    expect(ctx.fillText.mock.calls).toEqual([['abc def', 20, 0], ['longword', 20, 12]]);
  });

  it.each([
    ['left', 0], ['center', 39], ['right', 78],
  ])('spaces Unicode characters and aligns %s text using its measured extent', (textAlign, firstX) => {
    const ctx = makeContext();
    drawCanvasTextItem(ctx, { type: 'text', text: '😀a', config: {
      width: 100, height: 40, fontSize: 20, textAlign, letterSpacing: 2, underline: true, strokeWidth: 1,
    } });
    expect(ctx.fillText.mock.calls).toEqual([['😀', firstX, 0], ['a', firstX + 12, 0]]);
    expect(ctx.strokeText.mock.calls).toEqual([['😀', firstX, 0], ['a', firstX + 12, 0]]);
    expect(ctx.moveTo).toHaveBeenCalledWith(firstX, 22);
    expect(ctx.lineTo).toHaveBeenCalledWith(firstX + 22, 22);
    expect(ctx.textAlign).toBe(textAlign);
  });

  it('draws an underline for unspaced right-aligned text', () => {
    const ctx = makeContext();
    drawCanvasTextItem(ctx, { type: 'text', text: 'ab', config: {
      width: 100, fontSize: 10, underline: true, textAlign: 'right',
    } });
    expect(ctx.moveTo).toHaveBeenCalledWith(80, 12);
    expect(ctx.lineTo).toHaveBeenCalledWith(100, 12);
    expect(ctx.lineWidth).toBe(1);
  });
});
