import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { hashToken } from '../../src/auth/tokens.ts';
import { scoped } from '../../src/db/scoped.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

let t: TestApp;
let tenantId: string;
let s: ReturnType<typeof scoped>;

beforeAll(async () => {
  t = await makeTestApp();
  tenantId = (await t.seed.tenant())._id;
  s = scoped(t.db, tenantId);
}, 120_000);
afterAll(async () => {
  await t?.close();
});

type Who = 'O' | 'A1' | 'A2' | 'C1' | 'C2';
const ROLE_OF: Record<Who, 'owner' | 'admin' | 'contributor'> = {
  O: 'owner',
  A1: 'admin',
  A2: 'admin',
  C1: 'contributor',
  C2: 'contributor',
};

/** A fresh roadmap: owner O, admins A1 and A2, contributors C1 and C2. */
async function world(name = 'Plan') {
  const ids = {} as Record<Who, string>;
  for (const w of Object.keys(ROLE_OF) as Who[]) {
    const u = await t.seed.user(tenantId, { email: `${w.toLowerCase()}-${crypto.randomUUID()}@example.com` });
    await s.collection('users').updateOne({ _id: u._id }, { $set: { name: `User ${w}` } });
    ids[w] = u._id;
  }
  const roadmap = await t.seed.roadmap(tenantId, ids.O, name);
  for (const w of ['A1', 'A2', 'C1', 'C2'] as const) await t.seed.member(tenantId, roadmap._id, ids[w], ROLE_OF[w]);
  const sess = {} as Record<Who, { cookie: string; csrf: string }>;
  for (const w of Object.keys(ids) as Who[]) sess[w] = await signInAs(t.app, t.db, ids[w]);
  const call = (who: Who, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: Record<string, unknown>) =>
    t.app.inject({
      method,
      url: `/api/roadmaps/${roadmap._id}${path}`,
      headers: { cookie: sess[who].cookie, 'x-csrf-token': sess[who].csrf },
      ...(payload ? { payload } : {}),
    });
  const roleOf = async (w: Who) =>
    (await s.collection('memberships').findOne({ roadmapId: roadmap._id, userId: ids[w] }))?.role ?? null;
  return { ids, roadmap, sess, call, roleOf };
}

