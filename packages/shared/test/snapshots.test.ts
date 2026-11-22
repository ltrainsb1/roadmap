import { describe, expect, test } from 'vitest';
import { createSnapshotRequestSchema, snapshotState } from '../src/index.ts';

describe('snapshot rules', () => {
  test('FR-3.2: a snapshot request needs a name, a real date, and a password of 10 to 128 characters', () => {
    const ok = { name: ' Board review ', asOf: '2026-03-12', password: 'correct-horse', expiresAt: null, include: { notes: false, assignees: false } };
    expect(createSnapshotRequestSchema.parse(ok).name).toBe('Board review');
    expect(createSnapshotRequestSchema.safeParse({ ...ok, password: 'ninechars' }).success).toBe(false);
    expect(createSnapshotRequestSchema.safeParse({ ...ok, password: 'x'.repeat(129) }).success).toBe(false);
    expect(createSnapshotRequestSchema.safeParse({ ...ok, name: '   ' }).success).toBe(false);
    expect(createSnapshotRequestSchema.safeParse({ ...ok, asOf: '2026-02-30' }).success).toBe(false);
    expect(createSnapshotRequestSchema.safeParse({ ...ok, expiresAt: '2026-04-01' }).success).toBe(false);
    expect(createSnapshotRequestSchema.safeParse({ ...ok, expiresAt: '2026-04-01T21:59:59.999Z' }).success).toBe(true);
  });

  test('FR-3.2: a snapshot is expired from the instant its expiry passes', () => {
    const at = new Date('2026-04-01T00:00:00.000Z');
    expect(snapshotState({ expiresAt: null }, at)).toBe('active');
    expect(snapshotState({ expiresAt: '2026-04-01T00:00:00.001Z' }, at)).toBe('active');
    expect(snapshotState({ expiresAt: '2026-04-01T00:00:00.000Z' }, at)).toBe('expired');
  });
});
