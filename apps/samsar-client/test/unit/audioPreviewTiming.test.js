import { describe, expect, it } from 'vitest';
import {
  buildAudioLayerVolumeAutomationPoints, buildMusicDuckingWindows,
  buildResolvedPreviewAudioVolumeAutomationPoints, clampAudioValue, clampAudioVolumeValue,
  getAudioVolumeGainAtTime, getMusicDuckingVolumeAtTime, hasManualAudioVolumeAutomation,
  isMusicLikeAudioType, isRenderablePreviewAudioLayer, isSpeechLikeAudioType,
  normalizeAudioLayerType, resolvePreviewAudioUrl, resolvePreviewLayerBaseVolume,
  shouldDuckMusicAgainstAudioType,
} from '../../src/components/video/util/audioPreviewDucking.js';

describe('audio type and gain normalization', () => {
  it.each(['music', 'background_music', 'background music', 'bgm', 'backing_track', 'backing track', ' BGM '])('recognizes %s as music', (type) => {
    expect(normalizeAudioLayerType(type)).toBe('music');
    expect(isMusicLikeAudioType(type)).toBe(true);
    expect(isSpeechLikeAudioType(type)).toBe(false);
    expect(shouldDuckMusicAgainstAudioType(type)).toBe(false);
  });

  it.each(['speech', 'custom_speech', 'custom speech', 'recorded_speech', 'recorded speech', 'lip sync', 'lip_sync', 'user_video'])('recognizes voice-bearing type %s', (type) => {
    expect(isSpeechLikeAudioType(type)).toBe(true);
    expect(shouldDuckMusicAgainstAudioType(type)).toBe(true);
  });

  it.each([[undefined, ''], [null, ''], [5, ''], ['', ''], [' Sound ', 'sound_effect'], [' OTHER ', 'other']])('normalizes %j to %j', (type, normalized) => {
    expect(normalizeAudioLayerType(type)).toBe(normalized);
    expect(isMusicLikeAudioType(type)).toBe(false);
    expect(isSpeechLikeAudioType(type)).toBe(false);
    expect(shouldDuckMusicAgainstAudioType(type)).toBe(Boolean(normalized));
  });

  it.each([[undefined, 0], ['bad', 0], [-2, 0], [2, 1], ['0.25', 0.25]])('clamps normalized gain %j', (input, expected) => {
    expect(clampAudioValue(input)).toBe(expected);
  });

  it('supports custom gain bounds', () => {
    expect(clampAudioValue(0, 0.2, 0.8)).toBe(0.2);
    expect(clampAudioValue(3, 0.2, 0.8)).toBe(0.8);
  });

  it.each([[undefined, 100], [NaN, 100], [Infinity, 100], [-1, 100], [0, 0], ['250.123456', 250.1235]])('normalizes volume %j without limiting amplification to 100%%', (input, expected) => {
    expect(clampAudioVolumeValue(input)).toBe(expected);
  });

  it('uses a valid fallback for invalid volumes', () => {
    expect(clampAudioVolumeValue('bad', 75.123456)).toBe(75.1235);
    expect(clampAudioVolumeValue('bad', -1)).toBe(0);
  });

  it.each([Infinity, -Infinity, NaN, 'invalid'])('uses the default volume for a nonfinite fallback %j', (fallback) => {
    expect(clampAudioVolumeValue('bad', fallback)).toBe(100);
    expect(clampAudioVolumeValue(-1, fallback)).toBe(100);
  });

  it('preserves an explicitly muted fallback for an invalid volume', () => {
    expect(clampAudioVolumeValue(undefined, 0)).toBe(0);
  });

  it.each([[undefined, 1], [-1, 1], [Infinity, 1], [0, 0], ['150', 1.5]])('resolves base preview volume %j', (volume, expected) => {
    expect(resolvePreviewLayerBaseVolume({ volume })).toBe(expected);
  });
});

