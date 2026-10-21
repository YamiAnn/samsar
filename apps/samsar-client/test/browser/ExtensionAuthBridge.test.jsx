import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { page } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import ExtensionAuthBridge from '../../src/components/auth/ExtensionAuthBridge.jsx';
import { clearAuthData, getAuthToken } from '../../src/utils/web.jsx';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('../../src/utils/web.jsx', () => ({ getAuthToken: vi.fn(), clearAuthData: vi.fn() }));
// Login and registration forms are exercised separately in AuthForms.test.jsx.
// This boundary exposes the redirect passed to authentication without starting
// a second sign-in network flow inside the extension handshake tests.
vi.mock('../../src/components/auth/AuthContainer.jsx', () => ({
  default: ({ redirectTo }) => <section aria-label='Sign in to connect extension'>{redirectTo}</section>,
}));

beforeEach(() => {
  axios.get.mockReset();
  getAuthToken.mockReset();
  getAuthToken.mockReturnValue(null);
});

function mount(redirect, extraQuery = '') {
  const query = redirect == null ? '' : `?redirect_uri=${encodeURIComponent(redirect)}${extraQuery}`;
  return render(<MemoryRouter initialEntries={[`/extension_auth${query}`]}><ExtensionAuthBridge /></MemoryRouter>);
}

describe('extension authentication handshake', () => {
  it.each([
    null, '', '   ', 'not-a-url',
    'http://extension.chromiumapp.org/',
    'javascript:alert(1)',
    'https://chromiumapp.org/',
    'https://extension.chromiumapp.org.evil.example/',
    'https://evil.example/extension.chromiumapp.org',
    'https://extension.chromiumapp.org@evil.example/',
  ])('rejects an invalid extension redirect before accessing credentials: %s', async (redirect) => {
    mount(redirect);
    await expect.element(page.getByRole('heading', { name: 'Extension sign-in unavailable' })).toBeVisible();
    await expect.element(page.getByText('This extension sign-in request is missing a valid redirect URI.')).toBeVisible();
    expect(getAuthToken).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('starts sign-in for a valid extension without a current session and preserves the return path', async () => {
    const redirect = 'https://exampleextension.chromiumapp.org/callback?state=123';
    mount(redirect, '&source=browser');
    await expect.element(page.getByRole('region', { name: 'Sign in to connect extension' })).toHaveTextContent(`/extension_auth?redirect_uri=${encodeURIComponent(redirect)}&source=browser`);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('keeps the connecting UI visible while a token request is pending and authenticates the request', async () => {
    getAuthToken.mockReturnValue('current-auth-token');
    axios.get.mockReturnValue(new Promise(() => {}));
    mount('https://exampleextension.chromiumapp.org/');
    await expect.element(page.getByRole('heading', { name: 'Connecting your extension' })).toBeVisible();
    expect(axios.get).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/create_login_token$/), { headers: { Authorization: 'Bearer current-auth-token' } });
  });

  it.each([401, 403])('clears an expired session and returns to sign-in on HTTP %s', async (status) => {
    getAuthToken.mockReturnValue('expired-token');
    axios.get.mockRejectedValue({ response: { status } });
    mount('https://exampleextension.chromiumapp.org/');
    await expect.element(page.getByText('Your Samsar session expired. Sign in again to continue.')).toBeVisible();
    await expect.element(page.getByRole('region', { name: 'Sign in to connect extension' })).toBeVisible();
    expect(clearAuthData).toHaveBeenCalledOnce();
  });

  it.each([
    [{ response: { status: 503, data: { message: 'Authentication service unavailable' } } }, 'Authentication service unavailable'],
    [new Error('Connection lost'), 'Connection lost'],
    [{}, 'Unable to connect this extension to Samsar One.'],
  ])('shows a useful service error without clearing a valid session', async (failure, message) => {
    getAuthToken.mockReturnValue('valid-token');
    axios.get.mockRejectedValue(failure);
    mount('https://exampleextension.chromiumapp.org/');
    await expect.element(page.getByRole('heading', { name: 'Extension sign-in unavailable' })).toBeVisible();
    await expect.element(page.getByText(message, { exact: true })).toBeVisible();
    expect(clearAuthData).not.toHaveBeenCalled();
  });

  it.each([
    undefined, {}, { loginToken: '' }, { loginToken: '   ' },
    { loginUrl: '' }, { loginUrl: 'invalid-url' },
    { loginUrl: 'https://samsar.one/login' },
    { loginUrl: 'https://samsar.one/login?loginToken=%20%20' },
  ])('rejects malformed token responses without navigating away: %j', async (payload) => {
    getAuthToken.mockReturnValue('valid-token');
    axios.get.mockResolvedValue({ data: payload });
    mount('https://exampleextension.chromiumapp.org/');
    await expect.element(page.getByText('Samsar could not create an extension login token.')).toBeVisible();
    expect(clearAuthData).not.toHaveBeenCalled();
  });

  it('ignores a late failed response after the handshake component unmounts', async () => {
    let fail;
    getAuthToken.mockReturnValue('valid-token');
    axios.get.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    const { unmount } = mount('https://exampleextension.chromiumapp.org/');
    await waitFor(() => expect(axios.get).toHaveBeenCalledOnce());
    unmount();
    fail({ response: { status: 401 } });
    await Promise.resolve();
    expect(clearAuthData).not.toHaveBeenCalled();
    expect(document.querySelector('h1')).toBeNull();
  });
});
