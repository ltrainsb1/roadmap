export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
}

/** The CSRF token lives in memory only: the server hands out a new one whenever the session changes. */
let csrfToken: string | null = null;
export const setCsrfToken = (token: string | null): void => {
  csrfToken = token;
};
export const getCsrfToken = (): string | null => csrfToken;

const defaultOnUnauthorized = (): void => {
  const here = window.location.pathname + window.location.search;
  window.location.assign(`/login?next=${encodeURIComponent(here)}`);
};
let onUnauthorized: () => void = defaultOnUnauthorized;

/** The app replaces the default full-page redirect with a router navigation. */
export const setUnauthorizedHandler = (handler: (() => void) | null): void => {
  onUnauthorized = handler ?? defaultOnUnauthorized;
};

const AUTH_PREFIX = '/api/auth/';

/**
 * Calls the API. Attaches the CSRF token, stores any `csrfToken` the response carries, throws
 * `ApiError` for a non-2xx answer, and sends the person to sign in when a non-auth call gets a 401.
 */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  // A JSON content type with an empty body is a 400, so only send it with a body.
  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }

  if (!res.ok) {
    const code = typeof (data as { error?: unknown } | undefined)?.error === 'string' ? (data as { error: string }).error : 'unknown';
    if (res.status === 401) {
      csrfToken = null;
      if (!path.startsWith(AUTH_PREFIX)) onUnauthorized();
    }
    throw new ApiError(res.status, code);
  }

  const token = (data as { csrfToken?: unknown } | undefined)?.csrfToken;
  if (typeof token === 'string') csrfToken = token;
  return data as T;
}