describe('Permissions (member.changeRole/remove)', () => {
  const ops = ['promote', 'demote', 'remove'] as const;
  const cases = (['O', 'A1', 'C1'] as const).flatMap((actor) =>
    (['A2', 'C2'] as const).flatMap((target) => ops.map((op) => ({ actor, target, op }))),
  );
  test.each(cases)('$actor $op $target', async ({ actor, target, op }) => {
    const w = await world();
    const path = `/members/${w.ids[target]}`;
    const res =
      op === 'remove'
        ? await w.call(actor, 'DELETE', path)
        : await w.call(actor, 'PATCH', path, { role: op === 'promote' ? 'admin' : 'contributor' });
    expect(res.statusCode).toBe(actor === 'C1' ? 403 : 204);
    if (actor === 'C1') {
      expect(res.json()).toEqual({ error: 'forbidden' });
      expect(await w.roleOf(target)).toBe(ROLE_OF[target]);
    } else if (op === 'remove') {
      expect(await w.roleOf(target)).toBeNull();
    } else {
      expect(await w.roleOf(target)).toBe(op === 'promote' ? 'admin' : 'contributor');
    }
  });

  test('a contributor with a malformed body still gets 403, not 400', async () => {
    const w = await world();
    const res = await w.call('C1', 'PATCH', `/members/${w.ids.C2}`, { role: 'nonsense' });
    expect(res.statusCode).toBe(403);
  });

  test('owner is not an acceptable new role (400), whoever asks', async () => {
    const w = await world();
    expect((await w.call('O', 'PATCH', `/members/${w.ids.A1}`, { role: 'owner' })).statusCode).toBe(400);
    expect((await w.call('A1', 'PATCH', `/members/${w.ids.C1}`, { role: 'owner' })).statusCode).toBe(400);
    expect(await w.roleOf('A1')).toBe('admin');
  });

  test('a role change is recorded with before and after, a removal with the old role', async () => {
    const w = await world();
    expect((await w.call('A1', 'PATCH', `/members/${w.ids.C1}`, { role: 'admin' })).statusCode).toBe(204);
    expect((await w.call('A1', 'DELETE', `/members/${w.ids.C2}`)).statusCode).toBe(204);
    const rows = await t.db
      .collection('auditEvents')
      .find({ tenantId, roadmapId: w.roadmap._id, action: { $in: ['member.role_change', 'member.remove'] } })
      .toArray();
    const change = rows.find((r) => r.action === 'member.role_change')!;
    expect(change).toMatchObject({
      actor: { type: 'user', userId: w.ids.A1 },
      target: { type: 'user', id: w.ids.C1 },
      before: { role: 'contributor' },
      after: { role: 'admin' },
    });
    const removal = rows.find((r) => r.action === 'member.remove')!;
    expect(removal).toMatchObject({ target: { type: 'user', id: w.ids.C2 }, before: { role: 'contributor' } });
  });

  test('an unchanged role is a quiet 204 with no audit entry', async () => {
    const w = await world();
    expect((await w.call('O', 'PATCH', `/members/${w.ids.A1}`, { role: 'admin' })).statusCode).toBe(204);
    expect(await t.db.collection('auditEvents').countDocuments({ roadmapId: w.roadmap._id })).toBe(0);
  });

  test('an admin may remove themselves; their next request to the roadmap is 404', async () => {
    const w = await world();
    expect((await w.call('A1', 'DELETE', `/members/${w.ids.A1}`)).statusCode).toBe(204);
    expect((await w.call('A1', 'GET', '/members')).statusCode).toBe(404);
    // Their session is still valid for everything else.
    const me = await t.app.inject({ url: '/api/me', headers: { cookie: w.sess.A1.cookie } });
    expect(me.statusCode).toBe(200);
  });

  test('a target who is not a member is 404, including a member of another roadmap', async () => {
    const w = await world();
    const other = await world('Other');
    const stranger = await t.seed.user(tenantId);
    for (const id of [stranger._id, other.ids.C1, 'nobody']) {
      expect((await w.call('O', 'DELETE', `/members/${id}`)).statusCode).toBe(404);
      expect((await w.call('O', 'PATCH', `/members/${id}`, { role: 'admin' })).statusCode).toBe(404);
    }
    expect(await other.roleOf('C1')).toBe('contributor');
  });
});

describe('Review focus 3: owner immutability', () => {
  test('Review focus 3: owner cannot be demoted or removed by anyone, including themselves', async () => {
    const w = await world();
    for (const actor of ['O', 'A1'] as const) {
      for (const role of ['admin', 'contributor']) {
        const res = await w.call(actor, 'PATCH', `/members/${w.ids.O}`, { role });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: 'owner_immutable' });
      }
      const del = await w.call(actor, 'DELETE', `/members/${w.ids.O}`);
      expect(del.statusCode).toBe(409);
      expect(del.json()).toEqual({ error: 'owner_immutable' });
    }
    expect(await w.roleOf('O')).toBe('owner');
  });

  test('a contributor targeting the owner gets 403, not a hint', async () => {
    const w = await world();
    expect((await w.call('C1', 'DELETE', `/members/${w.ids.O}`)).statusCode).toBe(403);
    expect((await w.call('C1', 'PATCH', `/members/${w.ids.O}`, { role: 'contributor' })).statusCode).toBe(403);
  });
});

describe('listing members and invites', () => {
  test('lists members with names, emails and roles, plus only open invites; any member may read', async () => {
    const w = await world();
    const mk = (email: string, over: Record<string, unknown>) =>
      s.collection('invites').insertOne({
        _id: crypto.randomUUID(),
        roadmapId: w.roadmap._id,
        email,
        role: 'contributor',
        tokenHash: hashToken(email),
        invitedBy: w.ids.O,
        expiresAt: new Date(Date.now() + 86_400_000),
        acceptedAt: null,
        revokedAt: null,
        ...over,
      });
    const open = await mk('open@example.com', {});
    await mk('revoked@example.com', { revokedAt: new Date() });
    await mk('accepted@example.com', { acceptedAt: new Date() });
    await mk('expired@example.com', { expiresAt: new Date(Date.now() - 1000) });
    const res = await w.call('C1', 'GET', '/members');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ members: Array<{ userId: string; name: string; email: string; role: string }>; invites: unknown[] }>();
    expect(body.members).toHaveLength(5);
    expect(body.members.find((m) => m.userId === w.ids.O)).toMatchObject({ name: 'User O', role: 'owner' });
    expect(body.members[0]!.email).toMatch(/@example.com$/);
    expect(body.invites).toEqual([
      { id: open._id, email: 'open@example.com', role: 'contributor', expiresAt: open.expiresAt.toISOString() },
    ]);
    expect(res.body).not.toContain('tokenHash');
    expect(res.body).not.toContain('passwordHash');
  });
});

