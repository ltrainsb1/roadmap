import { useSearchParams } from 'react-router-dom';

/**
 * A `next` value that is safe to navigate to: a path on this site. Rejects other schemes and hosts,
 * protocol-relative `//host`, and any backslash (browsers read `/\host` as `//host`).
 */
export function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') ? raw : '/';
}

/** Where to go after signing in: the `next` query value, if it is a path on this site. */
export function useNext(): string {
  const [params] = useSearchParams();
  return safeNext(params.get('next'));
}

/** Carries `next` along the sign-in steps. */
export const withNext = (path: string, next: string): string =>
  next === '/' ? path : `${path}?next=${encodeURIComponent(next)}`;
