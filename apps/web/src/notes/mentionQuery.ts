import { NOTE_LIMITS } from '@roadmap/shared';
import type { MemberName } from '../projects/PanelLists.tsx';

/** The longest text after an `@` that still counts as looking for someone. */
const MAX_QUERY = 40;

/**
 * The `@…` being typed at the caret, or null. The `@` must start the text or follow white space or "(", as the
 * server requires for a mention; the query is everything from it to the caret, spaces included (names have spaces),
 * but not a new line, not a space straight after the `@`, and not more than 40 characters.
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const stop = Math.max(0, caret - MAX_QUERY - 1);
  for (let i = caret - 1; i >= stop; i -= 1) {
    const ch = text[i];
    if (ch === '\n') return null;
    if (ch !== '@') continue;
    const prev = i === 0 ? undefined : text[i - 1];
    if (prev !== undefined && prev !== '(' && !/\s/.test(prev)) return null;
    const query = text.slice(i + 1, caret);
    if (/^\s/.test(query)) return null;
    return { start: i, query };
  }
  return null;
}

/** Members whose names contain `query`, case ignored, in name order, at most `NOTE_LIMITS.mentionChoices`. */
export function matchMembers(members: readonly MemberName[], query: string): MemberName[] {
  const q = query.toLocaleLowerCase();
  return members
    .filter((m) => m.name.toLocaleLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, NOTE_LIMITS.mentionChoices);
}

/** Replaces the `@query` at `at` with `@name` and a space (unless white space already follows), caret after it. */
export function insertMention(text: string, at: { start: number; query: string }, name: string): { text: string; caret: number } {
  const after = text.slice(at.start + 1 + at.query.length);
  const space = /^\s/.test(after) ? '' : ' ';
  const head = `${text.slice(0, at.start)}@${name}`;
  return { text: `${head}${space}${after}`, caret: head.length + 1 };
}