describe('revoking invites', () => {
  async function invited(w: Awaited<ReturnType<typeof world>>, email = 'new@example.com') {
    const res = await w.call('O', 'POST', '/invites', { email, role: 'contributor' });
    expect(res.statusCode).toBe(201);
    const token = /\/invite\/([\w-]+)/.exec(t.mail.sent.at(-1)!.text)![1]!;
    return { id: res.json<{ id: string }>().id, token };
  }

  test('owner and admin revoke an invite (204); the link stops working; audited', async () => {
    const w = await world();
    for (const actor of ['O', 'A1'] as const) {
      const inv = await invited(w, `${actor}@example.com`);
      expect((await w.call(actor, 'DELETE', `/invites/${inv.id}`)).statusCode).toBe(204);
      expect((await t.app.inject({ url: `/api/invites/${inv.token}` })).statusCode).toBe(410);
      const stored = await s.collection('invites').findOne({ _id: inv.id });
      expect(stored?.revokedAt).toBeInstanceOf(Date);
      const rows = await t.db.collection('auditEvents').find({ target: { type: 'invite', id: inv.id }, action: 'invite.revoke' }).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toEqual({ type: 'user', userId: w.ids[actor] });
    }
  });

  test('a contributor gets 403; unknown, already revoked and other-roadmap invites are 404', async () => {
    const w = await world();
    const other = await world('Other');
    const inv = await invited(w);
    expect((await w.call('C1', 'DELETE', `/invites/${inv.id}`)).statusCode).toBe(403);
    expect((await other.call('O', 'DELETE', `/invites/${inv.id}`)).statusCode).toBe(404);
    expect((await w.call('O', 'DELETE', '/invites/nope')).statusCode).toBe(404);
    expect((await w.call('O', 'DELETE', `/invites/${inv.id}`)).statusCode).toBe(204);
    expect((await w.call('O', 'DELETE', `/invites/${inv.id}`)).statusCode).toBe(404);
  });
});

describe('transfer (roadmap.transfer)', () => {
  test('Review focus 3: transfer to a non-member returns 422', async () => {
    const w = await world();
    const stranger = await t.seed.user(tenantId);
    for (const userId of [stranger._id, 'nobody']) {
      const res = await w.call('O', 'POST', '/transfer', { userId });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'not_a_member' });
    }
    expect(await w.roleOf('O')).toBe('owner');
  });

  test('transfer to yourself is refused', async () => {
    const w = await world();
    const res = await w.call('O', 'POST', '/transfer', { userId: w.ids.O });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'already_owner' });
  });

  test('transfer to A1 makes A1 the owner and O an admin; O can no longer delete the roadmap', async () => {
    const w = await world('Handover');
    expect((await w.call('O', 'POST', '/transfer', { userId: w.ids.A1 })).statusCode).toBe(204);
    expect(await w.roleOf('A1')).toBe('owner');
    expect(await w.roleOf('O')).toBe('admin');
    expect((await s.collection('roadmaps').findOne({ _id: w.roadmap._id }))?.ownerId).toBe(w.ids.A1);
    expect((await w.call('O', 'DELETE', '', { confirmName: 'Handover' })).statusCode).toBe(403);
    expect((await w.call('O', 'POST', '/transfer', { userId: w.ids.C1 })).statusCode).toBe(403);
    const audit = await t.db.collection('auditEvents').findOne({ roadmapId: w.roadmap._id, action: 'roadmap.transfer' });
    expect(audit).toMatchObject({
      actor: { type: 'user', userId: w.ids.O },
      before: { ownerId: w.ids.O },
      after: { ownerId: w.ids.A1 },
    });
    // The new owner may now delete it.
    expect((await w.call('A1', 'DELETE', '', { confirmName: 'Handover' })).statusCode).toBe(204);
  });

  test('an admin attempting transfer gets 403', async () => {
    const w = await world();
    expect((await w.call('A1', 'POST', '/transfer', { userId: w.ids.A1 })).statusCode).toBe(403);
    expect((await w.call('C1', 'POST', '/transfer', { userId: w.ids.C1 })).statusCode).toBe(403);
    expect(await w.roleOf('O')).toBe('owner');
  });
});

