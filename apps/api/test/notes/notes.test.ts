import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Note } from '@roadmap/shared';
import type { AuditEventDoc, NoteDoc, ProjectDoc, UserDoc } from '../../src/db/types.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

let t: TestApp;
let limited: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
  limited = await makeTestApp({ maxNotesPerItem: 2 });
}, 120_000);
afterAll(async () => {
  await t?.close();
  await limited?.close();
});

type Who = 'O' | 'A' | 'C' | 'D';

/** A roadmap with owner O, admin A and contributors C and D, none assigned to anything. */
async function world(app: TestApp = t) {
  const tenantId = (await app.seed.tenant())._id;
  const users = {
    O: await app.seed.user(tenantId),
    A: await app.seed.user(tenantId),
    C: await app.seed.user(tenantId),
    D: await app.seed.user(tenantId),
  };
  const names: Record<Who, string> = { O: 'Olive Owner', A: 'Ann', C: 'Anna', D: 'Dev (QA)' };
  for (const who of Object.keys(users) as Who[]) await rename(app, users[who]._id, names[who]);
  const roadmap = await app.seed.roadmap(tenantId, users.O._id);
  await app.seed.member(tenantId, roadmap._id, users.A._id, 'admin');
  await app.seed.member(tenantId, roadmap._id, users.C._id, 'contributor');
  await app.seed.member(tenantId, roadmap._id, users.D._id, 'contributor');
  const sess = {
    O: await signInAs(app.app, app.db, users.O._id),
    A: await signInAs(app.app, app.db, users.A._id),
    C: await signInAs(app.app, app.db, users.C._id),
    D: await signInAs(app.app, app.db, users.D._id),
  };
  const ids = { O: users.O._id, A: users.A._id, C: users.C._id, D: users.D._id };
  const item = (o: { parentId?: string; archived?: boolean } = {}) => app.seed.project(tenantId, roadmap._id, o);
  const base = (projectId: string, roadmapId = roadmap._id) => `/api/roadmaps/${roadmapId}/projects/${projectId}/notes`;
  const headers = (who: Who) => ({ cookie: sess[who].cookie, 'x-csrf-token': sess[who].csrf });
  const list = (who: Who, projectId: string) => app.app.inject({ method: 'GET', url: base(projectId), headers: headers(who) });
  const add = (who: Who, projectId: string, payload: Record<string, unknown>) =>
    app.app.inject({ method: 'POST', url: base(projectId), headers: headers(who), payload });
  const edit = (who: Who, projectId: string, noteId: string, payload: Record<string, unknown>) =>
    app.app.inject({ method: 'PATCH', url: `${base(projectId)}/${noteId}`, headers: headers(who), payload });
  const remove = (who: Who, projectId: string, noteId: string) =>
    app.app.inject({ method: 'DELETE', url: `${base(projectId)}/${noteId}`, headers: headers(who) });
  const notes = () => app.db.collection<NoteDoc>('notes');
  const stored = (id: string) => notes().findOne({ _id: id });
  const events = (action: string) =>
    app.db.collection<AuditEventDoc>('auditEvents').find({ tenantId, roadmapId: roadmap._id, action }).toArray();
  const note = (projectId: string, authorId: string, over: Partial<NoteDoc> = {}) =>
    app.seed.note(tenantId, roadmap._id, projectId, authorId, over);
  return { tenantId, ids, roadmap, sess, item, base, headers, list, add, edit, remove, notes, stored, events, note };
}

async function rename(app: TestApp, userId: string, name: string) {
  await app.db.collection<UserDoc>('users').updateOne({ _id: userId }, { $set: { name } });
}