describe('manual volume automation', () => {
  it('makes fixed endpoints and sorts, deduplicates, clamps and rounds editable points', () => {
    const layer = { volume: 80, startVolume: 20, endVolume: 120, duration: 4, timestampedVolumes: [
      { id: ' end ', time: 3, volume: 40 },
      { time: 1, volume: 30 },
      { id: 'replacement', time: 1, volume: 50 },
      { time: 0, volume: 70 }, { time: 4, volume: 70 }, { time: 9, volume: 70 },
      { time: 'bad', volume: 70 }, { time: 2.123456, volume: -1 },
    ] };
    expect(buildAudioLayerVolumeAutomationPoints(layer)).toEqual([
      { id: 'start', time: 0, volume: 20, kind: 'start', fixed: true },
      { id: 'replacement', time: 1, volume: 50, kind: 'point', fixed: false },
      { id: 'point_7_2.1235', time: 2.1235, volume: 80, kind: 'point', fixed: false },
      { id: 'end', time: 3, volume: 40, kind: 'point', fixed: false },
      { id: 'end', time: 4, volume: 120, kind: 'end', fixed: true },
    ]);
    expect(layer.timestampedVolumes).toHaveLength(8);
  });

  it('reads a legacy volume envelope and derives duration from end minus start', () => {
    const points = buildAudioLayerVolumeAutomationPoints({ startTime: 4, endTime: 7, volumeEnvelope: [{ time: 2, volume: 50 }] });
    expect(points.map(({ time, volume }) => ({ time, volume }))).toEqual([
      { time: 0, volume: 100 }, { time: 2, volume: 50 }, { time: 3, volume: 100 },
    ]);
  });

  it('uses a duration override and does not let endpoint points replace the fixed handles', () => {
    const points = buildAudioLayerVolumeAutomationPoints({ duration: 20, timestampedVolumes: [{ time: 2, volume: 20 }] }, 2);
    expect(points.map(({ time }) => time)).toEqual([0, 2]);
    expect(buildAudioLayerVolumeAutomationPoints({ timestampedVolumes: 'invalid', startTime: 'bad', endTime: 'bad' }))
      .toHaveLength(2);
    expect(buildAudioLayerVolumeAutomationPoints({ startTime: -2, endTime: -1 }, -10).at(-1).time).toBe(0);
  });

  it('requires the manual adjustment toggle before applying automation', () => {
    expect(hasManualAudioVolumeAutomation()).toBe(false);
    expect(hasManualAudioVolumeAutomation({ manualVolumeAdjustmentEnabled: true })).toBe(true);
    expect(hasManualAudioVolumeAutomation({ timestampedVolumes: [{ time: 1, volume: 0 }] })).toBe(false);
  });

  it('converts percentages to gains and interpolates an unsorted envelope without mutation', () => {
    const points = buildResolvedPreviewAudioVolumeAutomationPoints({ volume: 50, duration: 4, startVolume: 20, endVolume: 100 });
    expect(points.map(({ gain }) => gain)).toEqual([0.2, 1]);
    const reversed = [...points].reverse();
    expect(getAudioVolumeGainAtTime(2, reversed)).toBeCloseTo(0.6);
    expect(getAudioVolumeGainAtTime(-1, reversed)).toBe(0.2);
    expect(getAudioVolumeGainAtTime(10, reversed)).toBe(1);
    expect(reversed[0].time).toBe(4);
  });

  it('uses unity for a missing envelope and resolves near-coincident points safely', () => {
    expect(getAudioVolumeGainAtTime(2)).toBe(1);
    expect(getAudioVolumeGainAtTime(2, null)).toBe(1);
    expect(getAudioVolumeGainAtTime(NaN, [{ time: 0, volume: 0.2 }, { time: 1, volume: 0.6 }])).toBe(0.2);
    expect(getAudioVolumeGainAtTime(1.00001, [{ time: 1, gain: 0.2 }, { time: 1.00002, gain: 0.6 }])).toBe(0.6);
    expect(getAudioVolumeGainAtTime(10, [{ time: 0 }, { time: 1 }])).toBe(1);
  });

  it.each([0, 1, 2])('preserves an explicitly muted automation envelope at t=%s', (time) => {
    const points = buildResolvedPreviewAudioVolumeAutomationPoints({ duration: 2, volume: 100, startVolume: 0, endVolume: 0 });
    expect(getAudioVolumeGainAtTime(time, points)).toBe(0);
  });

  it.each([[-1, 0], [0, 0], [1, 0.5], [2, 1], [3, 1]])('interpolates a fade from silence at t=%s', (time, expected) => {
    expect(getAudioVolumeGainAtTime(time, [{ time: 0, gain: 0 }, { time: 2, gain: 1 }])).toBe(expected);
    expect(getAudioVolumeGainAtTime(time, [{ time: 0, gain: 1 }, { time: 2, gain: 0 }])).toBe(1 - expected);
  });

  it('falls back to unity for nonfinite envelope gains without treating a muted volume as missing', () => {
    expect(getAudioVolumeGainAtTime(0, [{ time: 0, gain: NaN }])).toBe(1);
    expect(getAudioVolumeGainAtTime(2, [{ time: 0, gain: Infinity }])).toBe(1);
    expect(getAudioVolumeGainAtTime(0, [{ time: 0, volume: 0 }])).toBe(0);
  });
});

