import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { getHeaders } from '../../src/utils/web.jsx';
import useRealtimeTranscription from '../../src/hooks/useRealtimeTranscription.js';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('../../src/utils/web.jsx', () => ({ getHeaders: vi.fn() }));

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

let microphone;
let getUserMedia;
let peers;
let fetchMock;
let options;

beforeEach(() => {
  peers = [];
  microphone = { getTracks: () => [{ kind: 'audio', stop: trackStop }] };
  trackStop.mockReset();
  getUserMedia = vi.fn().mockResolvedValue(microphone);
  Object.defineProperty(window.navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  getHeaders.mockReturnValue({ headers: { Authorization: 'Bearer user-token' } });
  axios.get.mockReset().mockResolvedValue({ data: { token: 'ephemeral-token', model: 'speech-model', expiresAt: 123, maxTranscriptWords: 500 } });
  fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => 'remote-answer' });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('RTCPeerConnection', class {
    constructor() {
      this.channel = { readyState: 'open', close: vi.fn(), send: vi.fn(), addEventListener: vi.fn() };
      this.close = vi.fn();
      this.addTrack = vi.fn();
      this.createDataChannel = vi.fn(() => this.channel);
      this.createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'local-offer' });
      this.setLocalDescription = vi.fn().mockResolvedValue();
      this.setRemoteDescription = vi.fn().mockResolvedValue();
      peers.push(this);
    }
  });
  options = { transcriptEndpoint: '/voice-token', onTranscription: vi.fn(), onSessionStarted: vi.fn(), onSessionEnded: vi.fn(), onError: vi.fn() };
});
const trackStop = vi.fn();

async function start(hookOptions = options) {
  const hook = renderHook(() => useRealtimeTranscription(hookOptions));
  await act(async () => { await hook.result.current.startTranscription(); });
  return hook;
}
function message(payload) {
  act(() => peers[0].channel.onmessage({ data: JSON.stringify(payload) }));
}