describe('adding notes', () => {
  test('FR-1.5: each role adds a note to an item it is not assigned to', async () => {
    const w = await world();
    const item = await w.item();
    for (const who of ['O', 'A', 'C'] as const) {
      const res = await w.add(who, item._id, { body: `  from ${who}  ` });
      expect(res.statusCode).toBe(201);
      const note = res.json<Note>();
      expect(note).toMatchObject({
        projectId: item._id,
        parentId: null,
        authorId: w.ids[who],
        authorName: { O: 'Olive Owner', A: 'Ann', C: 'Anna' }[who],
        body: `from ${who}`,
        mentions: [],
        editedAt: null,
        deleted: false,
      });
      expect(Date.parse(note.createdAt)).not.toBeNaN();
    }
    const listed = await w.list('C', item._id);
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ notes: Note[] }>().notes.map((n) => n.body)).toEqual(['from O', 'from A', 'from C']);
  });

  test('FR-1.5: a reply has its parentId; a reply to a reply, to a note on another item or to a missing note is 422 unknown_note', async () => {
    const w = await world();
    const item = await w.item();
    const other = await w.item();
    const top = (await w.add('O', item._id, { body: 'Top' })).json<Note>();
    const reply = await w.add('C', item._id, { body: 'Reply', parentId: top.id });
    expect(reply.statusCode).toBe(201);
    expect(reply.json<Note>().parentId).toBe(top.id);

    const onOther = (await w.add('O', other._id, { body: 'Elsewhere' })).json<Note>();
    for (const parentId of [reply.json<Note>().id, onOther.id, 'no-such-note']) {
      const res = await w.add('C', item._id, { body: 'Again', parentId });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'unknown_note' });
    }
    expect(await w.notes().countDocuments({ projectId: item._id })).toBe(2);
  });

  test('FR-1.5: a mention is stored with the member\'s current name only when @Name is in the text', async () => {
    const w = await world();
    const item = await w.item();
    const otherTenant = (await t.seed.tenant('Other'))._id;
    const foreign = await t.seed.user(otherTenant);
    await rename(t, foreign._id, 'Zed');
    const outsider = await t.seed.user(w.tenantId);
    await rename(t, outsider._id, 'Out');

    const res = await w.add('C', item._id, {
      body: 'ask @Ann and @Dev (QA), not @Out or @Zed',
      mentionIds: [w.ids.A, w.ids.D, w.ids.O, outsider._id, foreign._id],
    });
    expect(res.statusCode).toBe(201);
    const expected = [
      { userId: w.ids.A, name: 'Ann' },
      { userId: w.ids.D, name: 'Dev (QA)' },
    ];
    expect(res.json<Note>().mentions).toEqual(expected);
    expect((await w.stored(res.json<Note>().id))!.mentions).toEqual(expected);
  });

  test('FR-1.5: with two members of the same name, the id the client sent is recorded', async () => {
    const w = await world();
    const item = await w.item();
    await rename(t, w.ids.D, 'Ann');
    const res = await w.add('C', item._id, { body: 'hi @Ann', mentionIds: [w.ids.D] });
    expect(res.json<Note>().mentions).toEqual([{ userId: w.ids.D, name: 'Ann' }]);
  });

  test('FR-1.5: an empty or white-space body and a body of 5,001 characters are 400 validation', async () => {
    const w = await world();
    const item = await w.item();
    for (const body of ['', '   \n ', 'x'.repeat(5001)]) {
      const res = await w.add('C', item._id, { body });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('validation');
    }
    expect((await w.add('C', item._id, { body: 'x'.repeat(5000) })).statusCode).toBe(201);
    const edited = await w.edit('C', item._id, (await w.notes().findOne({ projectId: item._id }))!._id, { body: ' ' });
    expect(edited.statusCode).toBe(400);
  });

  test('FR-1.5: the note after the limit is 422 too_many_notes', async () => {
    const w = await world(limited);
    const item = await w.item();
    expect((await w.add('C', item._id, { body: 'one' })).statusCode).toBe(201);
    expect((await w.add('C', item._id, { body: 'two' })).statusCode).toBe(201);
    const res = await w.add('C', item._id, { body: 'three' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'too_many_notes' });
    expect(await w.notes().countDocuments({ projectId: item._id })).toBe(2);
    // The limit is per item.
    expect((await w.add('C', (await w.item())._id, { body: 'elsewhere' })).statusCode).toBe(201);
  });

  test('FR-1.5: adding notes leaves the item\'s version and updatedAt unchanged', async () => {
    const w = await world();
    const item = await w.item();
    const note = (await w.add('C', item._id, { body: 'one' })).json<Note>();
    await w.add('A', item._id, { body: 'two', parentId: note.id });
    await w.edit('C', item._id, note.id, { body: 'one, edited' });
    const after = await t.db.collection<ProjectDoc>('projects').findOne({ _id: item._id });
    expect(after!.version).toBe(1);
    expect(after!.updatedAt).toEqual(item.updatedAt);
    const listed = await t.app.inject({
      method: 'GET',
      url: `/api/roadmaps/${w.roadmap._id}/projects`,
      headers: w.headers('C'),
    });
    expect(listed.json<{ items: Array<Record<string, unknown>> }>().items[0]).not.toHaveProperty('contentRevision');
  });
});

