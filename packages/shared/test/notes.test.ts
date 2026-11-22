import { describe, expect, test } from 'vitest';
import {
  NOTE_LIMITS,
  attachmentListSchema,
  cleanFileName,
  createNoteBodySchema,
  downloadLinkSchema,
  findMentions,
  formatFileSize,
  mentionRanges,
  noteBodySchema,
  noteListSchema,
} from '../src/notes.ts';

const ann = { userId: 'u1', name: 'Ann' };
const anna = { userId: 'u2', name: 'Anna' };
const odd = { userId: 'u3', name: 'J. (Jo) O_Neil*' };

describe('mentions', () => {
  test('FR-1.5: a mention needs @Name in the text, as a whole name', () => {
    expect(findMentions('ask @Anna today', [ann, anna])).toEqual([anna]);
    expect(findMentions('ask @Ann, then @Anna.', [ann, anna])).toEqual([ann, anna]);
    expect(findMentions('mail ann@Ann.example', [ann])).toEqual([]);
    expect(findMentions('thanks @annabel', [ann, anna])).toEqual([]);
    expect(findMentions('cc @J. (Jo) O_Neil* please', [odd])).toEqual([odd]);
    expect(findMentions('@ANN', [ann])).toEqual([]);
  });

  test('FR-1.5: an @ after "(" or at the start of the text counts, and a person is listed once', () => {
    expect(findMentions('(@Ann) and @Ann', [ann])).toEqual([ann]);
    expect(findMentions('@Ann', [ann])).toEqual([ann]);
    expect(findMentions('@Ann_x', [ann])).toEqual([]);
    expect(findMentions('@Ann7', [ann])).toEqual([]);
  });

  test('FR-1.5: ranges cover the @ and the whole name, longest name first', () => {
    expect(mentionRanges('hi @Anna and @Ann', [ann, anna])).toEqual([
      { start: 3, end: 8, userId: 'u2' },
      { start: 13, end: 17, userId: 'u1' },
    ]);
  });

  test('FR-1.5: ranges do not overlap and skip text inside a matched name', () => {
    expect(mentionRanges('@Ann @Ann', [ann])).toEqual([
      { start: 0, end: 4, userId: 'u1' },
      { start: 5, end: 9, userId: 'u1' },
    ]);
    expect(mentionRanges('nothing here', [ann])).toEqual([]);
  });

  test('FR-1.5: a combining mark after the name is part of a longer name, not a mention', () => {
    const anne = { userId: 'u4', name: 'Anne' };
    expect(findMentions('@Anne\u0301 hi', [ann, anne])).toEqual([]);
    expect(findMentions('@Ann\u0301', [ann])).toEqual([]);
    expect(findMentions('@Ann\u0301 and @Ann', [ann])).toEqual([ann]);
  });
});

describe('file names and sizes', () => {
  test('FR-1.4: file names are cleaned for display', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('C:\\tmp\\a\\b.txt')).toBe('b.txt');
    expect(cleanFileName('re\nport\u0000.pdf')).toBe('report.pdf');
    expect(cleanFileName('  ')).toBe('file');
    expect(cleanFileName('x'.repeat(300) + '.pdf')).toHaveLength(200);
    expect(cleanFileName('x'.repeat(300) + '.pdf').endsWith('.pdf')).toBe(true);
    expect(cleanFileName('plan 🚀.md')).toBe('plan 🚀.md');
  });

  test('FR-1.4: bidirectional override and isolate characters are removed, emoji joiners kept', () => {
    expect(cleanFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(cleanFileName('a\u202A\u202B\u202C\u202D\u2066\u2067\u2068\u2069b.txt')).toBe('ab.txt');
    expect(cleanFileName('team 👩\u200D💻.png')).toBe('team 👩\u200D💻.png');
  });

  test('FR-1.4: a long name cut before white space does not keep the white space', () => {
    expect(cleanFileName('x'.repeat(195) + ' '.repeat(10) + '.pdf')).toBe('x'.repeat(195) + '.pdf');
  });

  test('FR-1.4: a name that is only a folder path, or only dots, falls back to "file"', () => {
    expect(cleanFileName('a/b/')).toBe('file');
    expect(cleanFileName('..')).toBe('file');
  });

  test('file sizes', () => {
    expect([0, 1023, 1024, 1536, 25 * 1024 * 1024].map(formatFileSize)).toEqual([
      '0 B',
      '1023 B',
      '1 KB',
      '1.5 KB',
      '25 MB',
    ]);
    expect(formatFileSize(1024 ** 3)).toBe('1 GB');
  });
});

describe('schemas', () => {
  test('FR-1.5: a note body is trimmed, 1 to 5000 characters, mentionIds default to empty', () => {
    expect(noteBodySchema.parse({ body: '  hi  ' })).toEqual({
      body: 'hi',
      mentionIds: [],
    });
    expect(noteBodySchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(noteBodySchema.safeParse({ body: 'x'.repeat(NOTE_LIMITS.body) }).success).toBe(true);
    expect(noteBodySchema.safeParse({ body: 'x'.repeat(NOTE_LIMITS.body + 1) }).success).toBe(false);
    expect(noteBodySchema.safeParse({ body: 'a', mentionIds: Array(51).fill('u') }).success).toBe(false);
  });

  test('FR-1.5: a new note may name a parent and defaults to none', () => {
    expect(createNoteBodySchema.parse({ body: 'a' }).parentId).toBeNull();
    expect(createNoteBodySchema.parse({ body: 'a', parentId: 'n1' }).parentId).toBe('n1');
  });

  test('lists and links parse', () => {
    const note = {
      id: 'n1',
      projectId: 'p1',
      parentId: null,
      authorId: 'u1',
      authorName: 'Ann',
      body: 'hi',
      mentions: [ann],
      createdAt: '2026-01-01T00:00:00.000Z',
      editedAt: null,
      deleted: false,
    };
    expect(noteListSchema.parse({ notes: [note] }).notes).toHaveLength(1);
    const attachment = {
      id: 'a1',
      projectId: 'p1',
      name: 'b.txt',
      size: 3,
      uploadedById: 'u1',
      uploadedByName: 'Ann',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(attachmentListSchema.parse({ attachments: [attachment] }).attachments).toHaveLength(1);
    expect(downloadLinkSchema.parse({ url: 'https://example.com/x' }).url).toBe('https://example.com/x');
  });
});
