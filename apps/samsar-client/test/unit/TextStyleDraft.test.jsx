import { describe, expect, it } from 'vitest';
import {
  buildTextStyleDraft, mapTextDraftToConfig, mapTextDraftToStyleConfig, mapTextItemToDraft,
  loadStoredTextStyleConfig, persistTextStyleConfig,
} from '../../src/components/common/TextStylePanel.jsx';

describe('canvas text styles', () => {
  it('provides renderable defaults for missing styles', () => {
    expect(buildTextStyleDraft()).toMatchObject({ text: '', width: 600, height: 200,
      fontSize: 32, fontFamily: 'Arial', textAlign: 'center', lineHeight: 1.2,
      autoWrap: true, fillColor: '#ffffff', strokeWidth: 0 });
  });

  it.each([
    ['fontSize', -4, 1], ['fontSize', 500, 240], ['fontSize', '12.9', 12],
    ['width', 2, 24], ['width', 9000, 4096], ['height', -5, 24], ['height', 5000, 4096],
    ['strokeWidth', -1, 0], ['strokeWidth', 41, 40],
    ['lineHeight', 0.1, 0.6], ['lineHeight', 10, 3],
    ['letterSpacing', -90, -20], ['letterSpacing', 900, 100],
    ['shadowBlur', -1, 0], ['shadowBlur', 500, 100],
    ['shadowOffsetX', -300, -200], ['shadowOffsetX', 300, 200],
    ['shadowOffsetY', -300, -200], ['shadowOffsetY', 300, 200],
    ['rotationAngle', -999, -360], ['rotationAngle', 999, 360],
  ])('normalizes %s=%s to the canvas-supported bound %s', (field, input, expected) => {
    expect(buildTextStyleDraft({ [field]: input })[field]).toBe(expected);
  });

  it.each(['fontSize', 'width', 'height', 'strokeWidth', 'lineHeight', 'letterSpacing', 'shadowBlur', 'rotationAngle'])
    ('falls back for nonnumeric %s', field => {
      expect(buildTextStyleDraft({ [field]: 'invalid' })[field]).toBe(buildTextStyleDraft()[field]);
    });

  it.each(['#fff', '#ABC123', '#012345'])('accepts valid canvas color %s', fillColor => {
    expect(buildTextStyleDraft({ fillColor, strokeColor: fillColor })).toMatchObject({ fillColor, strokeColor: fillColor });
  });

  it.each(['red', '#ggg', '#12', '', null])('replaces unsupported canvas color %s', fillColor => {
    expect(buildTextStyleDraft({ fillColor, strokeColor: fillColor })).toMatchObject({ fillColor: '#ffffff', strokeColor: '#ffffff' });
  });

  it('normalizes invalid alignments and empty fonts, keeps numeric text and explicit false wrapping', () => {
    expect(buildTextStyleDraft({ text: 123, textAlign: 'justify', fontFamily: '  ', autoWrap: false }))
      .toMatchObject({ text: '123', textAlign: 'center', fontFamily: 'Arial', autoWrap: false });
  });

  it('does not mutate the incoming draft and excludes text from reusable style config', () => {
    const source = Object.freeze({ text: 'Caption', bold: true, fontSize: 64 });
    const style = mapTextDraftToStyleConfig(source);
    expect(style).toMatchObject({ bold: true, fontSize: 64 });
    expect(style).not.toHaveProperty('text');
    expect(mapTextDraftToConfig(source)).toMatchObject(source);
    expect(source).toEqual({ text: 'Caption', bold: true, fontSize: 64 });
  });

  it('loads text and nested configuration from a canvas item', () => {
    expect(mapTextItemToDraft({ text: 'Hello', config: { width: 100, italic: true } }))
      .toMatchObject({ text: 'Hello', width: 100, italic: true });
    expect(mapTextItemToDraft(null)).toMatchObject({ text: '', fontSize: 32 });
  });

  it('leaves absent stored preferences absent rather than overwriting project settings', () => {
    expect(loadStoredTextStyleConfig()).toEqual({});
  });

  it('roundtrips every shared style field, preserving false and zero values', () => {
    const draft = buildTextStyleDraft({ text: 'Do not persist me', width: 812, height: 467, fontSize: 48,
      fontFamily: 'Georgia', fillColor: '#aabbcc', strokeColor: '#112233', strokeWidth: 0,
      bold: false, italic: true, underline: true, textAlign: 'left', lineHeight: 1.6,
      autoWrap: false, letterSpacing: -2, shadowBlur: 0, shadowOffsetX: -5,
      shadowOffsetY: 0, rotationAngle: -45, capitalizeLetters: true });
    persistTextStyleConfig(draft);
    expect(loadStoredTextStyleConfig()).toEqual(mapTextDraftToStyleConfig(draft));
    expect(localStorage.getItem('selected_text_config_text')).toBeNull();
  });

  it('ignores malformed stored booleans and alignments while clamping numeric preferences', () => {
    const stored = {
      fontSize: 'invalid', width: '-4', height: '99999', fillColor: 'red', strokeColor: '#123',
      strokeWidth: '90', bold: 'yes', italic: 'false', underline: 'true', textAlign: 'justify',
      lineHeight: '99', autoWrap: 'false', letterSpacing: '-90', shadowBlur: '-2',
      shadowOffsetX: '-999', shadowOffsetY: '999', rotationAngle: '999', capitalizeLetters: 'unknown',
    };
    Object.entries(stored).forEach(([field, value]) => localStorage.setItem(`selected_text_config_${field}`, value));
    expect(loadStoredTextStyleConfig()).toEqual({ fontSize: 32, width: 24, height: 4096,
      fillColor: '#ffffff', strokeColor: '#123', strokeWidth: 40, italic: false, underline: true,
      lineHeight: 3, autoWrap: false, letterSpacing: -20, shadowBlur: 0,
      shadowOffsetX: -200, shadowOffsetY: 200, rotationAngle: 360 });
  });

  it('supports an injected storage object without touching browser preferences', () => {
    const data = new Map();
    const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
    persistTextStyleConfig({ fontSize: 80, textAlign: 'right' }, storage);
    expect(loadStoredTextStyleConfig(storage)).toMatchObject({ fontSize: 80, textAlign: 'right' });
    expect(localStorage.length).toBe(0);
  });
});
