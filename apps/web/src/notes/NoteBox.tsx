import { findMentions, mentionRanges, type Mention } from '@roadmap/shared';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { MemberName } from '../projects/PanelLists.tsx';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { MentionPicker } from './MentionPicker.tsx';
import { insertMention, matchMembers, mentionQueryAt } from './mentionQuery.ts';

export const NOTE_HINT = 'You can use Markdown. Type @ to mention someone.';

interface NoteBoxProps {
  label: string;
  submitLabel: string;
  /** The text the box opens with: empty for a new note or reply, the note's text when editing. */
  initial: string;
  /** The roadmap's members, for the @ list. */
  members: readonly MemberName[];
  /** When editing, the people the note mentions: which of two members with the same name each `@Name` means. */
  initialMentions?: readonly Mention[] | undefined;
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
  /** Text handed over from another box: each new `n` adds it after a blank line (or fills an empty box) and focuses.
   * `picks` are who was picked there for each name. */
  inject?: { text: string; n: number; picks?: ReadonlyMap<string, string> } | undefined;
  /** Called with the new text, and who is picked for each name in it, on every change the person makes. */
  onType?: (text: string, picks: ReadonlyMap<string, string>) => void;
}

/** A labelled text box for a note, with the Markdown hint, its buttons and any error. */
export function NoteBox({ label, submitLabel, initial, initialMentions, members, busy, error, onSubmit, onCancel, id, onDirtyChange, autoFocus = false, inject, onType }: NoteBoxProps) {
  const [text, setText] = useState(initial);
  // Where the caret is, or null when the text was set from outside and the caret is not known.
  const [caret, setCaret] = useState<number | null>(null);
  // The @ the list was closed for (Escape, a pick, blur or a scroll), and its query then: typing on keeps it closed.
  const [dismissed, setDismissed] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState<{ key: string; index: number }>({ key: '', index: 0 });
  // Who was picked for each name in the text, so the right one of two members with the same name is sent.
  const picked = useRef(new Map((initialMentions ?? []).map((m) => [m.name, m.userId])));
  // A caret to set once a pick's text is on screen.
  const pendingCaret = useRef<number | null>(null);
  const ownId = useId();
  const boxId = id ?? `${ownId}-text`;
  const hintId = `${ownId}-hint`;
  const errorId = `${ownId}-error`;
  const box = useRef<HTMLTextAreaElement>(null);
  const listId = `${ownId}-people`;
  // From the person, not the place in the list, so a new top match is a new active option.
  const optionId = useCallback((member: MemberName) => `${ownId}-person-${member.userId}`, [ownId]);
  const statusId = `${ownId}-people-status`;

  const query = caret === null ? null : mentionQueryAt(text, caret);
  const open =
    query !== null && !(dismissed && dismissed.start === query.start && query.query.startsWith(dismissed.query));
  const queryText = open ? query.query : null;
  const matches = useMemo(() => (queryText === null ? [] : matchMembers(members, queryText)), [members, queryText]);
  const sharedNames = useMemo(() => {
    const seen = new Set<string>();
    const shared = new Set<string>();
    for (const m of members) (seen.has(m.name) ? shared : seen).add(m.name);
    return shared;
  }, [members]);
  const queryKey = open ? `${query.start}:${query.query}` : '';
  const activeIndex = active.key === queryKey ? active.index : 0;
  const activeMember = open ? matches[activeIndex] : undefined;
  // Said by the polite live region: the active person, as the list shows them, or that no one matches.
  const announcement = !open
    ? ''
    : activeMember
      ? activeMember.name + (sharedNames.has(activeMember.name) && activeMember.email ? ` ${activeMember.email}` : '')
      : 'No one matches.';

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    box.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [text]);

  const dismiss = useCallback(() => {
    setDismissed(caret === null ? null : mentionQueryAt(text, caret));
  }, [text, caret]);

  /** The ids of the people `body` mentions: the one picked for a name, else the first member with it. */
  const mentionIdsIn = (body: string) => {
    const byName = new Map<string, string>();
    for (const m of members) if (!byName.has(m.name)) byName.set(m.name, m.userId);
    for (const [name, userId] of picked.current) {
      if (members.some((m) => m.userId === userId && m.name === name)) byName.set(name, userId);
    }
    return findMentions(body, [...byName].map(([name, userId]) => ({ name, userId }))).map((m) => m.userId);
  };

  const change = (value: string, at: number | null) => {
    setText(value);
    setCaret(at);
    // Once the @ the list was closed for is gone, a new one opens it again.
    const next = at === null ? null : mentionQueryAt(value, at);
    if (!next || next.start !== dismissed?.start) setDismissed(null);
    // A pick is forgotten once its `@Name` has left the text.
    for (const [name, userId] of picked.current) {
      if (mentionRanges(value, [{ name, userId }]).length === 0) picked.current.delete(name);
    }
    onType?.(value, picked.current);
  };

  const pick = (member: MemberName) => {
    if (!query) return;
    const next = insertMention(text, query, member.name);
    if (!picked.current.has(member.name)) picked.current.set(member.name, member.userId);
    // Same text (the name was already in place): no render will apply the caret, so apply it now.
    if (next.text === text) box.current?.setSelectionRange(next.caret, next.caret);
    else pendingCaret.current = next.caret;
    change(next.text, next.caret);
    setDismissed(mentionQueryAt(next.text, next.caret));
    box.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Keys pressed while an input method is composing text belong to it.
    if (!open || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      // Closes only the list; the panel checks for this and leaves itself open.
      e.preventDefault();
      dismiss();
      return;
    }
    if (matches.length === 0) return;
    const count = matches.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive({ key: queryKey, index: (activeIndex + step + count) % count });
    } else if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      const member = matches[activeIndex];
      if (member) pick(member);
    }
  };

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
    for (const [name, userId] of inject.picks ?? []) if (!picked.current.has(name)) picked.current.set(name, userId);
    setCaret(null);
    box.current?.focus();
  }, [inject]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const saved = await onSubmit(text, mentionIdsIn(text));
    if (saved) {
      setText('');
      setCaret(null);
      setDismissed(null);
      picked.current.clear();
    }
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
          // Stays a text box; while the @ list is open it points at it, and a live region says who is active.
          aria-autocomplete={open ? 'list' : undefined}
          aria-haspopup={open ? 'listbox' : undefined}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeMember ? optionId(activeMember) : undefined}
          onChange={(e) => change(e.target.value, e.target.selectionStart)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (open) dismiss();
          }}
        />
        {open && (
          <MentionPicker
            id={listId}
            optionId={optionId}
            anchor={box}
            matches={matches}
            active={activeIndex}
            sharedNames={sharedNames}
            onPick={pick}
            onDismiss={dismiss}
          />
        )}
        <div id={statusId} className="sr-only mention-status" aria-live="polite">
          {announcement}
        </div>
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