describe('preview audio selection and source resolution', () => {
  it.each([
    [{ selectedLocalAudioLink: ' clip.wav ', url: 'ignored.wav' }, '/clip.wav'],
    [{ localAudioLinks: [null, '', ' local.wav '] }, '/local.wav'],
    [{ url: ' https://cdn.example/a.wav ' }, 'https://cdn.example/a.wav'],
    [{ selectedRemoteAudioLink: 'remote.wav' }, '/remote.wav'],
    [{ remoteAudioLinks: ['', 1, '/remote.wav'] }, '/remote.wav'],
    [{ remoteAudioData: [null, {}, { audio_url: ' /data.wav ' }] }, '/data.wav'],
  ])('selects the highest priority valid audio source from %j', (layer, expected) => {
    expect(resolvePreviewAudioUrl(layer)).toBe(expected);
    expect(isRenderablePreviewAudioLayer(layer)).toBe(true);
  });

  it('joins relative sources to the processor and retains absolute HTTP sources', () => {
    expect(resolvePreviewAudioUrl({ url: '/clip.wav' }, ' https://api.example/// ')).toBe('https://api.example/clip.wav');
    expect(resolvePreviewAudioUrl({ url: 'HTTP://cdn.example/a.wav' }, 'https://api.example')).toBe('HTTP://cdn.example/a.wav');
    expect(resolvePreviewAudioUrl({ url: 'clip.wav' }, null)).toBe('/clip.wav');
    expect(resolvePreviewAudioUrl({ remoteAudioData: [{ audio_url: 42 }] })).toBeNull();
  });

  it.each(['blob:https://studio.example/recording-id', 'data:audio/wav;base64,UklGRg=='])('retains a browser-local recording URL %s', (url) => {
    expect(resolvePreviewAudioUrl({ selectedLocalAudioLink: url }, 'https://api.example')).toBe(url);
  });

  it.each([
    [null, false], [{}, false], [{ url: '  ' }, false],
    [{ url: '/a.wav', isEnabled: false }, false],
    [{ url: '/a.wav', defaultSelected: false }, false],
    [{ url: '/a.wav', isEnabled: false, defaultSelected: true }, true],
    [{ url: '/a.wav', isEnabled: true }, true],
    [{ url: '/a.wav', generationStatus: ' pending ' }, false],
    [{ url: '/a.wav', generationStatus: 'COMPLETED' }, true],
  ])('requires a source, enabled selection, and completed generation for %j', (layer, expected) => {
    expect(isRenderablePreviewAudioLayer(layer)).toBe(expected);
  });
});

describe('background music ducking', () => {
  it('clips to the music range, sorts and merges nearby speech and leaves separate windows apart', () => {
    const layers = [{ startTime: 7, endTime: 9 }, { startTime: 1, endTime: 3 }, { startTime: 3.5, endTime: 4 },
      { startTime: -2, endTime: 0 }, { startTime: 12, endTime: 14 }, { startTime: 7, endTime: 8 }];
    expect(buildMusicDuckingWindows({ musicStartTime: 2, musicEndTime: 8, duckingLayers: layers })).toEqual([
      { start: 2, end: 4, fadeDuration: 0.5 }, { start: 7, end: 8, fadeDuration: 0.5 },
    ]);
    expect(layers[0]).toEqual({ startTime: 7, endTime: 9 });
  });

  it('shortens fades for short speech and respects custom merge gaps', () => {
    expect(buildMusicDuckingWindows({ musicStartTime: 0, musicEndTime: 5, fadeDurationSeconds: 1, mergeGapSeconds: 0,
      duckingLayers: [{ startTime: 1, endTime: 1.2 }, { startTime: 1.4, endTime: 2 }] }))
      .toEqual([{ start: 1, end: 1.2, fadeDuration: (1.2 - 1) / 2 }, { start: 1.4, end: 2, fadeDuration: (2 - 1.4) / 2 }]);
  });

  it.each([undefined, [], null, [{ startTime: 2, endTime: 1 }], [{ startTime: 'bad', endTime: 'bad' }]])('ignores empty or nonoverlapping windows %j', (duckingLayers) => {
    expect(buildMusicDuckingWindows({ musicStartTime: 0, musicEndTime: 1, duckingLayers })).toEqual([]);
  });

  it.each([[0, 1], [1.5, 1], [1.75, 0.6125], [2, 0.225], [3, 0.225], [4, 0.225], [4.25, 0.6125], [4.5, 1], [10, 1]])('sets fade gain at t=%s to %s', (time, expected) => {
    expect(getMusicDuckingVolumeAtTime(time, [{ start: 2, end: 4, fadeDuration: 0.5 }])).toBeCloseTo(expected);
  });

  it('supports abrupt ducking and skips malformed windows', () => {
    const windows = [{ start: 3, end: 2 }, { start: 5, end: 6, fadeDuration: -1 }];
    expect(getMusicDuckingVolumeAtTime(5, windows)).toBe(0.225);
    expect(getMusicDuckingVolumeAtTime(6, windows)).toBe(0.225);
    expect(getMusicDuckingVolumeAtTime(7, windows)).toBe(1);
    expect(getMusicDuckingVolumeAtTime(NaN, [{ start: 'bad', end: 'bad' }])).toBe(1);
    expect(getMusicDuckingVolumeAtTime(1)).toBe(1);
    expect(getMusicDuckingVolumeAtTime(1, null)).toBe(1);
  });
});