describe('microphone session lifecycle', () => {
  it('negotiates an authenticated audio-only session and releases every resource on stop', async () => {
    const { result } = await start();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(axios.get).toHaveBeenCalledWith('/voice-token', { headers: { Authorization: 'Bearer user-token' } });
    expect(peers[0].addTrack).toHaveBeenCalledWith(expect.objectContaining({ kind: 'audio' }), microphone);
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/realtime?model=speech-model', { method: 'POST', body: 'local-offer', headers: { Authorization: 'Bearer ephemeral-token', 'Content-Type': 'application/sdp', 'OpenAI-Beta': 'realtime=v1' } });
    expect(peers[0].setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'remote-answer' });
    expect(options.onSessionStarted).toHaveBeenCalledWith({ model: 'speech-model', expiresAt: 123, maxTranscriptWords: 500 });
    expect(result.current).toMatchObject({ isRecording: true, isInitializing: false, error: null });
    const open = peers[0].channel.addEventListener.mock.calls.find(([type]) => type === 'open')[1];
    act(open);
    const sent = peers[0].channel.send.mock.calls.map(([payload]) => JSON.parse(payload));
    expect(sent[0]).toMatchObject({ type: 'session.update', session: { turn_detection: { create_response: false } } });
    expect(sent[1]).toMatchObject({ type: 'response.create', response: { modalities: ['text'] } });
    await act(async () => { await result.current.startTranscription(); });
    expect(getUserMedia).toHaveBeenCalledOnce();
    act(() => result.current.stopTranscription());
    expect(result.current.isRecording).toBe(false);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(peers[0].close).toHaveBeenCalledOnce();
    expect(peers[0].channel.close).toHaveBeenCalledOnce();
    expect(peers[0].channel.onmessage).toBeNull();
    expect(options.onSessionEnded).toHaveBeenCalledOnce();
  });

  it('reports unsupported microphone capture without contacting a provider', async () => {
    Object.defineProperty(window.navigator, 'mediaDevices', { value: undefined, configurable: true });
    const { result } = await start();
    expect(result.current.isSupported).toBe(false);
    expect(result.current.error).toMatch(/does not support microphone/);
    expect(axios.get).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledWith(result.current.error);
  });

  it('reports permission denial and allows a later successful retry', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('Microphone permission denied'));
    const { result } = await start();
    expect(result.current.error).toBe('Microphone permission denied');
    expect(result.current.isInitializing).toBe(false);
    await act(async () => { await result.current.startTranscription(); });
    expect(result.current.isRecording).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it.each([
    [{ transcriptEndpoint: '' }, null, 'Missing transcription endpoint.'],
    [{}, null, 'Authentication required before using voice input.'],
    [{}, { headers: {} }, 'Authentication required before using voice input.'],
  ])('closes the microphone if session authentication cannot begin (%s)', async (changes, headers, error) => {
    getHeaders.mockReturnValue(headers);
    const { result } = await start({ ...options, ...changes });
    expect(result.current.error).toBe(error);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects missing ephemeral credentials before creating a peer connection', async () => {
    axios.get.mockResolvedValue({ data: null });
    const { result } = await start();
    expect(result.current.error).toBe('Ephemeral token response missing credentials.');
    expect(peers).toHaveLength(0);
    expect(trackStop).toHaveBeenCalledOnce();
  });

  it.each([
    { key: 'secret', default_model: 'alternate', endpoint: 'https://realtime.test/offer' },
    { ephemeral_key: 'secret', session: { model: 'alternate', url: 'https://realtime.test/offer' } },
    { client_secret: { value: 'secret', url: 'https://realtime.test/offer' }, model: 'alternate' },
    { client_secret: { secret: 'secret' }, realtime_url: 'https://realtime.test/offer', model: 'alternate' },
    { clientSecret: { value: 'secret' }, url: 'https://realtime.test/offer', model: 'alternate' },
    { clientSecret: 'secret', url: 'https://realtime.test/offer', model: 'alternate' },
  ])('accepts the supported ephemeral-key response envelope %#', async (data) => {
    axios.get.mockResolvedValue({ data });
    const { result } = await start({ ...options, transcriptHeaders: { authorization: 'Bearer alternate-user' } });
    expect(result.current.isRecording).toBe(true);
    expect(axios.get).toHaveBeenCalledWith('/voice-token', { headers: { authorization: 'Bearer alternate-user' } });
    expect(fetchMock).toHaveBeenCalledWith('https://realtime.test/offer', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret' }) }));
    expect(options.onSessionStarted).toHaveBeenCalledWith(expect.objectContaining({ model: 'alternate' }));
  });

  it('uses the preferred model and URL-encodes it when the server omits routing metadata', async () => {
    axios.get.mockResolvedValue({ data: { token: 'secret' } });
    await start({ ...options, model: 'speech/model special' });
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/realtime?model=speech%2Fmodel%20special', expect.any(Object));
  });

  it('cleans up a rejected SDP handshake and exposes its HTTP status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    const { result } = await start();
    expect(result.current.error).toBe('Realtime handshake failed with status 429');
    expect(result.current.isRecording).toBe(false);
    expect(peers[0].close).toHaveBeenCalledOnce();
    expect(trackStop).toHaveBeenCalledOnce();
    expect(options.onSessionStarted).not.toHaveBeenCalled();
  });

  it.each(['disconnected', 'failed'])('ends recording when the connection becomes %s', async (connectionState) => {
    const { result } = await start();
    peers[0].connectionState = 'connected';
    act(() => peers[0].onconnectionstatechange());
    expect(result.current.isRecording).toBe(true);
    peers[0].connectionState = connectionState;
    act(() => peers[0].onconnectionstatechange());
    expect(result.current.isRecording).toBe(false);
    expect(trackStop).toHaveBeenCalledOnce();
  });

  it('ends recording when the provider closes its data channel', async () => {
    const { result } = await start();
    act(() => peers[0].channel.onclose());
    expect(result.current.isRecording).toBe(false);
    expect(options.onSessionEnded).toHaveBeenCalledOnce();
  });

  it('releases media on unmount without reporting a user initiated stop', async () => {
    const { unmount } = await start();
    unmount();
    expect(trackStop).toHaveBeenCalledOnce();
    expect(peers[0].close).toHaveBeenCalledOnce();
    expect(options.onSessionEnded).not.toHaveBeenCalled();
  });

  it('attaches provider audio only when a remote stream is supplied and detaches it on stop', async () => {
    const audios = [];
    vi.stubGlobal('Audio', class { constructor() { audios.push(this); } });
    const { result } = await start();
    act(() => peers[0].ontrack({}));
    act(() => peers[0].ontrack({ streams: [] }));
    act(() => peers[0].ontrack({ streams: [null] }));
    expect(audios).toHaveLength(0);
    const remote = { id: 'remote-audio' };
    act(() => peers[0].ontrack({ streams: [remote] }));
    expect(audios[0]).toMatchObject({ autoplay: true, srcObject: remote });
    act(() => peers[0].ontrack({ streams: [{ id: 'replacement' }] }));
    expect(audios).toHaveLength(1);
    expect(audios[0].srcObject.id).toBe('replacement');
    act(() => result.current.stopTranscription());
    expect(audios[0].srcObject).toBeNull();
  });

  it('finishes stop cleanup even when provider resources throw during close', async () => {
    const { result } = await start();
    peers[0].channel.close.mockImplementation(() => { throw new Error('channel closed'); });
    peers[0].close.mockImplementation(() => { throw new Error('peer closed'); });
    trackStop.mockImplementation(() => { throw new Error('track stopped'); });
    act(() => result.current.stopTranscription());
    expect(result.current.isRecording).toBe(false);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(options.onSessionEnded).toHaveBeenCalledOnce();
    // A second stop must not try to close stale references again.
    act(() => result.current.stopTranscription());
    expect(trackStop).toHaveBeenCalledOnce();
  });

  it('tolerates a data channel that closes before startup control messages are sent', async () => {
    await start();
    peers[0].channel.send.mockImplementation(() => { throw new Error('channel no longer open'); });
    const open = peers[0].channel.addEventListener.mock.calls.find(([type]) => type === 'open')[1];
    expect(() => act(open)).not.toThrow();
  });

  it('does not create a new connection when an outstanding token arrives after unmount', async () => {
    const token = deferred();
    axios.get.mockReturnValue(token.promise);
    const { result, unmount } = renderHook(() => useRealtimeTranscription(options));
    let starting;
    await act(async () => { starting = result.current.startTranscription(); await Promise.resolve(); });
    unmount();
    await act(async () => { token.resolve({ data: { token: 'late-token' } }); await starting; });
    expect(options.onSessionStarted).not.toHaveBeenCalled();
    expect(peers.every((peer) => peer.close.mock.calls.length > 0)).toBe(true);
  });

  it('releases a microphone stream returned after the component has unmounted', async () => {
    const permission = deferred();
    getUserMedia.mockReturnValue(permission.promise);
    const { result, unmount } = renderHook(() => useRealtimeTranscription(options));
    let starting;
    act(() => { starting = result.current.startTranscription(); });
    unmount();
    await act(async () => { permission.resolve(microphone); await starting; });
    expect(trackStop).toHaveBeenCalledOnce();
    expect(axios.get).not.toHaveBeenCalled();
    expect(peers).toHaveLength(0);
  });

  it('does not restart a stopped session when its SDP handshake finishes later', async () => {
    const handshake = deferred();
    fetchMock.mockReturnValue(handshake.promise);
    const { result } = renderHook(() => useRealtimeTranscription(options));
    let starting;
    await act(async () => { starting = result.current.startTranscription(); });
    expect(fetchMock).toHaveBeenCalledOnce();
    act(() => result.current.stopTranscription());
    await act(async () => { handshake.resolve({ ok: true, text: async () => 'late-answer' }); await starting; });
    expect(result.current.isRecording).toBe(false);
    expect(options.onSessionStarted).not.toHaveBeenCalled();
    expect(peers[0].setRemoteDescription).not.toHaveBeenCalled();
    expect(peers[0].close).toHaveBeenCalledOnce();
  });

  it('shares a single initialization when start is pressed twice before React renders', async () => {
    const { result } = renderHook(() => useRealtimeTranscription(options));
    await act(async () => { await Promise.all([result.current.startTranscription(), result.current.startTranscription()]); });
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(peers).toHaveLength(1);
    expect(options.onSessionStarted).toHaveBeenCalledOnce();
  });

  it('can record after React StrictMode replays the mount effect', async () => {
    const { result } = renderHook(() => useRealtimeTranscription(options), { wrapper: StrictMode });
    await act(async () => { await result.current.startTranscription(); });
    expect(result.current.isRecording).toBe(true);
    expect(options.onSessionStarted).toHaveBeenCalledOnce();
  });
});

