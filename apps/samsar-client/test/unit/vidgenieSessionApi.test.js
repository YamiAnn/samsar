import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankVidgenieSession } from '../../src/utils/vidgenieSessionApi.js';

const headers = { headers: { Authorization: 'Bearer test-token' } };

beforeEach(() => localStorage.clear());

describe('blank Vidgenie project API', () => {
  it.each([[null, headers], ['', headers], ['/api', null], ['/api', undefined]])(
    'does not create a project without endpoint and authentication (%s)', async (api, auth) => {
      const client = { post: vi.fn() };
      await expect(createBlankVidgenieSession(api, auth, client)).resolves.toBeNull();
      expect(client.post).not.toHaveBeenCalled();
    },
  );

  it.each(['sessionId', 'session_id', '_id', 'id'])('accepts the %s response field and remembers the project', async (key) => {
    const client = { post: vi.fn().mockResolvedValue({ data: { [key]: '  project-42  ' } }) };
    await expect(createBlankVidgenieSession('/api', headers, client)).resolves.toBe('project-42');
    expect(client.post).toHaveBeenCalledExactlyOnceWith('/api/vidgenie/create_blank', {}, headers);
    expect(localStorage.getItem('videoSessionId')).toBe('project-42');
  });

  it.each([
    [{ $oid: '  mongo-project  ' }, 'mongo-project'],
    [{ toString: () => 'object-project' }, 'object-project'],
    [{}, null],
    [{ $oid: '   ' }, null],
    [{ toString: () => '' }, null],
    ['   ', null],
    [42, null],
    [null, null],
    [false, null],
  ])('normalizes supported identifiers and rejects malformed responses', async (id, expected) => {
    const client = { post: vi.fn().mockResolvedValue({ data: { sessionId: id } }) };
    await expect(createBlankVidgenieSession('/api', headers, client)).resolves.toBe(expected);
    expect(localStorage.getItem('videoSessionId')).toBe(expected);
  });

  it('does not erase a remembered project when a response lacks its id', async () => {
    localStorage.setItem('videoSessionId', 'previous');
    const client = { post: vi.fn().mockResolvedValue({}) };
    await expect(createBlankVidgenieSession('/api', headers, client)).resolves.toBeNull();
    expect(localStorage.getItem('videoSessionId')).toBe('previous');
  });

  it('keeps routing possible when browser persistence is blocked', async () => {
    const client = { post: vi.fn().mockResolvedValue({ data: { id: 'created' } }) };
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    await expect(createBlankVidgenieSession('/api', headers, client)).resolves.toBe('created');
  });

  it('propagates server failure without replacing the previous project', async () => {
    localStorage.setItem('videoSessionId', 'previous');
    const error = new Error('creation unavailable');
    const client = { post: vi.fn().mockRejectedValue(error) };
    await expect(createBlankVidgenieSession('/api', headers, client)).rejects.toBe(error);
    expect(localStorage.getItem('videoSessionId')).toBe('previous');
  });
});