describe('editing notes', () => {
  test('FR-1.5: only the author edits; another Contributor, an Admin and the Owner get 403', async () => {
    const w = await world();
    const item = await w.item();
    const note = (await w.add('C', item._id, { body: 'mine' })).json<Note>();
    for (const who of ['D', 'A', 'O'] as const) {
      const res = await w.edit(who, item._id, note.id, { body: 'theirs' });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden' });
    }
    expect((await w.stored(note.id))!.body).toBe('mine');
    expect(await w.events('note.update')).toHaveLength(0);
  });

  test('FR-1.5: the author\'s edit sets editedAt and recomputes mentions; an edit that changes nothing leaves editedAt null', async () => {
    const w = await world();
    const item = await w.item();
    const note = (await w.add('C', item._id, { body: 'ask @Ann', mentionIds: [w.ids.A] })).json<Note>();

    const same = await w.edit('C', item._id, note.id, { body: ' ask @Ann ', mentionIds: [w.ids.A] });
    expect(same.statusCode).toBe(200);
    expect(same.json<Note>().editedAt).toBeNull();
    expect(await w.events('note.update')).toHaveLength(0);

    const res = await w.edit('C', item._id, note.id, { body: 'ask @Dev (QA) instead', mentionIds: [w.ids.A, w.ids.D] });
    expect(res.statusCode).toBe(200);
    const edited = res.json<Note>();
    expect(edited.body).toBe('ask @Dev (QA) instead');
    expect(edited.mentions).toEqual([{ userId: w.ids.D, name: 'Dev (QA)' }]);
    expect(edited.editedAt).not.toBeNull();
    expect(edited.authorName).toBe('Anna');
    expect((await w.stored(note.id))!.editedAt).toBeInstanceOf(Date);
  });

  test('FR-1.5: a note id from another item is 404', async () => {
    const w = await world();
    const item = await w.item();
    const other = await w.item();
    const note = (await w.add('C', item._id, { body: 'mine' })).json<Note>();
    expect((await w.edit('C', other._id, note.id, { body: 'x' })).statusCode).toBe(404);
    expect((await w.remove('C', other._id, note.id)).statusCode).toBe(404);
  });
});

