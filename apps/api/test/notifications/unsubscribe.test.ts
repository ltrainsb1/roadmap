import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { PrefsResponse } from '@roadmap/shared';
import { scoped } from '../../src/db/scoped.ts';
import type { AuditEventDoc } from '../../src/db/types.ts';
import { signUnsubscribe } from '../../src/mail/unsubscribe.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

const ONE_CLICK = 'List-Unsubscribe=One-Click';
const OFF = { assigned: 'off', mentioned: 'off', dates_changed: 'off', due_soon: 'off' };

async function person() {
  const tenantId = (await t.seed.tenant())._id;
  const user = await t.seed.user(tenantId);
  const token = signUnsubscribe(t.config.unsubscribeKey, tenantId, user._id);
  const post = (url = `/api/email/unsubscribe?t=${token}`, remoteAddress?: string) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: ONE_CLICK,
      ...(remoteAddress ? { remoteAddress } : {}),
    });
  const prefs = async () => {
    const { cookie } = await signInAs(t.app, t.db, user._id);
    const res = await t.app.inject({ method: 'GET', url: '/api/me/notification-prefs', headers: { cookie } });
    return res.json<PrefsResponse>().prefs;
  };
  const audit = () =>
    t.db.collection<AuditEventDoc>('auditEvents').find({ tenantId, action: 'user.unsubscribed' }).toArray();
  return { tenantId, user, token, post, prefs, audit };
}

describe('one-click unsubscribe (FR-5)', () => {
  test('FR-5: POST with a valid token and body List-Unsubscribe=One-Click sets all four prefs to off and answers 200 with an empty body', async () => {
    const p = await person();
    expect(await p.prefs()).not.toEqual(OFF);
    const res = await p.post();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(await p.prefs()).toEqual(OFF);
  });

  test('FR-5: an empty body works too', async () => {
    const p = await person();
    const res = await t.app.inject({ method: 'POST', url: `/api/email/unsubscribe?t=${p.token}` });
    expect(res.statusCode).toBe(200);
    expect(await p.prefs()).toEqual(OFF);
  });

  test("FR-5: an audit event user.unsubscribed is recorded with before and after prefs, actor { type: 'user', userId }", async () => {
    const p = await person();
    const before = await p.prefs();
    await p.post();
    const events = await p.audit();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'user.unsubscribed',
      actor: { type: 'user', userId: p.user._id },
      target: { type: 'user', id: p.user._id },
      before: { prefs: before },
      after: { prefs: OFF },
    });
  });

  test('FR-5: a GET to the same URL changes nothing', async () => {
    const p = await person();
    const before = await p.prefs();
    const res = await t.app.inject({ method: 'GET', url: `/api/email/unsubscribe?t=${p.token}` });
    expect(res.statusCode).toBe(404);
    expect(await p.prefs()).toEqual(before);
    expect(await p.audit()).toHaveLength(0);
  });

  test("FR-5: a bad token, another key's token, and a token for a deleted user all answer 404 with an empty body", async () => {
    const p = await person();
    const tenantId = p.tenantId;
    const ghost = signUnsubscribe(t.config.unsubscribeKey, tenantId, uuidv7());
    const otherTenant = signUnsubscribe(t.config.unsubscribeKey, uuidv7(), p.user._id);
    const gone = await t.seed.user(tenantId);
    const goneToken = signUnsubscribe(t.config.unsubscribeKey, tenantId, gone._id);
    await scoped(t.db, tenantId).collection('users').deleteOne({ _id: gone._id });
    const tokens = [
      `${p.token.slice(0, -1)}${p.token.endsWith('A') ? 'B' : 'A'}`,
      'nonsense',
      '',
      signUnsubscribe(Buffer.alloc(32, 1), tenantId, p.user._id),
      ghost,
      otherTenant,
      goneToken,
    ];
    for (const token of tokens) {
      const res = await p.post(`/api/email/unsubscribe?t=${encodeURIComponent(token)}`);
      expect(res.statusCode, token).toBe(404);
      expect(res.body, token).toBe('');
    }
    const none = await p.post('/api/email/unsubscribe');
    expect(none.statusCode).toBe(404);
    expect(none.body).toBe('');
    expect(await p.audit()).toHaveLength(0);
  });

  test('FR-5: a second POST answers 200 again and records no second audit event', async () => {
    const p = await person();
    expect((await p.post()).statusCode).toBe(200);
    const again = await p.post();
    expect(again.statusCode).toBe(200);
    expect(again.body).toBe('');
    expect(await p.audit()).toHaveLength(1);
  });

  test('FR-5: the 31st POST in a minute from one address is 429', async () => {
    const p = await person();
    const address = '10.9.8.7';
    for (let i = 0; i < 30; i += 1) {
      expect((await p.post(undefined, address)).statusCode, `request ${i + 1}`).toBe(200);
    }
    expect((await p.post(undefined, address)).statusCode).toBe(429);
    // Another address is counted on its own.
    expect((await p.post(undefined, '10.9.8.8')).statusCode).toBe(200);
  });
});
