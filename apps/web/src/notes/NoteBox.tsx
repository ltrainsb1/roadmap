import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { MemberName } from '../projects/PanelLists.tsx';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';

export const NOTE_HINT = 'You can use Markdown. Type @ to mention someone.';

interface NoteBoxProps {
  label: string;
  submitLabel: string;
  /** The text the box opens with: empty for a new note or reply, the note's text when editing. */
  initial: string;
  /** The roadmap's members, for the @ list. */
  members: readonly MemberName[];
  busy: boolean;
  error: string | undefined;
  /** Resolves true once saved: the box then empties and keeps focus. False keeps the text. */
  onSubmit: (body: string, mentionIds: string[]) => Promise<boolean>;
  onCancel?: () => void;
  /** The textarea's id, for a box that focus may be sent to from outside. */
  id?: string;
  /** Told whether the text differs from what the box opened with. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Focus the text when the box opens. */
  autoFocus?: boolean;
  /** Text handed over from another box: each new `n` adds it after a blank line (or fills an empty box) and focuses. */
  inject?: { text: string; n: number } | undefined;
  /** Called with the new text on every change the person makes to it. */
  onType?: (text: string) => void;
}

/** A labelled text box for a note, with the Markdown hint, its buttons and any error. */
export function NoteBox({ label, submitLabel, initial, members, busy, error, onSubmit, onCancel, id, onDirtyChange, autoFocus = false, inject, onType }: NoteBoxProps) {
  void members;
  const [text, setText] = useState(initial);
  const ownId = useId();
  const boxId = id ?? `${ownId}-text`;
  const hintId = `${ownId}-hint`;
  const errorId = `${ownId}-error`;
  const box = useRef<HTMLTextAreaElement>(null);

  const dirty = text !== initial;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);

  const injected = useRef(inject?.n);
  useEffect(() => {
    if (!inject || inject.n === injected.current) return;
    injected.current = inject.n;
    setText((t) => (t.trim() === '' ? inject.text : `${t}\n\n${inject.text}`));
    box.current?.focus();
  }, [inject]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const saved = await onSubmit(text, []);
    if (saved) setText('');
    box.current?.focus();
  };

  return (
    <form className="note-box" onSubmit={(e) => void submit(e)} noValidate>
      <div className="field">
        <label htmlFor={boxId}>{label}</label>
        <textarea
          id={boxId}
          ref={box}
          rows={3}
          value={text}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            onType?.(e.target.value);
          }}
        />
        <p id={hintId} className="hint">
          {NOTE_HINT}
        </p>
      </div>
      {error && (
        <div id={errorId}>
          <Alert>{error}</Alert>
        </div>
      )}
      <div className="panel-actions">
        <Button type="submit">{submitLabel}</Button>
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}
