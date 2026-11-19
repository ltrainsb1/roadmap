import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, ApiError, getCsrfToken, setCsrfToken, setUnauthorizedHandler } from './client.ts';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

let fetchMock: ReturnType<typeof vi.fn>;
const lastInit = () => fetchMock.mock.calls.at(-1)![1] as RequestInit & { headers: Record<string, string> };

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  setCsrfToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe('api client', () => {
  test('attaches the CSRF token on POST and not on GET', async () => {
    fetchMock.mockResolvedValueOnce(json(200, {})).mockResolvedValueOnce(json(200, {}));
    setCsrfToken('tok-1');

    await api('/api/things', { method: 'POST', body: { a: 1 } });
    expect(lastInit().headers['x-csrf-token']).toBe('tok-1');
    expect(lastInit().credentials).toBe('same-origin');
    expect(lastInit().body).toBe('{"a":1}');
    expect(lastInit().headers['content-type']).toBe('application/json');

    await api('/api/things');
    expect(lastInit().method).toBe('GET');
    expect(lastInit().headers['x-csrf-token']).toBeUndefined();
  });

  test('sends no content type without a body', async () => {
    fetchMock.mockResolvedValue(json(204));
    await api('/api/auth/totp/enroll/start', { method: 'POST' });
    expect(lastInit().headers['content-type']).toBeUndefined();
    expect(lastInit().body).toBeUndefined();
  });

  test('replaces the stored token whenever a response carries one', async () => {
    setCsrfToken('old');
    fetchMock.mockResolvedValue(json(200, { next: 'mfa', csrfToken: 'fresh' }));
    await api('/api/auth/login', { method: 'POST', body: {} });
    expect(getCsrfToken()).toBe('fresh');
  });

  test('maps an error body to ApiError', async () => {
    fetchMock.mockResolvedValue(json(401, { error: 'invalid_credentials' }));
    const err = await api('/api/auth/login', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: 'invalid_credentials' });
  });

  test('uses the code "unknown" when the error body is not the API shape', async () => {
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(api('/api/me')).rejects.toMatchObject({ status: 502, code: 'unknown' });
  });

  test('redirects to sign in on a 401 from a non-auth call, and drops the token', async () => {
    const redirect = vi.fn();
    setUnauthorizedHandler(redirect);
    setCsrfToken('stale');
    fetchMock.mockResolvedValue(json(401, { error: 'unauthenticated' }));
    await expect(api('/api/me')).rejects.toMatchObject({ status: 401 });
    expect(redirect).toHaveBeenCalledOnce();
    expect(getCsrfToken()).toBeNull();
  });

  test('quiet: a 401 does not send the person to sign in, and drops the token', async () => {
    const redirect = vi.fn();
    setUnauthorizedHandler(redirect);
    setCsrfToken('stale');
    fetchMock.mockResolvedValue(json(401, { error: 'unauthenticated' }));
    await expect(api('/api/me', { quiet: true })).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(redirect).not.toHaveBeenCalled();
    expect(getCsrfToken()).toBeNull();
  });

  test('quiet: a success still stores the CSRF token it carries', async () => {
    fetchMock.mockResolvedValue(json(200, { csrfToken: 'from-me' }));
    await api('/api/me', { quiet: true });
    expect(getCsrfToken()).toBe('from-me');
  });

  test('keeps the token after a wrong second-step code: the pending session is still alive', async () => {
    setCsrfToken('pending-token');
    fetchMock.mockResolvedValue(json(401, { error: 'invalid_code' }));
    await expect(api('/api/auth/mfa/totp', { method: 'POST', body: { code: '000000' } })).rejects.toMatchObject({
      code: 'invalid_code',
    });
    expect(getCsrfToken()).toBe('pending-token');
  });

  test('drops the token when the session is gone (unauthenticated), even on an auth path', async () => {
    setCsrfToken('pending-token');
    fetchMock.mockResolvedValue(json(401, { error: 'unauthenticated' }));
    await expect(api('/api/auth/mfa/totp', { method: 'POST', body: { code: '000000' } })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(getCsrfToken()).toBeNull();
  });

  test('does not redirect on a 401 from an auth call', async () => {
    const redirect = vi.fn();
    setUnauthorizedHandler(redirect);
    fetchMock.mockResolvedValue(json(401, { error: 'invalid_credentials' }));
    await expect(api('/api/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(redirect).not.toHaveBeenCalled();
  });

  test('the default redirect goes to /login with the current path as next', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/r/1/members', search: '?x=1', assign });
    fetchMock.mockResolvedValue(json(401, { error: 'unauthenticated' }));
    await expect(api('/api/roadmaps')).rejects.toBeInstanceOf(ApiError);
    expect(assign).toHaveBeenCalledWith('/login?next=%2Fr%2F1%2Fmembers%3Fx%3D1');
  });
});
