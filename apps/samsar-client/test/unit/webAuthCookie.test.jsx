import { beforeEach, expect, it, vi } from 'vitest';
import { clearAuthData, getAuthToken, getHeaders } from '../../src/utils/web.jsx';

vi.mock('../../src/utils/environment.jsx', () => ({ SAMSAR_DEPLOYMENT_EDITION: 'production' }));

beforeEach(() => {
  clearAuthData();
  localStorage.clear();
  sessionStorage.clear();
});

it('restores browser media authentication for a login saved before asset protection', () => {
  localStorage.setItem('authToken', 'existing.owner.token');
  expect(document.cookie).not.toContain('authToken=');
  expect(getHeaders().headers.Authorization).toBe('Bearer existing.owner.token');
  expect(document.cookie).toContain('authToken=existing.owner.token');
  const write = vi.spyOn(document, 'cookie', 'set');
  expect(getAuthToken()).toBe('existing.owner.token');
  expect(write).not.toHaveBeenCalled();
});

it('recovers a session-only login without requiring another login request', () => {
  sessionStorage.setItem('authToken', 'session.owner.token');
  expect(getAuthToken()).toBe('session.owner.token');
  expect(document.cookie).toContain('authToken=session.owner.token');
});

it('honors rejected cookie consent while preserving API header authentication', () => {
  localStorage.setItem('samsar_cookie_consent', 'rejected');
  localStorage.setItem('authToken', 'existing.owner.token');
  expect(getHeaders().headers.Authorization).toBe('Bearer existing.owner.token');
  expect(document.cookie).not.toContain('authToken=');
});
