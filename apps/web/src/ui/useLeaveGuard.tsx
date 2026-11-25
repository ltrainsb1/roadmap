import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { isPlainClick } from './isPlainClick.ts';

/**
 * While `dirty`, a plain click on a link within the app waits for the person to agree to discard, and leaving the site
 * (reload, close, another address) asks the browser's own question. The app's router has no navigation blocking (it is
 * not a data router), so links are caught here before React Router's own handler sees them.
 *
 * Returns the question's dialog; render it outside any form, since the dialog has a form of its own.
 */
export function useLeaveGuard(dirty: boolean) {
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || !isPlainClick(e) || !(e.target instanceof Element)) return;
      const link = e.target.closest('a[href]');
      if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
      const to = new URL(link.href);
      if (to.origin !== window.location.origin) return;
      // Link sees the click as handled and leaves it; the person answers the question first.
      e.preventDefault();
      setPending(to.pathname + to.search + to.hash);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  return (
    <ConfirmDialog
      open={pending !== null}
      title="Discard your unsaved changes?"
      confirmLabel="Discard"
      cancelLabel="Keep editing"
      onConfirm={() => {
        const to = pending;
        setPending(null);
        if (to !== null) void navigate(to);
      }}
      onClose={() => setPending(null)}
    >
      {null}
    </ConfirmDialog>
  );
}
