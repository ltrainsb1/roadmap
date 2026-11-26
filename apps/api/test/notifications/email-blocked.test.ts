import { DeleteSuppressedDestinationCommand, NotFoundException } from '@aws-sdk/client-sesv2';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { PrefsResponse } from '@roadmap/shared';
import { scoped } from '../../src/db/scoped.ts';
import type { AuditEventDoc } from '../../src/db/types.ts';
import type { SesLikeClient } from '../../src/mail/mailer.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

let t: TestApp;
let calls: Array<{ input: { EmailAddress?: string } }> = [];
let behavior: 'ok' | 'not_found' | 'fail' = 'ok';
const ses: SesLikeClient = {
  send(command) {
    calls.push(command as never);
    if (!(command instanceof DeleteSuppressedDestinationCommand)) return Promise.reject(new Error('unexpected command'));
    if (behavior === 'not_found') return Promise.reject(new NotFoundException({ message: 'no', $metadata: {} }));
    if (behavior === 'fail') return Promise.reject(new Error('ses down'));
    return Promise.resolve({});
  },
};

beforeAll(async () => {
  t = await makeTestApp({ env: { MAILER: 'ses' }, sesClient: ses });
}, 120_000);
afterAll(async () => {
  await t?.close();
});

async function blockedUser(reason: 'bounced' | 'complained' = 'bounced') {
  calls = [];
  behavior = 'ok';
  const tenantId = (await t.seed.tenant())._id;
  const user = await t.seed.user(tenantId);
  const at = new Date('2026-11-20T10:00:00Z');
  await scoped(t.db, tenantId).collection('users').updateOne({ _id: user._id }, { $set: { emailBlocked: { reason, at } } });
  const sess = await signInAs(t.app, t.db, user._id);
  return { tenantId, user, sess };
}

const get = (s: { cookie: string }) => t.app.inject({ method: 'GET', url: '/api/me/notification-prefs', headers: { cookie: s.cookie } });
const resume = (s: { cookie: string; csrf: string }, csrf = true) =>
  t.app.inject({ method: 'POST', url: '/api/me/notification-prefs/resume', headers: { cookie: s.cookie, ...(csrf && { 'x-csrf-token': s.csrf }) } });

describe('email blocked', () => {
  test('FR-5: GET /api/me/notification-prefs returns emailBlocked { reason, email }, or null', async () => {
    const w = await blockedUser('complained');
    await expect(get(w.sess).then((r) => r.json<PrefsResponse>().emailBlocked)).resolves.toEqual({ reason: 'complained', email: w.user.email });
    const other = await t.seed.user(w.tenantId);
    const s2 = await signInAs(t.app, t.db, other._id);
    expect((await get(s2)).json<PrefsResponse>().emailBlocked).toBeNull();
  });

  test('FR-5: POST resume clears the block, removes the address from the SES list once, records user.email_resumed, and answers the prefs', async () => {
    const w = await blockedUser();
    const res = await resume(w.sess);
    expect(res.statusCode).toBe(200);
    expect(res.json<PrefsResponse>().emailBlocked).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual({ EmailAddress: w.user.email });
    expect((await scoped(t.db, w.tenantId).collection('users').findOne({ _id: w.user._id }))!.emailBlocked).toBeUndefined();
    const events = await t.db.collection<AuditEventDoc>('auditEvents').find({ tenantId: w.tenantId, action: 'user.email_resumed' }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { type: 'user', userId: w.user._id }, target: { type: 'user', id: w.user._id } });
  });

  test('FR-5: NotFoundException from SES counts as success', async () => {
    const w = await blockedUser();
    behavior = 'not_found';
    expect((await resume(w.sess)).statusCode).toBe(200);
    expect((await get(w.sess)).json<PrefsResponse>().emailBlocked).toBeNull();
  });

  test('FR-5: any other SES error answers 502 ses_failed and the block stays', async () => {
    const w = await blockedUser();
    behavior = 'fail';
    const res = await resume(w.sess);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'ses_failed' });
    expect((await get(w.sess)).json<PrefsResponse>().emailBlocked).not.toBeNull();
  });

  test('FR-5: resume needs CSRF and a session', async () => {
    const w = await blockedUser();
    expect((await resume(w.sess, false)).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/me/notification-prefs/resume' })).statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test('FR-5: resume for a person who is not blocked changes nothing and records nothing', async () => {
    const w = await blockedUser();
    await resume(w.sess);
    calls = [];
    expect((await resume(w.sess)).statusCode).toBe(200);
    expect(calls).toHaveLength(0);
    const events = await t.db.collection<AuditEventDoc>('auditEvents').find({ tenantId: w.tenantId, action: 'user.email_resumed' }).toArray();
    expect(events).toHaveLength(1);
  });
});
