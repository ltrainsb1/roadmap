import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { GENERIC_ERROR } from '../api/errors.ts';
import { signOut } from '../auth/signOut.ts';
import { NotificationBell } from '../notifications/NotificationBell.tsx';
import { Button } from './Button.tsx';

interface LayoutProps {
  children: ReactNode;
  /** Sign-in screens are one narrow column; app screens use the wider one. */
  width?: 'narrow' | 'wide';
  /** Adds the notifications bell, the Security link and the Sign out button to the header. */
  signedIn?: boolean;
  /** Extra header content for a signed-in screen, such as the roadmap picker. */
  headerExtra?: ReactNode;
}

export function Layout({ children, width = 'narrow', signedIn = false, headerExtra }: LayoutProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);

  const onSignOut = async () => {
    try {
      await signOut(queryClient);
      void navigate('/login');
    } catch {
      setFailed(true);
    }
  };

  return (
    <>
      <header className="site-header">
        <div className="header-row">
          <Link to="/" className="brand">
            Roadmap
          </Link>
          {headerExtra}
          {signedIn && (
            <nav aria-label="Account" className="account-nav">
              <NotificationBell />
              <Link to="/settings/security" className="text-link">
                Security
              </Link>
              <Button variant="link" onClick={() => void onSignOut()}>
                Sign out
              </Button>
            </nav>
          )}
        </div>
        {failed && (
          <p role="alert" className="header-error">
            {GENERIC_ERROR}
          </p>
        )}
      </header>
      <main className={`page page-${width}`}>{children}</main>
    </>
  );
}