describe('deleting notes', () => {
  test('FR-1.5: the author, an Admin and the Owner can delete; another Contributor gets 403', async () => {
    const w = await world();
    const item = await w.item();
    const notes = await Promise.all(['a', 'b', 'c', 'd'].map(async (body) => (await w.add('C', item._id, { body })).json<Note>()));
    const denied = await w.remove('D', item._id, notes[0]!.id);
    expect(denied.statusCode).toBe(403);
    expect(await w.stored(notes[0]!.id)).not.toBeNull();
    for (const [i, who] of (['C', 'A', 'O'] as const).entries()) {
      const res = await w.remove(who, item._id, notes[i]!.id);
      expect(res.statusCode).toBe(204);
      expect(await w.stored(notes[i]!.id)).toBeNull();
    }
    expect(await w.notes().countDocuments({ projectId: item._id })).toBe(1);
  });

  test('FR-1.5: a deleted note with replies stays as a placeholder until its last reply is deleted', async () => {
    const w = await world();
    const item = await w.item();
    const top = (await w.add('C', item._id, { body: 'top @Ann', mentionIds: [w.ids.A] })).json<Note>();
    const r1 = (await w.add('A', item._id, { body: 'r1', parentId: top.id })).json<Note>();
    const r2 = (await w.add('O', item._id, { body: 'r2', parentId: top.id })).json<Note>();

    expect((await w.remove('A', item._id, r1.id)).statusCode).toBe(204);
    expect(await w.stored(r1.id)).toBeNull();

    expect((await w.remove('C', item._id, top.id)).statusCode).toBe(204);
    const placeholder = await w.stored(top.id);
    expect(placeholder).toMatchObject({ body: '', mentions: [] });
    expect(placeholder!.deletedAt).toBeInstanceOf(Date);
    const listed = (await w.list('D', item._id)).json<{ notes: Note[] }>().notes;
    expect(listed.map((n) => [n.id, n.deleted, n.body, n.mentions])).toEqual([
      [top.id, true, '', []],
      [r2.id, false, 'r2', []],
    ]);

    // A deleted note can't be edited or deleted again.
    expect((await w.edit('C', item._id, top.id, { body: 'back' })).statusCode).toBe(404);
    expect((await w.remove('O', item._id, top.id)).statusCode).toBe(404);

    expect((await w.remove('O', item._id, r2.id)).statusCode).toBe(204);
    expect(await w.notes().countDocuments({ projectId: item._id })).toBe(0);
    expect((await w.list('D', item._id)).json()).toEqual({ notes: [] });
  });

  test('FR-1.5: a reply to a deleted note that still has replies is 201 and lists under it', async () => {
    const w = await world();
    const item = await w.item();
    const top = (await w.add('C', item._id, { body: 'top' })).json<Note>();
    const r1 = (await w.add('A', item._id, { body: 'r1', parentId: top.id })).json<Note>();
    expect((await w.remove('C', item._id, top.id)).statusCode).toBe(204);

    const late = await w.add('D', item._id, { body: 'late', parentId: top.id });
    expect(late.statusCode).toBe(201);
    expect(late.json<Note>().parentId).toBe(top.id);
    const listed = (await w.list('O', item._id)).json<{ notes: Note[] }>().notes;
    expect(listed.map((n) => [n.id, n.parentId, n.deleted])).toEqual([
      [top.id, null, true],
      [r1.id, top.id, false],
      [late.json<Note>().id, top.id, false],
    ]);

    // With one reply left, deleting the other keeps the placeholder; deleting the last removes it.
    expect((await w.remove('A', item._id, r1.id)).statusCode).toBe(204);
    expect(await w.stored(top.id)).not.toBeNull();
    expect((await w.remove('D', item._id, late.json<Note>().id)).statusCode).toBe(204);
    expect(await w.notes().countDocuments({ projectId: item._id })).toBe(0);
    const gone = await w.add('D', item._id, { body: 'after', parentId: top.id });
    expect(gone.statusCode).toBe(422);
    expect(gone.json()).toEqual({ error: 'unknown_note' });
  });

  test('FR-1.5: a reply added while the last reply under a deleted note is deleted never loses its parent', async () => {
    const w = await world();
    const item = await w.item();
    for (let i = 0; i < 20; i += 1) {
      const top = (await w.add('C', item._id, { body: `top ${i}` })).json<Note>();
      const last = (await w.add('A', item._id, { body: `last ${i}`, parentId: top.id })).json<Note>();
      expect((await w.remove('C', item._id, top.id)).statusCode).toBe(204);
      const [deleted, added] = await Promise.all([
        w.remove('A', item._id, last.id),
        w.add('D', item._id, { body: `race ${i}`, parentId: top.id }),
      ]);
      expect(deleted.statusCode).toBe(204);
      expect([201, 422]).toContain(added.statusCode);
      const thread = await w.notes().find({ projectId: item._id, $or: [{ _id: top.id }, { parentId: top.id }] }).toArray();
      if (added.statusCode === 201) {
        expect(thread.map((n) => n._id).sort()).toEqual([top.id, added.json<Note>().id].sort());
        expect(thread.find((n) => n._id === top.id)!.deletedAt).toBeInstanceOf(Date);
      } else {
        expect(added.json()).toEqual({ error: 'unknown_note' });
        expect(thread).toEqual([]);
      }
    }
    // No reply anywhere points at a note that is gone.
    const all = await w.notes().find({ projectId: item._id }).toArray();
    const ids = new Set(all.map((n) => n._id));
    expect(all.filter((n) => n.parentId !== null && !ids.has(n.parentId))).toEqual([]);
  });
});

