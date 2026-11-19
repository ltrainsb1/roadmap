import { useSearchParams } from 'react-router-dom';

/** Where to go after signing in: the `next` query value, if it is a path on this site. */
export function useNext(): string {
  const [params] = useSearchParams();
  const next = params.get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

/** Carries `next` along the sign-in steps. */
export const withNext = (path: string, next: string): string =>
  next === '/' ? path : `${path}?next=${encodeURIComponent(next)}`;