describe('transcription stream parsing', () => {
  it('ignores malformed, empty, and unrelated provider events', async () => {
    await start();
    act(() => peers[0].channel.onmessage({ data: 'not json' }));
    act(() => peers[0].channel.onmessage({}));
    message({ type: 'session.created' });
    message({ type: 'transcript.delta', delta: { content: [null, 42, { type: 'audio', text: 'not transcript' }] } });
    expect(options.onTranscription).not.toHaveBeenCalled();
  });

  it('combines incremental text, replaces cumulative deltas, and ignores duplicate prefixes', async () => {
    await start();
    message({ type: 'transcript.delta', delta: 'Hello' });
    message({ type: 'transcript.delta', delta: ' world' });
    message({ type: 'transcript.delta', delta: 'Hello world!' });
    message({ type: 'transcript.delta', delta: 'Hello' });
    expect(options.onTranscription.mock.calls).toEqual([['Hello', false], ['Hello world', false], ['Hello world!', false], ['Hello world!', false]]);
    message({ type: 'transcript.completed', transcript: 'Hello world!' });
    expect(options.onTranscription).toHaveBeenLastCalledWith('Hello world!', true);
  });

  it.each([
    [{ type: 'response.delta', response: { delta: { content: [{ type: 'output_text_delta', text: 'spoken' }] } } }, false],
    [{ type: 'response.completed', response: { output: [{ content: [{ type: 'output_text', text: 'spoken' }] }] } }, true],
    [{ type: 'response.updated', response: { content: [{ type: 'output_text', text: { content: 'spoken' } }] } }, true],
    [{ type: 'response.output_text', response: { text: 'spoken' } }, true],
    [{ type: 'conversation.item.completed', item: { content: [{ type: 'input_text', text: 'spoken' }] } }, true],
    [{ type: 'transcript.updated', delta: { content: [{ type: 'transcript', value: 'spoken' }] } }, true],
    [{ type: 'input_text.delta', delta: 'spoken' }, false],
  ])('extracts text from the documented event envelope %#', async (payload, final) => {
    await start();
    message(payload);
    expect(options.onTranscription).toHaveBeenLastCalledWith('spoken', final);
  });

  it('finalizes the buffered transcript when a completion contains no text', async () => {
    await start();
    message({ type: 'transcript.delta', delta: 'Saved words' });
    message({ type: 'input_text.completed' });
    expect(options.onTranscription).toHaveBeenLastCalledWith('Saved words', true);
  });

  it.each(['items', 'output', 'segments', 'alternatives', 'children', 'payload'])('extracts nested transcript fragments from a response %s array', async (key) => {
    await start();
    message({ type: 'response.completed', response: { [key]: [null, 4, { type: 'output_text', text: 'nested words' }] } });
    expect(options.onTranscription).toHaveBeenLastCalledWith('nested words', true);
  });

  it('extracts transcript objects nested in a response message', async () => {
    await start();
    message({ type: 'response.completed', response: { message: { type: 'input_text', transcript: 'message words' } } });
    expect(options.onTranscription).toHaveBeenLastCalledWith('message words', true);
  });

  it('uses the default provider error when an error event omits its message', async () => {
    const { result } = await start();
    message({ type: 'error' });
    expect(result.current.error).toBe('Unexpected error from realtime session.');
    expect(options.onError).toHaveBeenCalledWith(result.current.error);
  });

  it('surfaces provider errors, closes recording, and uses a fallback for empty error payloads', async () => {
    const { result } = await start();
    message({ type: 'error', error: { message: 'Session expired' } });
    expect(result.current.error).toBe('Session expired');
    expect(result.current.isRecording).toBe(false);
    expect(options.onError).toHaveBeenCalledWith('Session expired');
    expect(trackStop).toHaveBeenCalledOnce();
  });
});
