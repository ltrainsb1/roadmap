import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** Sign-in screens are one narrow column; app screens use the wider one. */
export function Layout({ children, width = 'narrow' }: { children: ReactNode; width?: 'narrow' | 'wide' }) {
  return (
    <>
      <header className="site-header">
        <Link to="/" className="brand">
          Roadmap
        </Link>
      </header>
      <main className={`page page-${width}`}>{children}</main>
    </>
  );
}
