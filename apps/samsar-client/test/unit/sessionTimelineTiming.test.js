import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHintsText, buildSpeechTranscriptHintRows, buildTranscriptText, normalizeSessionId, normalizeTimelineHints } from '../../src/utils/sessionTimelineText.js';

const subtitle = (text, offset = 0, duration = 30, extra = {}) => ({
  type: 'text', subType: 'subtitle', text, config: { frameOffset: offset, frameDuration: duration }, ...extra,
});
const scene = (items, durationOffset = 0) => ({ durationOffset, imageSession: { activeItemList: items } });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-20T06:53:00.000Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('session transcript export', () => {
  it.each([[' id ', 'id'], [null, ''], [undefined, ''], [123, '123'], [{ toString: () => 'object-id' }, 'object-id'], [Object.create(null), '']])('normalizes session identifiers %j', (input, expected) => {
    expect(normalizeSessionId(input)).toBe(expected);
  });

  it('exports normalized subtitle text on the session frame clock with linked speaker metadata', () => {
    const text = buildTranscriptText({ _id: ' project ', framesPerSecond: 24,
      audioLayers: [{ _id: 'voice', speakerCharacterName: 'Narrator' }],
      layers: [scene([subtitle(' Hello\n world ', 12, 24, { audioLayerId: 'voice' })], 2)],
    });
    expect(text).toBe('Samsar session transcript\nSession: project\nGenerated: 2026-10-20T06:53:00.000Z\n\n[00:00:02.500 - 00:00:03.500] Narrator: Hello world\n');
  });

  it('merges neighboring repeated subtitle runs for one voice but preserves a different voice and gaps', () => {
    const text = buildTranscriptText({ framesPerSecond: 30,
      audioLayers: [{ _id: 'a', speaker: 'A' }, { _id: 'b', actor: 'B' }],
      layers: [scene([
        subtitle('same', 0, 30, { audioLayerId: 'a' }),
        subtitle('same', 32, 28, { audioLayerId: 'a' }),
        subtitle('same', 90, 30, { audioLayerId: 'a' }),
        subtitle('same', 120, 30, { audioLayerId: 'b' }),
      ])],
    });
    expect(text).toContain('[00:00:00.000 - 00:00:02.000] A: same');
    expect(text).toContain('[00:00:03.000 - 00:00:04.000] A: same');
    expect(text).toContain('[00:00:04.000 - 00:00:05.000] B: same');
    expect(text.match(/\[00:/g)).toHaveLength(3);
  });

  it('prefers subtitle rows over speech prompts and supports normalized/config text plus an item speaker override', () => {
    const text = buildTranscriptText({ id: 42, framesPerSecond: 'bad',
      audioLayers: [{ _id: 'voice', generationType: 'speech', prompt: 'fallback should not appear', speaker: 'Default' }],
      layers: [{ startTime: 1, imageSession: { activeItemList: [
        { type: 'image', text: 'excluded' }, subtitle('   '),
        subtitle('', 0, 24, { normalizedText: ' Normalized  text ', speaker: 'Override' }),
        subtitle('', 24, 0, { config: { text: 'Config text', frameOffset: 24, frameDuration: 0 }, speaker: 'Override' }),
      ] } }],
    });
    expect(text).toContain('Session: 42');
    expect(text).toContain('[00:00:01.000 - 00:00:02.000] Override: Normalized text');
    expect(text).toContain('[00:00:02.000 - 00:00:02.042] Override: Config text');
    expect(text).not.toContain('fallback should not appear');
    expect(text).not.toContain('excluded');
  });

  it('falls back to sorted speech prompts, selecting explicit ends before durations and skipping non-speech', () => {
    const text = buildTranscriptText({ layers: [null, {}], audioLayers: [
      { id: 'late', generationType: 'SPEECH', startTime: 3661.1235, endTime: 3663, duration: 20, prompt: ' Late\n sentence ', actor: 'Actor' },
      { _id: { toString: () => 'early' }, generationType: 'speech', startTime: -1, endTime: -1, duration: 2, prompt: 'Early' },
      { generationType: 'music', prompt: 'Music excluded' },
      { generationType: null, prompt: 'Unknown excluded' },
      { generationType: 'speech', prompt: '  ' },
    ] });
    expect(text).toBe('Samsar session transcript\nSession: -\nGenerated: 2026-10-20T06:53:00.000Z\n\n[00:00:00.000 - 00:00:02.000] Early\n[01:01:01.124 - 01:01:03.000] Actor: Late sentence\n');
  });

  it.each([{}, { layers: 'invalid', audioLayers: null }, { layers: [{ imageSession: { activeItemList: null } }] }])('returns no file when there is no transcript content %j', (session) => {
    expect(buildTranscriptText(session)).toBeNull();
  });

  it('exports subtitle items even when their linked audio layer is unavailable', () => {
    const text = buildTranscriptText({ framesPerSecond: 30,
      layers: [scene([subtitle('Standalone caption', 0, 30, { audioLayerId: 'removed-audio-layer' })])],
    });
    expect(text).toContain('[00:00:00.000 - 00:00:01.000] Standalone caption');
  });

  it('exports standalone subtitle items without an audioLayerId', () => {
    expect(buildTranscriptText({ framesPerSecond: 30, layers: [scene([subtitle('Standalone caption')])] }))
      .toContain('[00:00:00.000 - 00:00:01.000] Standalone caption');
  });
});

describe('word-aligned transcript hints', () => {
  it('normalizes word aliases, rejects invalid timestamps, sorts, and offsets alignment to its audio layer', () => {
    const rows = buildSpeechTranscriptHintRows({ audioLayers: [{ id: 'a', startTime: 10, speaker: 'N', transcriptAlignment: { words: [
      { text: ' world ', start: 0.4, end: 0.8 }, { word: ' Hello ', start: 0, end: 0.3 },
      { alignedWord: 'again', start: 2, end: 2.5 }, { word: '', start: 3, end: 4 },
      { word: 'bad', start: 'bad', end: 4 }, { word: 'backwards', start: 3, end: 2 },
    ] } }] });
    expect(rows).toMatchObject([
      { startTime: 10, endTime: 10.8, text: 'Hello world', audioLayerId: 'a', speaker: 'N' },
      { startTime: 12, endTime: 12.5, duration: 0.5, text: 'again', audioLayerId: 'a', speaker: 'N' },
    ]);
    expect(rows[0].duration).toBeCloseTo(0.8);
  });

  it('splits alignment after ten words and after four seconds', () => {
    const tenWords = Array.from({ length: 11 }, (_, i) => ({ word: `w${i}`, start: i / 10, end: (i + 1) / 10 }));
    const rows = buildSpeechTranscriptHintRows({ audioLayers: [
      { id: 'a', startTime: 0, transcriptAlignment: { words: tenWords } },
      { id: 'b', startTime: 10, transcriptAlignment: { words: [
        { word: 'long', start: 0, end: 4 }, { word: 'next', start: 4, end: 5 },
      ] } },
    ] });
    expect(rows.map(({ text }) => text)).toEqual(['w0 w1 w2 w3 w4 w5 w6 w7 w8 w9', 'w10', 'long', 'next']);
    expect(rows[3].startTime).toBe(14);
  });

  it('uses the longest overlapping word end and prefers any real alignment over prompt fallbacks', () => {
    const rows = buildSpeechTranscriptHintRows({ audioLayers: [
      { generationType: 'speech', prompt: 'fallback excluded', duration: 10 },
      { startTime: 'bad', transcriptAlignment: { words: [
        { word: 'overlap', start: 0, end: 1 }, { word: 'short', start: 0.1, end: 0.2 },
      ] } },
    ] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ startTime: 0, endTime: 1, text: 'overlap short', audioLayerId: null });
  });

  it('falls back to speech prompts with at least one native frame when alignment is absent', () => {
    const rows = buildSpeechTranscriptHintRows({ audioLayers: [
      { id: 'last', generationType: 'speech', startTime: 4, endTime: 6, prompt: ' last ', speakerCharacterName: 'X' },
      { id: 'first', generationType: 'SPEECH', startTime: -1, duration: -2, prompt: ' first ' },
      { generationType: 'music', prompt: 'excluded' },
      { generationType: 'speech', prompt: '' },
    ] });
    expect(rows).toEqual([
      { startTime: 0, endTime: 1 / 30, duration: 1 / 30, text: 'first', audioLayerId: 'first', speaker: '' },
      { startTime: 4, endTime: 6, duration: 2, text: 'last', audioLayerId: 'last', speaker: 'X' },
    ]);
    expect(buildSpeechTranscriptHintRows({ audioLayers: 'bad' })).toEqual([]);
  });
});

describe('timeline hint normalization and export', () => {
  it('normalizes aliases, IDs, whitespace and duration, and sorts without mutating the input', () => {
    const hints = [
      { _id: ' late ', content: ' Some\n detail ', start: 4, end: 6, speaker: 'Narrator', extra: true },
      { text: 'Early', startTime: -1, duration: 2 },
      { text: '   ' },
      { text: 'Default duration', startTime: 'bad' },
    ];
    expect(normalizeTimelineHints(hints)).toEqual([
      { text: 'Early', startTime: 0, duration: 2, id: 'hint_1', endTime: 2, speaker: '' },
      { text: 'Default duration', startTime: 0, duration: 1, id: 'hint_3', endTime: 1, speaker: '' },
      { _id: ' late ', content: ' Some\n detail ', start: 4, end: 6, speaker: 'Narrator', extra: true,
        id: 'late', text: 'Some detail', startTime: 4, duration: 2, endTime: 6 },
    ]);
    expect(hints[0].content).toBe(' Some\n detail ');
  });

  it('clamps hints to the video end and enforces a minimum visible duration', () => {
    const rows = normalizeTimelineHints([
      { id: 'a', text: 'Past end', startTime: 20, endTime: 30 },
      { id: 'b', text: 'Too short', startTime: 1, endTime: 1.01 },
      { id: 'c', text: 'Backwards', startTime: 2, endTime: 1, duration: -4 },
    ], { totalDuration: 5, minimumDuration: 0.5 });
    expect(rows.map(({ id, startTime, endTime }) => ({ id, startTime, endTime }))).toEqual([
      { id: 'b', startTime: 1, endTime: 1.5 }, { id: 'c', startTime: 2, endTime: 2.5 }, { id: 'a', startTime: 4.5, endTime: 5 },
    ]);
  });

  it('ignores malformed lists and handles invalid numeric settings using defaults', () => {
    expect(normalizeTimelineHints(null)).toEqual([]);
    expect(normalizeTimelineHints('bad')).toEqual([]);
    expect(normalizeTimelineHints([null, { text: 123, startTime: Infinity, duration: Infinity }], { totalDuration: 'bad', minimumDuration: 'bad' }))
      .toEqual([{ text: '123', startTime: 0, duration: 1, id: 'hint_1', endTime: 1, speaker: '' }]);
  });

  it('exports ordered hints with exact timestamps and preserves a trailing newline', () => {
    expect(buildHintsText({ _id: 'p', hints: [{ text: 'Note', start: 60, duration: 1.125, speaker: 'Director' }] }))
      .toBe('Samsar session hints\nSession: p\nGenerated: 2026-10-20T06:53:00.000Z\n\n[00:01:00.000 - 00:01:01.125] Director: Note\n');
    expect(buildHintsText({ timelineHints: [{ text: 'First', start: 0, duration: 1 }] })).toContain('Session: -');
    expect(buildHintsText()).toBeNull();
  });
});
