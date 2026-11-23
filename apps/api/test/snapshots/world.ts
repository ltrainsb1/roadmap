import type { ProjectDoc, SnapshotDoc, SnapshotItemDoc, SnapshotNoteDoc, UserDoc } from '../../src/db/types.ts';
import { signInAs, type TestApp } from '../helpers.ts';

export type Who = 'O' | 'A' | 'C';

export const PASSWORD = 'correct horse battery';

/** A roadmap with owner O ("Olive Owner"), admin A ("Ann Admin") and contributor C ("Cal Contributor"). */
export async function world(t: TestApp) {
  const tenantId = (await t.seed.tenant())._id;
  const users = { O: await t.seed.user(tenantId), A: await t.seed.user(tenantId), C: await t.seed.user(tenantId) };
  const names: Record<Who, string> = { O: 'Olive Owner', A: 'Ann Admin', C: 'Cal Contributor' };
  for (const who of Object.keys(users) as Who[]) {
    await t.db.collection<UserDoc>('users').updateOne({ _id: users[who]._id }, { $set: { name: names[who] } });
  }
  const roadmap = await t.seed.roadmap(tenantId, users.O._id, 'Launch plan');
  await t.seed.member(tenantId, roadmap._id, users.A._id, 'admin');
  await t.seed.member(tenantId, roadmap._id, users.C._id, 'contributor');
  const sess = {
    O: await signInAs(t.app, t.db, users.O._id),
    A: await signInAs(t.app, t.db, users.A._id),
    C: await signInAs(t.app, t.db, users.C._id),
  };
  const ids = { O: users.O._id, A: users.A._id, C: users.C._id };
  const emails = { O: users.O.email, A: users.A.email, C: users.C.email };
  const headers = (who: Who) => ({ cookie: sess[who].cookie, 'x-csrf-token': sess[who].csrf });
  const base = `/api/roadmaps/${roadmap._id}`;
  const call = (who: Who, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, payload?: unknown) =>
    t.app.inject({
      method,
      url: `${base}${path}`,
      headers: headers(who),
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    });
  const create = (who: Who, over: Record<string, unknown> = {}) =>
    call(who, 'POST', '/snapshots', {
      name: 'Board review',
      asOf: new Date().toISOString().slice(0, 10),
      password: PASSWORD,
      expiresAt: null,
      include: { notes: false, assignees: false },
      ...over,
    });
  /** Creates a snapshot as the Admin and returns its id; fails the test on anything but 201. */
  const createId = async (over: Record<string, unknown> = {}) => {
    const res = await create('A', over);
    if (res.statusCode !== 201) throw new Error(`create: ${res.statusCode} ${res.body}`);
    return res.json<{ id: string; linkId: string }>().id;
  };
  const item = (o: Parameters<TestApp['seed']['project']>[2] = {}) => t.seed.project(tenantId, roadmap._id, o);
  const note = (projectId: string, authorId: string, over: Parameters<TestApp['seed']['note']>[4] = {}) =>
    t.seed.note(tenantId, roadmap._id, projectId, authorId, over);
  const project = (id: string) => t.db.collection<ProjectDoc>('projects').findOne({ _id: id });
  const snapshot = (id: string) => t.db.collection<SnapshotDoc>('snapshots').findOne({ _id: id });
  const frozenItems = (snapshotId: string) =>
    t.db.collection<SnapshotItemDoc>('snapshotItems').find({ snapshotId }).sort({ _id: 1 }).toArray();
  const frozenNotes = (snapshotId: string) =>
    t.db.collection<SnapshotNoteDoc>('snapshotNotes').find({ snapshotId }).sort({ _id: 1 }).toArray();
  return {
    tenantId,
    ids,
    emails,
    roadmap,
    headers,
    call,
    create,
    createId,
    item,
    note,
    project,
    snapshot,
    frozenItems,
    frozenNotes,
  };
}
