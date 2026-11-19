import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { createAuditLog } from '../audit/audit.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { scoped, type ScopedDb } from '../db/scoped.ts';
import type { UserDoc } from '../db/types.ts';
import { unscoped } from '../db/unscoped.ts';
import { HttpError } from '../errors.ts';
import { csrfMatches } from '../policy/hook.ts';
import { completeSignIn } from './complete-sign-in.ts';
import { assertNotLocked, isLocked, recordFailure, recordSuccess } from './lockout.ts';
import { CHALLENGE_TTL_MS, createPasskeys, realVerifiers, type PasskeyVerifiers } from './passkeys.ts';
import { setSessionCookie } from './sessions.ts';
import { requireStepUp, stepUpCodeOf } from './step-up.ts';
import { newToken } from './tokens.ts';

export interface PasskeyRouteDeps {
  db: Db;
  config: Config;
  now: () => Date;
  webauthn?: PasskeyVerifiers;
}

/** Cookie holding the id of a passwordless sign-in challenge. */
export const WEBAUTHN_COOKIE = '__Host-wa';
const waCookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;

const registerBody = z.object({
  response: z.looseObject({}),
  name: z.string().trim().min(1).max(60),
});
const loginBody = z.object({ response: z.looseObject({ id: z.string().min(1).max(1024) }) });

const invalidCredentials = () => new HttpError(401, 'invalid_credentials');
const invalidPasskey = () => new HttpError(422, 'invalid_passkey');
const isDuplicateKey = (err: unknown) => (err as { code?: number } | null)?.code === 11000;

