import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ProjectDoc } from '../../src/db/types.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';
import { world } from './world.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

const BOTH = { notes: true, assignees: true };

describe('what a snapshot copies', () => {
  test('FR-3.1: a snapshot copies every live item and leaves out archived items and everything under them', async () => {
    const w = await world(t);
    const top = await w.item({ title: 'Top', startDate: '2026-01-05', endDate: '2026-02-20' });
    const child = await w.item({ parentId: top._id, title: 'Child' });
    const grandchild = await w.item({ parentId: child._id, title: 'Grandchild' });
    const archived = await w.item({ parentId: top._id, title: 'Shelved', archived: true });
    // Not flagged itself, but under an archived item: it is left out all the same.
    const underArchived = await w.item({ parentId: archived._id, title: 'Under shelved' });
    const other = await w.item({ title: 'Other' });
    await t.db.collection<ProjectDoc>('projects').updateOne({ _id: other._id }, { $set: { blockedBy: [archived._id] } });
    await t.db
      .collection<ProjectDoc>('projects')
      .updateOne({ _id: grandchild._id }, { $set: { blockedBy: [other._id, underArchived._id], tags: ['q1'], priorityLabel: 'P2' } });

    const res = await w.create('A');
    expect(res.statusCode).toBe(201);
    const { id, linkId } = res.json<{ id: string; linkId: string }>();
    expect(linkId).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const rows = await w.frozenItems(id);
    expect(rows.map((r) => r.itemId).sort()).toEqual([top._id, child._id, grandchild._id, other._id].sort());
    expect(rows.find((r) => r.itemId === other._id)!.blockedBy).toEqual([]);
    const g = rows.find((r) => r.itemId === grandchild._id)!;
    expect(g).toEqual({
      _id: expect.any(String) as string,
      tenantId: w.tenantId,
      roadmapId: w.roadmap._id,
      snapshotId: id,
      itemId: grandchild._id,
      parentId: child._id,
      depth: 3,
      title: 'Grandchild',
      description: '',
      status: 'not_started',
      startDate: null,
      endDate: null,
      milestones: [],
      tags: ['q1'],
      links: [],
      blockedBy: [other._id],
      priorityLabel: 'P2',
      rank: 0,
    });
    expect(rows.find((r) => r.itemId === top._id)).toMatchObject({ startDate: '2026-01-05', endDate: '2026-02-20' });

    expect(await w.snapshot(id)).toMatchObject({
      roadmapId: w.roadmap._id,
      linkId,
      name: 'Board review',
      roadmapName: 'Launch plan',
      include: { notes: false, assignees: false },
      expiresAt: null,
      itemCount: 4,
      noteCount: 0,
      failedUnlocks: 0,
      lockedUntil: null,
      openCount: 0,
      lastOpenedAt: null,
      pdfs: {},
      createdBy: w.ids.A,
    });
  });

  test('FR-3.1: later edits do not change a snapshot', async () => {
    const w = await world(t);
    const kept = await w.item({ title: 'Kept', startDate: '2026-03-01', endDate: '2026-03-31', assigneeIds: [w.ids.C] });
    const toArchive = await w.item({ title: 'To archive' });
    const toDelete = await w.item({ title: 'To delete' });
    const top = await w.note(kept._id, w.ids.A, { body: 'First thoughts' });
    const reply = await w.note(kept._id, w.ids.A, { parentId: top._id, body: 'A reply' });
    const id = await w.createId({ include: BOTH });
    const itemsBefore = await w.frozenItems(id);
    const notesBefore = await w.frozenNotes(id);
    expect(itemsBefore).toHaveLength(3);
    expect(notesBefore).toHaveLength(2);

    const ok = (status: number) => (res: { statusCode: number; body: string }) => {
      expect(res.statusCode, res.body).toBe(status);
    };
    ok(200)(
      await w.call('O', 'PATCH', `/projects/${kept._id}`, {
        version: kept.version,
        title: 'Renamed',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
      }),
    );
    ok(204)(await w.call('O', 'POST', `/projects/${toArchive._id}/archive`));
    ok(200)(await w.call('O', 'DELETE', `/projects/${toDelete._id}`));
    ok(200)(await w.call('A', 'PATCH', `/projects/${kept._id}/notes/${top._id}`, { body: 'Second thoughts' }));
    ok(204)(await w.call('A', 'DELETE', `/projects/${kept._id}/notes/${reply._id}`));
    ok(204)(await w.call('O', 'DELETE', `/members/${w.ids.C}`));

    expect(await w.frozenItems(id)).toEqual(itemsBefore);
    expect(await w.frozenNotes(id)).toEqual(notesBefore);
  });

  test('FR-3.5: a snapshot made without notes or assignee names holds neither', async () => {
    const w = await world(t);
    const item = await w.item({ title: 'Assigned', assigneeIds: [w.ids.C] });
    await w.note(item._id, w.ids.A, { body: 'Private remark about pricing' });
    const id = await w.createId();

    expect(await w.frozenNotes(id)).toEqual([]);
    const rows = await w.frozenItems(id);
    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect(row).not.toHaveProperty('assignees');
      expect(row).not.toHaveProperty('noteCount');
    }
    const text = JSON.stringify(rows);
    expect(text).not.toContain('Private remark about pricing');
    expect(text).not.toContain('Cal Contributor');
  });

  test('FR-3.5: a snapshot made with both holds note text, author names, mentioned names and assignee names, and no user id or email', async () => {
    const w = await world(t);
    const item = await w.item({ title: 'Assigned', assigneeIds: [w.ids.C, w.ids.A] });
    const bare = await w.item({ title: 'Bare' });
    const editedAt = new Date('2026-02-02T10:00:00Z');
    const top = await w.note(item._id, w.ids.A, {
      body: 'Ask @Cal Contributor about dates',
      mentions: [{ userId: w.ids.C, name: 'Cal Contributor' }],
      createdAt: new Date('2026-02-01T09:00:00Z'),
      editedAt,
    });
    const reply = await w.note(item._id, w.ids.O, {
      parentId: top._id,
      body: 'Will do',
      createdAt: new Date('2026-02-01T09:05:00Z'),
    });
    const id = await w.createId({ include: BOTH });

    const rows = await w.frozenItems(id);
    expect(rows.find((r) => r.itemId === item._id)).toMatchObject({ assignees: ['Cal Contributor', 'Ann Admin'], noteCount: 2 });
    expect(rows.find((r) => r.itemId === bare._id)).toMatchObject({ assignees: [], noteCount: 0 });
    const notes = await w.frozenNotes(id);
    expect(notes).toEqual([
      {
        _id: expect.any(String) as string,
        tenantId: w.tenantId,
        roadmapId: w.roadmap._id,
        snapshotId: id,
        itemId: item._id,
        noteId: top._id,
        parentId: null,
        authorName: 'Ann Admin',
        body: 'Ask @Cal Contributor about dates',
        mentions: ['Cal Contributor'],
        createdAt: new Date('2026-02-01T09:00:00Z'),
        edited: true,
        deleted: false,
      },
      {
        _id: expect.any(String) as string,
        tenantId: w.tenantId,
        roadmapId: w.roadmap._id,
        snapshotId: id,
        itemId: item._id,
        noteId: reply._id,
        parentId: top._id,
        authorName: 'Olive Owner',
        body: 'Will do',
        mentions: [],
        createdAt: new Date('2026-02-01T09:05:00Z'),
        edited: false,
        deleted: false,
      },
    ]);
    expect((await w.snapshot(id))!.noteCount).toBe(2);

    const text = JSON.stringify([...rows, ...notes]);
    for (const secret of [...Object.values(w.ids), ...Object.values(w.emails)]) {
      expect(text).not.toContain(secret);
    }
  });

  test('FR-3.5: a deleted top note with replies is copied as a placeholder with its replies', async () => {
    const w = await world(t);
    const item = await w.item();
    const gone = await w.note(item._id, w.ids.A, {
      body: 'Left over text',
      mentions: [{ userId: w.ids.C, name: 'Cal Contributor' }],
      deletedAt: new Date(),
    });
    const reply = await w.note(item._id, w.ids.C, { parentId: gone._id, body: 'Still here' });
    const id = await w.createId({ include: BOTH });

    const notes = await w.frozenNotes(id);
    expect(notes).toHaveLength(2);
    expect(notes.find((n) => n.noteId === gone._id)).toMatchObject({
      parentId: null,
      authorName: null,
      body: '',
      mentions: [],
      deleted: true,
    });
    expect(notes.find((n) => n.noteId === reply._id)).toMatchObject({
      parentId: gone._id,
      authorName: 'Cal Contributor',
      body: 'Still here',
      deleted: false,
    });
    expect(JSON.stringify(notes)).not.toContain('Left over text');
  });
});

