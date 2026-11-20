import { useSearchParams } from 'react-router-dom';

// Browsers drop tabs and line breaks from a URL before reading it, so `/<tab>/host` is `//host`.
// eslint-disable-next-line no-control-regex
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;
const SITE = 'https://site.invalid';

/**
 * A `next` value that is safe to navigate to: a path on this site. Rejects other schemes and hosts,
 * protocol-relative `//host`, any backslash (browsers read `/\host` as `//host`) and any control character
 * (browsers remove tabs and line breaks, so `/<tab>/host` is also `//host`). As a last check the browser's own
 * parser must agree the value stays on this site.
 */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || CONTROL_OR_BACKSLASH.test(raw)) return '/';
  try {
    return new URL(raw, SITE).origin === SITE ? raw : '/';
  } catch {
    return '/';
  }
}

/** Where to go after signing in: the `next` query value, if it is a path on this site. */
export function useNext(): string {
  const [params] = useSearchParams();
  return safeNext(params.get('next'));
}

/** Carries `next` along the sign-in steps. */
export const withNext = (path: string, next: string): string =>
  next === '/' ? path : `${path}?next=${encodeURIComponent(next)}`;