export function registerPasskeyRoutes(app: FastifyInstance, deps: PasskeyRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();
  const lookup = unscoped(deps.db);
  const passkeys = createPasskeys(deps.config, deps.webauthn ?? realVerifiers);

  const loadUser = async (db: ScopedDb, userId: string): Promise<UserDoc> => {
    const user = await db.collection('users').findOne({ _id: userId });
    if (!user) throw new HttpError(401, 'unauthenticated');
    return user;
  };

  const putSessionChallenge = (db: ScopedDb, sessionId: string, challenge: string) =>
    db.collection('sessions').updateOne(
      { _id: sessionId },
      { $set: { webauthnChallenge: challenge, webauthnChallengeExpiresAt: new Date(deps.now().getTime() + CHALLENGE_TTL_MS) } },
    );

  /** Reads the session's challenge and clears it in the same step, so it can be used once. Null if absent or expired. */
  const takeSessionChallenge = async (db: ScopedDb, sessionId: string): Promise<string | null> => {
    const session = await db.collection('sessions').findOne({ _id: sessionId });
    const challenge = session?.webauthnChallenge;
    if (!challenge) return null;
    const { matched } = await db
      .collection('sessions')
      .updateOne({ _id: sessionId, webauthnChallenge: challenge }, { $unset: { webauthnChallenge: '', webauthnChallengeExpiresAt: '' } });
    if (matched === 0) return null;
    const expiresAt = session.webauthnChallengeExpiresAt;
    return expiresAt && expiresAt > deps.now() ? challenge : null;
  };

  const sessionStateOf = async (req: FastifyRequest) => {
    const actor = req.actor;
    if (!actor) return null;
    return (await actor.db.collection('sessions').findOne({ _id: actor.sessionId }))?.state ?? null;
  };

  r.post('/api/auth/passkeys/register/options', { config: { auth: { level: 'full' } } }, async (req) => {
    const actor = req.actor!;
    const user = await loadUser(actor.db, actor.userId);
    // Adding a factor proves the existing one, or a stolen cookie could plant its own passkey.
    if (user.totp) {
      await requireStepUp(actor.db, user, stepUpCodeOf(req.body), { totpEncKey: deps.config.totpEncKey, now: deps.now() });
    }
    const options = await passkeys.registrationOptions(user);
    await putSessionChallenge(actor.db, actor.sessionId, options.challenge);
    return options;
  });

  r.post(
    '/api/auth/passkeys/register/verify',
    { config: { auth: { level: 'full' } }, schema: { body: registerBody } },
    async (req) => {
      const actor = req.actor!;
      const challenge = await takeSessionChallenge(actor.db, actor.sessionId);
      if (!challenge) throw invalidPasskey();
      const fresh = await passkeys.verifyRegistration(req.body.response, challenge);
      if (!fresh) throw invalidPasskey();
      if (await lookup.findUserByCredentialId(fresh.credentialId)) throw new HttpError(409, 'passkey_exists');

      const id = uuidv7();
      try {
        await actor.db.collection('users').updateOne(
          { _id: actor.userId },
          { $push: { passkeys: { id, ...fresh, name: req.body.name, createdAt: deps.now() } } },
        );
      } catch (err) {
        if (isDuplicateKey(err)) throw new HttpError(409, 'passkey_exists');
        throw err;
      }
      await audit.record(actor.db, {
        action: 'auth.passkey.added',
        actor: { type: 'user', userId: actor.userId },
        target: { type: 'user', id: actor.userId },
        ip: req.ip,
      });
      return { id };
    },
  );

  r.delete(
    '/api/auth/passkeys/:id',
    { config: { auth: { level: 'full' } }, schema: { params: z.object({ id: z.string().min(1).max(100) }) } },
    async (req, reply) => {
      const actor = req.actor!;
      const user = await loadUser(actor.db, actor.userId);
      const all = user.passkeys ?? [];
      if (!all.some((p) => p.id === req.params.id)) throw new HttpError(404, 'not_found');
      // MFA is mandatory: without TOTP the last passkey is the only second factor left.
      if (!user.totp && all.length === 1) throw new HttpError(409, 'last_factor');

      // Dropping the field with the last entry keeps users without passkeys out of the sparse unique index.
      // The last-factor guard is repeated in the filter, so two concurrent deletes cannot both pass it.
      const { matched } = await actor.db.collection('users').updateOne(
        {
          _id: user._id,
          'passkeys.id': req.params.id,
          $or: [{ totp: { $ne: null } }, { 'passkeys.1': { $exists: true } }],
        },
        all.length === 1 ? { $unset: { passkeys: '' } } : { $pull: { passkeys: { id: req.params.id } } },
      );
      if (matched === 0) {
        const current = await loadUser(actor.db, actor.userId);
        throw current.passkeys?.some((p) => p.id === req.params.id)
          ? new HttpError(409, 'last_factor')
          : new HttpError(404, 'not_found');
      }
      // Two concurrent deletes can each $pull one entry and leave `[]`, which collides in the sparse unique index.
      await actor.db.collection('users').updateOne({ _id: user._id, passkeys: { $size: 0 } }, { $unset: { passkeys: '' } });
      await audit.record(actor.db, {
        action: 'auth.passkey.removed',
        actor: { type: 'user', userId: actor.userId },
        target: { type: 'user', id: actor.userId },
        ip: req.ip,
      });
      return reply.status(204).send();
    },
  );

  r.post('/api/auth/passkeys/login/options', { config: { auth: { level: 'public' } } }, async (req, reply) => {
    if ((await sessionStateOf(req)) === 'pending_mfa') {
      const actor = req.actor!;
      const user = await loadUser(actor.db, actor.userId);
      if (!user.passkeys?.length) throw new HttpError(422, 'no_passkeys');
      const options = await passkeys.authenticationOptions(user.passkeys);
      await putSessionChallenge(actor.db, actor.sessionId, options.challenge);
      return options;
    }
    // Passwordless: no user is looked up, so the answer is the same whether or not any account exists.
    const options = await passkeys.authenticationOptions();
    const id = newToken().token;
    await lookup.insertChallenge({
      _id: id,
      challenge: options.challenge,
      expiresAt: new Date(deps.now().getTime() + CHALLENGE_TTL_MS),
    });
    void reply.setCookie(WEBAUTHN_COOKIE, id, { ...waCookieOptions, maxAge: CHALLENGE_TTL_MS / 1000 });
    return options;
  });

  /** A failed passkey verification for a known user: counts toward the lock, is audited, answers 401. */
  const fail = async (db: ScopedDb, userId: string, ip: string): Promise<never> => {
    await recordFailure(db, userId, deps.now());
    await audit.record(db, {
      action: 'auth.mfa.failure',
      actor: { type: 'system' },
      target: { type: 'user', id: userId },
      ip,
    });
    throw invalidCredentials();
  };

  const saveCounter = (db: ScopedDb, userId: string, passkeyId: string, counter: number) =>
    db.collection('users').updateOne({ _id: userId, 'passkeys.id': passkeyId }, { $set: { 'passkeys.$.counter': counter } });

  r.post(
    '/api/auth/passkeys/login/verify',
    { config: { auth: { level: 'public' } }, schema: { body: loginBody } },
    async (req, reply) => {
      const { response } = req.body;
      const now = deps.now();

      if ((await sessionStateOf(req)) === 'pending_mfa') {
        // Second factor: the pending session's user is already known, and only their passkeys count.
        const actor = req.actor!;
        // The route is public, so the hook skipped CSRF; this branch upgrades a session and must check it.
        if (!csrfMatches(req.headers['x-csrf-token'], actor.csrfToken)) throw new HttpError(403, 'csrf');
        if (!(await assertNotLocked(actor.db, actor.userId, now))) throw invalidCredentials();
        const user = await loadUser(actor.db, actor.userId);
        const challenge = await takeSessionChallenge(actor.db, actor.sessionId);
        const passkey = user.passkeys?.find((p) => p.credentialId === response.id);
        if (!challenge || !passkey) return fail(actor.db, user._id, req.ip);
        const counter = await passkeys.verifyAuthentication(response, challenge, passkey);
        // Failures from concurrent attempts may have locked the account while we verified.
        if (counter === null || !(await assertNotLocked(actor.db, user._id, now))) return fail(actor.db, user._id, req.ip);
        await saveCounter(actor.db, user._id, passkey.id, counter);
        return { csrfToken: await completeSignIn(app.sessions, req, reply) };
      }

      // Passwordless: the challenge cookie names the challenge; the credential names the user.
      const challengeId = req.cookies[WEBAUTHN_COOKIE];
      void reply.clearCookie(WEBAUTHN_COOKIE, waCookieOptions);
      const stored = challengeId ? await lookup.takeChallenge(challengeId) : null;
      if (!stored || stored.expiresAt <= now) throw invalidCredentials();
      const user = await lookup.findUserByCredentialId(response.id);
      const passkey = user?.passkeys?.find((p) => p.credentialId === response.id);
      if (!user || !passkey) throw invalidCredentials();
      const s = scoped(deps.db, user.tenantId);
      if (isLocked(user, now) || !(await assertNotLocked(s, user._id, now))) throw invalidCredentials();
      const counter = await passkeys.verifyAuthentication(response, stored.challenge, passkey);
      if (counter === null || !(await assertNotLocked(s, user._id, now))) return fail(s, user._id, req.ip);

      await saveCounter(s, user._id, passkey.id, counter);
      await recordSuccess(s, user._id);
      const { token, session } = await app.sessions.create(s, user._id, 'full', {
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? '',
      });
      setSessionCookie(reply, token);
      await audit.record(s, {
        action: 'auth.login.success',
        actor: { type: 'user', userId: user._id },
        target: { type: 'user', id: user._id },
        ip: req.ip,
      });
      return { csrfToken: session.csrfToken };
    },
  );
}