describe('archived items', () => {
  test('FR-1.5: notes on an archived item can be listed; adding, editing and deleting are 409 item_archived', async () => {
    const w = await world();
    const item = await w.item({ archived: true });
    const note = await w.note(item._id, w.ids.C, { body: 'old' });
    const listed = await w.list('C', item._id);
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ notes: Note[] }>().notes.map((n) => n.body)).toEqual(['old']);
    for (const res of [
      await w.add('C', item._id, { body: 'new' }),
      await w.edit('C', item._id, note._id, { body: 'changed' }),
      await w.remove('C', item._id, note._id),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'item_archived' });
    }
    expect(await w.stored(note._id)).toMatchObject({ body: 'old', editedAt: null });
    expect(await w.notes().countDocuments({ projectId: item._id })).toBe(1);
  });

  test('FR-1.5: a missing item is 404 for every route', async () => {
    const w = await world();
    expect((await w.list('C', 'no-such-item')).statusCode).toBe(404);
    expect((await w.add('C', 'no-such-item', { body: 'x' })).statusCode).toBe(404);
  });
});

describe('cascades', () => {
  test('FR-1.5: deleting an item deletes its notes and its descendants\' notes', async () => {
    const w = await world();
    const top = await w.item();
    const child = await w.item({ parentId: top._id });
    const grandchild = await w.item({ parentId: child._id });
    const other = await w.item();
    for (const item of [top, child, grandchild, other]) await w.note(item._id, w.ids.C);
    const res = await t.app.inject({
      method: 'DELETE',
      url: `/api/roadmaps/${w.roadmap._id}/projects/${child._id}`,
      headers: w.headers('O'),
    });
    expect(res.statusCode).toBe(200);
    expect((await w.notes().find({ roadmapId: w.roadmap._id }).toArray()).map((n) => n.projectId).sort()).toEqual(
      [top._id, other._id].sort(),
    );
  });

  test('FR-1.5: deleting the roadmap deletes all its notes and no other roadmap\'s', async () => {
    const w = await world();
    const a = await w.item();
    const b = await w.item();
    await w.note(a._id, w.ids.C);
    await w.note(b._id, w.ids.A);
    const kept = await world();
    await kept.note((await kept.item())._id, kept.ids.C);
    const res = await t.app.inject({
      method: 'DELETE',
      url: `/api/roadmaps/${w.roadmap._id}`,
      headers: w.headers('O'),
      payload: { confirmName: w.roadmap.name },
    });
    expect(res.statusCode).toBe(204);
    expect(await w.notes().countDocuments({ roadmapId: w.roadmap._id })).toBe(0);
    expect(await kept.notes().countDocuments({ roadmapId: kept.roadmap._id })).toBe(1);
  });

  test('FR-1.5: an item deleted while a note is added to it leaves no note behind', async () => {
    const w = await world();
    for (let i = 0; i < 20; i += 1) {
      const item = await w.item();
      const [deleted, added] = await Promise.all([
        t.app.inject({
          method: 'DELETE',
          url: `/api/roadmaps/${w.roadmap._id}/projects/${item._id}`,
          headers: w.headers('O'),
        }),
        w.add('C', item._id, { body: `race ${i}` }),
      ]);
      expect(deleted.statusCode).toBe(200);
      expect([201, 404]).toContain(added.statusCode);
    }
    const projectIds = (await t.db.collection<ProjectDoc>('projects').find({ roadmapId: w.roadmap._id }).toArray()).map(
      (p) => p._id,
    );
    expect(projectIds).toEqual([]);
    expect(await w.notes().countDocuments({ roadmapId: w.roadmap._id })).toBe(0);
  });
});

describe('audit', () => {
  test('FR-1.5: create, update and delete each record one event with ids and no note text', async () => {
    const w = await world();
    const item = await w.item();
    const note = (await w.add('C', item._id, { body: 'secret plan @Ann', mentionIds: [w.ids.A] })).json<Note>();
    await w.edit('C', item._id, note.id, { body: 'other secret' });
    await w.remove('A', item._id, note.id);

    const [created, updated, deleted] = [await w.events('note.create'), await w.events('note.update'), await w.events('note.delete')];
    for (const list of [created, updated, deleted]) {
      expect(list).toHaveLength(1);
      expect(list[0]!.target).toEqual({ type: 'note', id: note.id });
      const text = JSON.stringify(list[0]);
      expect(text).not.toContain('"body"');
      expect(text).not.toContain('secret');
    }
    expect(created[0]!.actor).toEqual({ type: 'user', userId: w.ids.C });
    expect(created[0]!.after).toMatchObject({ projectId: item._id, parentId: null, mentionIds: [w.ids.A] });
    expect(updated[0]!.before).toMatchObject({ projectId: item._id, mentionIds: [w.ids.A] });
    expect(updated[0]!.after).toMatchObject({ projectId: item._id, mentionIds: [] });
    expect(deleted[0]!.actor).toEqual({ type: 'user', userId: w.ids.A });
    expect(deleted[0]!.before).toMatchObject({ projectId: item._id, parentId: null, authorId: w.ids.C });
  });
});

