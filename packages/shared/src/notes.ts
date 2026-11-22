import { z } from 'zod';

export const NOTE_LIMITS = {
  body: 5000,
  notesPerItem: 500,
  fileBytes: 25 * 1024 * 1024,
  filesPerItem: 20,
  fileName: 200,
  mentionChoices: 8,
} as const;

export const mentionSchema = z.object({ userId: z.string(), name: z.string() });
export type Mention = z.infer<typeof mentionSchema>;

export const noteSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  parentId: z.string().nullable(),
  authorId: z.string(),
  authorName: z.string(),
  body: z.string(),
  mentions: z.array(mentionSchema),
  createdAt: z.iso.datetime(),
  editedAt: z.iso.datetime().nullable(),
  deleted: z.boolean(),
});
export type Note = z.infer<typeof noteSchema>;

export const noteListSchema = z.object({ notes: z.array(noteSchema) });
export type NoteList = z.infer<typeof noteListSchema>;

export const noteBodySchema = z.object({
  body: z.string().trim().min(1).max(NOTE_LIMITS.body),
  mentionIds: z.array(z.string()).max(50).default([]),
});
export type NoteBody = z.infer<typeof noteBodySchema>;

export const createNoteBodySchema = noteBodySchema.extend({
  parentId: z.string().nullable().default(null),
});
export type CreateNoteBody = z.infer<typeof createNoteBodySchema>;

export const attachmentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  size: z.number(),
  uploadedById: z.string(),
  uploadedByName: z.string(),
  createdAt: z.iso.datetime(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const attachmentListSchema = z.object({
  attachments: z.array(attachmentSchema),
});
export type AttachmentList = z.infer<typeof attachmentListSchema>;

export const downloadLinkSchema = z.object({ url: z.string() });
export type DownloadLink = z.infer<typeof downloadLinkSchema>;

const NAME_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Finds `@Name` in `body` for each candidate. The `@` must start the text or follow white space or "(".
 * The name is matched as plain text, case-sensitively, and must end at a character that is not a letter,
 * digit or underscore. At each `@` the longest matching name wins.
 */
export function mentionRanges(
  body: string,
  mentions: readonly Mention[],
): Array<{ start: number; end: number; userId: string }> {
  const byLength = [...mentions].sort((a, b) => b.name.length - a.name.length);
  const ranges: Array<{ start: number; end: number; userId: string }> = [];
  let i = 0;
  while (i < body.length) {
    const prev = i === 0 ? undefined : body[i - 1];
    if (body[i] !== '@' || (prev !== undefined && prev !== '(' && !/\s/.test(prev))) {
      i += 1;
      continue;
    }
    const found = byLength.find((m) => {
      if (m.name === '' || !body.startsWith(m.name, i + 1)) return false;
      const next = Array.from(body.slice(i + 1 + m.name.length, i + 3 + m.name.length))[0];
      return next === undefined || !NAME_CHAR.test(next);
    });
    if (!found) {
      i += 1;
      continue;
    }
    const end = i + 1 + found.name.length;
    ranges.push({ start: i, end, userId: found.userId });
    i = end;
  }
  return ranges;
}

/** The distinct people mentioned in `body`, in order of first appearance. */
export function findMentions(body: string, candidates: readonly Mention[]): Mention[] {
  const byId = new Map(candidates.map((m) => [m.userId, m]));
  const seen = new Set<string>();
  const found: Mention[] = [];
  for (const { userId } of mentionRanges(body, candidates)) {
    const mention = byId.get(userId);
    if (mention && !seen.has(userId)) {
      seen.add(userId);
      found.push(mention);
    }
  }
  return found;
}

/** A file name safe to show: no control characters, no folder part, at most 200 characters, keeps the extension. */
export function cleanFileName(raw: string): string {
  const noControl = raw.replace(/\p{Cc}/gu, '');
  const base = (noControl.split(/[/\\]/).pop() ?? '').trim();
  if (base === '' || /^\.+$/.test(base)) return 'file';
  const chars = Array.from(base);
  if (chars.length <= NOTE_LIMITS.fileName) return base;
  const ext = /\.[^.\s]{1,16}$/.exec(base)?.[0] ?? '';
  const extLength = Array.from(ext).length;
  return chars.slice(0, NOTE_LIMITS.fileName - extLength).join('') + ext;
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** 1024 steps, at most one decimal, no trailing ".0". */
export function formatFileSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (Math.round(value * 10) / 10 >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${String(Math.round(value * 10) / 10)} ${SIZE_UNITS[unit]}`;
}