describe('delete (roadmap.delete)', () => {
  test('the wrong confirmName returns 422 and deletes nothing', async () => {
    const w = await world('Keep me');
    for (const confirmName of ['keep me', 'Keep me ', '']) {
      const res = await w.call('O', 'DELETE', '', { confirmName });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'confirm_mismatch' });
    }
    expect((await w.call('O', 'DELETE', '', {})).statusCode).toBe(400);
    expect(await s.collection('roadmaps').findOne({ _id: w.roadmap._id })).not.toBeNull();
  });

  test('the right name returns 204, removes the roadmap, memberships and invites, and it leaves every /api/me', async () => {
    const w = await world('Doomed');
    await w.call('O', 'POST', '/invites', { email: 'pending@example.com', role: 'admin' });
    const survivor = await world('Survivor');
    const res = await w.call('O', 'DELETE', '', { confirmName: 'Doomed' });
    expect(res.statusCode).toBe(204);
    expect(await s.collection('roadmaps').findOne({ _id: w.roadmap._id })).toBeNull();
    expect(await s.collection('memberships').countDocuments({ roadmapId: w.roadmap._id })).toBe(0);
    expect(await s.collection('invites').countDocuments({ roadmapId: w.roadmap._id })).toBe(0);
    for (const who of ['O', 'A1', 'C2'] as const) {
      const me = await t.app.inject({ url: '/api/me', headers: { cookie: w.sess[who].cookie } });
      expect(me.json<{ memberships: Array<{ roadmapId: string }> }>().memberships.map((m) => m.roadmapId)).not.toContain(w.roadmap._id);
    }
    expect(await survivor.roleOf('O')).toBe('owner');
    const audit = await t.db.collection('auditEvents').findOne({ roadmapId: w.roadmap._id, action: 'roadmap.delete' });
    expect(audit).toMatchObject({ actor: { type: 'user', userId: w.ids.O }, target: { type: 'roadmap', id: w.roadmap._id } });
  });

  test('an admin attempting delete gets 403; a contributor too', async () => {
    const w = await world('Safe');
    expect((await w.call('A1', 'DELETE', '', { confirmName: 'Safe' })).statusCode).toBe(403);
    expect((await w.call('C1', 'DELETE', '', { confirmName: 'Safe' })).statusCode).toBe(403);
    expect(await s.collection('roadmaps').findOne({ _id: w.roadmap._id })).not.toBeNull();
  });
});

describe('Tenant isolation', () => {
  test('Tenant isolation: tenant B owner gets 404 on tenant A members routes', async () => {
    const a = await world();
    const tb = (await t.seed.tenant('B'))._id;
    const ownerB = await t.seed.user(tb);
    await t.seed.roadmap(tb, ownerB._id, 'B plan');
    const sess = await signInAs(t.app, t.db, ownerB._id);
    const hit = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: Record<string, unknown>) =>
      t.app.inject({
        method,
        url: `/api/roadmaps/${a.roadmap._id}${path}`,
        headers: { cookie: sess.cookie, 'x-csrf-token': sess.csrf },
        ...(payload ? { payload } : {}),
      });
    const results = await Promise.all([
      hit('GET', '/members'),
      hit('PATCH', `/members/${a.ids.C1}`, { role: 'admin' }),
      hit('DELETE', `/members/${a.ids.C1}`),
      hit('DELETE', `/invites/anything`),
      hit('POST', '/transfer', { userId: ownerB._id }),
      hit('DELETE', '', { confirmName: 'Plan' }),
      hit('GET', '/audit'),
    ]);
    for (const r of results) {
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ error: 'not_found' });
    }
    expect(await a.roleOf('C1')).toBe('contributor');
  });
});
