import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Alert } from './Alert.tsx';
import { Button } from './Button.tsx';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** What the person is about to do and what follows from it. */
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  /** Shown above the buttons when the action failed. */
  error?: string | undefined;
  /** Leave out the confirm button, for a dialog that only informs. */
  informOnly?: boolean;
  /** Danger styling for the confirm button; the default is the primary one. */
  danger?: boolean;
}

/**
 * A modal dialog on the browser's own `<dialog>`: it traps focus while open, closes on Escape and
 * returns focus to the button that opened it. The parent owns `open`.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
  error,
  informOnly = false,
  danger = true,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId} onClose={onClose}>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm();
          }}
          noValidate
        >
          <h2 id={titleId}>{title}</h2>
          {error && <Alert>{error}</Alert>}
          {children}
          <div className="dialog-actions">
            <Button onClick={onClose}>{informOnly ? 'Close' : 'Cancel'}</Button>
            {!informOnly && (
              <Button type="submit" variant={danger ? 'danger' : 'primary'}>
                {confirmLabel}
              </Button>
            )}
          </div>
        </form>
      )}
    </dialog>
  );
}
