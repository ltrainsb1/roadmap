import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { LIMITS } from '@roadmap/shared';
import { errorCode, messageFor } from '../api/errors.ts';
import { Button } from '../ui/Button.tsx';
import { levelName } from './names.ts';

interface AddItemRowProps {
  /** The depth the new item will have. */
  depth: number;
  /** Saves the title; rejects with the API error when the server refuses it. */
  onAdd: (title: string) => Promise<unknown>;
  onCancel: () => void;
}

/**
 * The row where a new item is typed in place. Enter saves and leaves the row open for another entry at the
 * same level; Escape (or Cancel) closes it. The input has an accessible name and a visible hint, not a label above.
 */
export function AddItemRow({ depth, onAdd, onCancel }: AddItemRowProps) {
  const [error, setError] = useState<string | undefined>();
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const hintId = useId();
  const errorId = useId();

  useEffect(() => input.current?.focus(), []);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (saving.current) return;
    const field = input.current!;
    const title = field.value.trim();
    if (!title) {
      setError('Enter a title.');
      field.focus();
      return;
    }
    saving.current = true;
    try {
      await onAdd(title);
      field.value = '';
      setError(undefined);
    } catch (err) {
      setError(errorCode(err) === 'validation' ? 'Enter a title.' : messageFor(err));
    } finally {
      saving.current = false;
      field.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <tr className={`add-row depth-${depth}`}>
      <td colSpan={6}>
        <form className="add-form" onSubmit={(e) => void submit(e)} noValidate>
          <div className="add-field">
            <input
              ref={input}
              type="text"
              name="title"
              autoComplete="off"
              maxLength={LIMITS.title}
              aria-label={`Title of the new ${levelName(depth).toLowerCase()}`}
              aria-describedby={error ? `${hintId} ${errorId}` : hintId}
              aria-invalid={error ? true : undefined}
              onKeyDown={onKeyDown}
            />
            <p id={hintId} className="hint">
              Press Enter to save
            </p>
            {error && (
              <p id={errorId} className="field-error" role="alert">
                <svg className="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                  <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M8 4.5v4M8 10.5v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <span>{error}</span>
              </p>
            )}
          </div>
          <Button onClick={onCancel}>Cancel</Button>
        </form>
      </td>
    </tr>
  );
}