describe('authors', () => {
  test('FR-1.5: a note whose author\'s user record is gone lists as "Former member"', async () => {
    const w = await world();
    const item = await w.item();
    await w.note(item._id, 'gone-user', { body: 'left behind' });
    await w.note(item._id, w.ids.D, { body: 'still here' });
    const listed = (await w.list('C', item._id)).json<{ notes: Note[] }>().notes;
    expect(listed.map((n) => [n.body, n.authorName])).toEqual([
      ['left behind', 'Former member'],
      ['still here', 'Dev (QA)'],
    ]);
  });
});

describe('Tenant isolation', () => {
  test('Tenant isolation: notes', async () => {
    const w = await world();
    const item = await w.item();
    const note = await w.note(item._id, w.ids.C, { body: 'ours' });
    const them = await world();
    const theirItem = await them.item();

    const url = `${w.base(item._id)}`;
    const asThem = them.headers('O');
    for (const res of [
      await t.app.inject({ method: 'GET', url, headers: asThem }),
      await t.app.inject({ method: 'POST', url, headers: asThem, payload: { body: 'x' } }),
      await t.app.inject({ method: 'PATCH', url: `${url}/${note._id}`, headers: asThem, payload: { body: 'x' } }),
      await t.app.inject({ method: 'DELETE', url: `${url}/${note._id}`, headers: asThem }),
      // Our note id under their own roadmap and item.
      await them.edit('O', theirItem._id, note._id, { body: 'x' }),
      await them.remove('O', theirItem._id, note._id),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
    const reply = await them.add('O', theirItem._id, { body: 'x', parentId: note._id });
    expect(reply.statusCode).toBe(422);
    expect(reply.json()).toEqual({ error: 'unknown_note' });
    expect(await w.stored(note._id)).toMatchObject({ body: 'ours', deletedAt: null });
    expect(await w.notes().countDocuments({ projectId: item._id })).toBe(1);
  });
});

describe('roadmaps', () => {
  test('FR-1.5: a note id from another roadmap of the same tenant is 404 for edit and delete, even for a member of both', async () => {
    const w = await world();
    const item = await w.item();
    const note = await w.note(item._id, w.ids.C, { body: 'ours' });
    const second = await t.seed.roadmap(w.tenantId, w.ids.C, 'Second');
    const secondItem = await t.seed.project(w.tenantId, second._id);
    const url = `${w.base(secondItem._id, second._id)}/${note._id}`;
    for (const res of [
      await t.app.inject({ method: 'PATCH', url, headers: w.headers('C'), payload: { body: 'x' } }),
      await t.app.inject({ method: 'DELETE', url, headers: w.headers('C') }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
    expect(await w.stored(note._id)).toMatchObject({ body: 'ours', editedAt: null, deletedAt: null });
  });
});

describe('sessions', () => {
  test('FR-1.5: signed out is 401; a write without the CSRF token is 403 csrf', async () => {
    const w = await world();
    const item = await w.item();
    const note = await w.note(item._id, w.ids.C);
    const url = w.base(item._id);
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const cookie = { cookie: w.sess.C.cookie };
    for (const res of [
      await t.app.inject({ method: 'POST', url, headers: cookie, payload: { body: 'x' } }),
      await t.app.inject({ method: 'PATCH', url: `${url}/${note._id}`, headers: cookie, payload: { body: 'x' } }),
      await t.app.inject({ method: 'DELETE', url: `${url}/${note._id}`, headers: cookie }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'csrf' });
    }
  });
});
