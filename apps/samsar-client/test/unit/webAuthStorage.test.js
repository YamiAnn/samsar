import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAuthData, cleanJsonTheme, consumePostAuthRedirect, getAuthToken, getHeaders,
  hasAcceptedCookies, persistAuthToken, setPostAuthRedirect,
} from '../../src/utils/web.jsx';

vi.mock('../../src/utils/environment.jsx', () => ({ SAMSAR_DEPLOYMENT_EDITION: 'production' }));

const removeCookies = () => {
  for (const cookie of document.cookie.split(';')) {
    document.cookie = `${cookie.split('=')[0].trim()}=; Max-Age=0; Path=/`;
  }
};

beforeEach(() => {
  clearAuthData();
  removeCookies();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearAuthData();
  removeCookies();
});

describe('browser authentication persistence', () => {
  it('does not construct authorization headers for a signed-out browser', () => {
    expect(getAuthToken()).toBeNull();
    expect(getHeaders()).toBeUndefined();
  });
  it('persists an encoded cookie and returns an unmodified bearer token', () => {
    const token = 'token /+=?& unicode-あ';
    persistAuthToken(token);
    expect(localStorage.getItem('authToken')).toBe(token);
    expect(document.cookie).toContain(`authToken=${encodeURIComponent(token)}`);
    expect(getHeaders()).toEqual({ headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
  });
  it.each([null, undefined, ''])('does not replace an existing login with an empty token (%s)', (token) => {
    persistAuthToken('owner-token');
    persistAuthToken(token);
    expect(getAuthToken()).toBe('owner-token');
  });
  it('recovers a cookie-only login and migrates it to browser storage', () => {
    document.cookie = 'unrelated=x';
    document.cookie = `authToken=${encodeURIComponent('cookie / token')}`;
    expect(getAuthToken()).toBe('cookie / token');
    expect(localStorage.getItem('authToken')).toBe('cookie / token');
  });
  it('ignores an empty authentication cookie', () => {
    document.cookie = 'authToken=';
    expect(getAuthToken()).toBeNull();
  });
  it('prefers the persistent token over a stale session or cookie token', () => {
    localStorage.setItem('authToken', 'persistent');
    sessionStorage.setItem('authToken', 'session');
    document.cookie = 'authToken=cookie';
    expect(getAuthToken()).toBe('persistent');
    expect(document.cookie).toContain('authToken=persistent');
  });
  it('falls back to session storage when persistent storage writes are denied', () => {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (this === localStorage && key === 'authToken') throw new DOMException('quota', 'QuotaExceededError');
      return original.call(this, key, value);
    });
    persistAuthToken('session-fallback');
    expect(sessionStorage.getItem('authToken')).toBe('session-fallback');
    expect(getHeaders().headers.Authorization).toBe('Bearer session-fallback');
  });
  it('keeps header authentication available when both storage writes are blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    persistAuthToken('memory-only');
    expect(getAuthToken()).toBe('memory-only');
    expect(getHeaders().headers.Authorization).toBe('Bearer memory-only');
  });
  it('reads a session login even when persistent storage reads and writes fail', () => {
    sessionStorage.setItem('authToken', 'session-only');
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (key) {
      if (this === localStorage) throw new Error('denied');
      return originalGet.call(this, key);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (this === localStorage) throw new Error('denied');
      return originalSet.call(this, key, value);
    });
    expect(getAuthToken()).toBe('session-only');
  });
  it('recovers a cookie token if both browser storage reads fail', () => {
    document.cookie = 'authToken=cookie-only';
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(getAuthToken()).toBe('cookie-only');
  });
  it('does not use a cookie-only login after cookie consent is rejected', () => {
    localStorage.setItem('samsar_cookie_consent', 'rejected');
    document.cookie = 'authToken=old-cookie';
    expect(hasAcceptedCookies()).toBe(false);
    expect(getAuthToken()).toBeNull();
    persistAuthToken('new-header-token');
    expect(getAuthToken()).toBe('new-header-token');
    expect(document.cookie).toContain('authToken=old-cookie');
  });
  it('clears memory, both storage tokens, and cookies on logout', () => {
    persistAuthToken('owner');
    sessionStorage.setItem('authToken', 'stale');
    clearAuthData();
    expect(localStorage.getItem('authToken')).toBeNull();
    expect(sessionStorage.getItem('authToken')).toBeNull();
    expect(document.cookie).not.toContain('authToken=');
    expect(getHeaders()).toBeUndefined();
  });
  it('continues logout when token storage deletion is denied', () => {
    persistAuthToken('owner');
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => clearAuthData()).not.toThrow();
    expect(document.cookie).not.toContain('authToken=');
  });
  it('retains header authentication if restoring the media cookie is denied', () => {
    localStorage.setItem('authToken', 'existing');
    vi.spyOn(document, 'cookie', 'set').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    expect(getHeaders().headers.Authorization).toBe('Bearer existing');
  });
  it('treats malformed URL encoding in a cookie as an invalid login instead of crashing', () => {
    document.cookie = 'authToken=%E0%A4%A';
    expect(getAuthToken()).toBeNull();
    expect(getHeaders()).toBeUndefined();
  });
  it('preserves a successful sign-in when cookie writes are blocked', () => {
    vi.spyOn(document, 'cookie', 'set').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    expect(() => persistAuthToken('new-login')).not.toThrow();
    expect(getHeaders().headers.Authorization).toBe('Bearer new-login');
  });
  it('treats inaccessible cookies as unavailable while still checking local credentials', () => {
    vi.spyOn(document, 'cookie', 'get').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    expect(getAuthToken()).toBeNull();
    persistAuthToken('local-login');
    expect(getHeaders().headers.Authorization).toBe('Bearer local-login');
  });
  it('clears local credentials on logout even if browser cookie deletion is blocked', () => {
    persistAuthToken('owner');
    vi.spyOn(document, 'cookie', 'set').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    expect(() => clearAuthData()).not.toThrow();
    expect(localStorage.getItem('authToken')).toBeNull();
    expect(sessionStorage.getItem('authToken')).toBeNull();
  });
});

describe('post-authentication redirect storage', () => {
  it('returns a stored destination exactly once', () => {
    setPostAuthRedirect('/video/project?tab=audio');
    expect(consumePostAuthRedirect()).toBe('/video/project?tab=audio');
    expect(consumePostAuthRedirect()).toBeNull();
  });
  it.each([null, undefined, '', 5, {}])('does not replace a destination with invalid input %s', (input) => {
    setPostAuthRedirect('/library');
    setPostAuthRedirect(input);
    expect(consumePostAuthRedirect()).toBe('/library');
  });
  it('tolerates redirect writes being blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => setPostAuthRedirect('/video/project')).not.toThrow();
  });
  it('returns no redirect when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(consumePostAuthRedirect()).toBeNull();
  });
  it('returns no redirect when it cannot consume the stored value', () => {
    setPostAuthRedirect('/video/project');
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    expect(consumePostAuthRedirect()).toBeNull();
  });
});

describe('JSON theme normalization', () => {
  it.each([
    [' { "colors": [ "red", "blue" ], "n": 2 } ', '{"colors":["red","blue"],"n":2}'],
    ['null', 'null'], ['true', 'true'], ['42', '42'], ['"text"', '"text"'],
  ])('normalizes valid JSON %s without changing its value', (input, output) => {
    expect(cleanJsonTheme(input)).toBe(output);
  });
  it.each(['not json', '', '{"a":', undefined])('returns no theme for invalid JSON %s', (input) => expect(cleanJsonTheme(input)).toBeNull());
});