describe('freezing while the roadmap changes', () => {
  const FIELDS = ['title', 'description', 'startDate', 'endDate'] as const;
  const pick = (doc: Partial<Record<(typeof FIELDS)[number], unknown>>) =>
    Object.fromEntries(FIELDS.map((f) => [f, doc[f]]));

  test('FR-3.1: an item edited at the same moment as the freeze is copied whole, old or new', { timeout: 60_000 }, async () => {
    const w = await world(t);
    const item = await w.item({ title: 'Round 0', startDate: '2026-01-01', endDate: '2026-01-02' });
    for (let round = 1; round <= 20; round += 1) {
      const before = (await w.project(item._id))!;
      const day = String(round + 2).padStart(2, '0');
      const [created, edited] = await Promise.all([
        w.create('A'),
        w.call('O', 'PATCH', `/projects/${item._id}`, {
          version: before.version,
          title: `Round ${round}`,
          description: `Edited in round ${round}`,
          startDate: `2026-02-${day}`,
          endDate: `2026-03-${day}`,
        }),
      ]);
      expect(created.statusCode, created.body).toBe(201);
      expect(edited.statusCode, edited.body).toBe(200);
      const after = (await w.project(item._id))!;
      const [frozen] = await w.frozenItems(created.json<{ id: string }>().id);
      expect([pick(before), pick(after)]).toContainEqual(pick(frozen!));
    }
  });
});
