import {
  loginRequestSchema,
  loginResponseSchema,
  meResponseSchema,
  type MeResponse,
} from '@roadmap/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createAuditLog } from '../audit/audit.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { scoped, type ScopedDb } from '../db/scoped.ts';
import type { UserDoc } from '../db/types.ts';
import { unscoped } from '../db/unscoped.ts';
import type { AuthConfig } from '../policy/hook.ts';
import { HttpError } from '../errors.ts';
import { listMemberships } from '../roadmaps/routes.ts';
import { decryptSecret, encryptSecret } from './crypto.ts';
import { assertNotLocked, isLocked, recordFailure, recordSuccess } from './lockout.ts';
import { hashPassword, verifyPassword } from './passwords.ts';
import { consumeRecoveryCode, generateRecoveryCodes } from './recovery.ts';
import { claimTotpStep, generateTotpSecret, otpauthUrl, verifyTotp } from './totp.ts';
import { completeSignIn } from './complete-sign-in.ts';
import { clearSessionCookie, setSessionCookie } from './sessions.ts';

export interface AuthRouteDeps {
  db: Db;
  config: Config;
  now: () => Date;
  fetch?: typeof fetch;
}

// Verified against when the email is unknown, so "no such user" costs the same as "wrong password".
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword('dummy-password-for-timing'));

/** Second factors the user has set up. */
function factorsOf(user: UserDoc): { hasTotp: boolean; passkeys: MeResponse['user']['passkeys'] } {
  return {
    hasTotp: Boolean(user.totp),
    passkeys: (user.passkeys ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt.toISOString(),
    })),
  };
}

const totpCodeBody = z.object({ code: z.string().regex(/^\d{6}$/) });
// enroll/start takes a body only when replacing an existing factor; anything unparseable counts as no code.
const optionalCodeBody = z.object({ code: z.string().max(32) });
const recoveryCodeBody = z.object({ code: z.string().min(1).max(32) });
const invalidCode = () => new HttpError(401, 'invalid_code');

const requestMeta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] ?? '' });

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();
  const lookup = unscoped(deps.db);
  const anySession: AuthConfig = { level: 'pending', states: ['pending_mfa', 'pending_enroll', 'full'] };

  r.post(
    '/api/auth/login',
    {
      config: { auth: { level: 'public' } },
      schema: { body: loginRequestSchema, response: { 200: loginResponseSchema } },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const now = deps.now();
      const user = await lookup.findUserByEmail(email);
      let locked = user !== null && isLocked(user, now);
      // Always run one argon2 verification; a locked account is not verified at all but still pays for the dummy.
      const hashToCheck = user?.passwordHash && !locked ? user.passwordHash : await getDummyHash();
      const ok = await verifyPassword(hashToCheck, password);
      // Concurrent guesses may have locked the account since we read it: check the stored document again.
      if (user && ok && !locked) locked = !(await assertNotLocked(scoped(deps.db, user.tenantId), user._id, now));

      if (!user || !ok || locked) {
        if (user) {
          const s = scoped(deps.db, user.tenantId);
          if (!locked) await recordFailure(s, user._id, now);
          await audit.record(s, {
            action: 'auth.login.failure',
            actor: { type: 'system' },
            target: { type: 'user', id: user._id },
            ip: req.ip,
          });
        }
        throw new HttpError(401, 'invalid_credentials');
      }

      const s = scoped(deps.db, user.tenantId);
      const f = factorsOf(user);
      const hasSecondFactor = f.hasTotp || f.passkeys.length > 0;
      const { token, session } = await app.sessions.create(
        s,
        user._id,
        hasSecondFactor ? 'pending_mfa' : 'pending_enroll',
        requestMeta(req),
      );
      setSessionCookie(reply, token);
      return { next: hasSecondFactor ? ('mfa' as const) : ('enroll' as const), csrfToken: session.csrfToken };
    },
  );

  const loadUser = async (actor: NonNullable<FastifyRequest['actor']>): Promise<UserDoc> => {
    const user = await actor.db.collection('users').findOne({ _id: actor.userId });
    if (!user) throw new HttpError(401, 'unauthenticated');
    return user;
  };

  /** Second-factor failure: counts toward the lock, is audited, and always answers the same 401. */
  const failSecondFactor = async (req: FastifyRequest, now: Date): Promise<never> => {
    const actor = req.actor!;
    await recordFailure(actor.db, actor.userId, now);
    await audit.record(actor.db, {
      action: 'auth.mfa.failure',
      actor: { type: 'system' },
      target: { type: 'user', id: actor.userId },
      ip: req.ip,
    });
    throw invalidCode();
  };

  /** For a full session changing its own second factor: the current TOTP code must be valid and unused. */
  const requireCurrentTotp = async (user: UserDoc, code: string | undefined, db: ScopedDb): Promise<void> => {
    if (!user.totp || code === undefined) throw new HttpError(422, 'invalid_code');
    const checked = verifyTotp(decryptSecret(user.totp.secretEnc, deps.config.totpEncKey), code, user.totp.lastStep, deps.now());
    if (!checked.ok || !(await claimTotpStep(db, user._id, checked.step))) throw new HttpError(422, 'invalid_code');
  };

  r.post(
    '/api/auth/totp/enroll/start',
    { config: { auth: { level: 'pending', states: ['pending_enroll', 'full'] } } },
    async (req) => {
      const actor = req.actor!;
      const user = await loadUser(actor);
      // Replacing an existing factor from a full session must prove the old one, or a stolen cookie could take it over.
      const session = await actor.db.collection('sessions').findOne({ _id: actor.sessionId });
      if (session?.state === 'full' && user.totp) await requireCurrentTotp(user, optionalCodeBody.safeParse(req.body).data?.code, actor.db);
      const secret = generateTotpSecret();
      await actor.db
        .collection('users')
        .updateOne({ _id: user._id }, { $set: { pendingTotpSecretEnc: encryptSecret(secret, deps.config.totpEncKey) } });
      return { secret, otpauthUrl: otpauthUrl(user.email, deps.config.webauthnRpName, secret) };
    },
  );

  r.post(
    '/api/auth/totp/enroll/confirm',
    {
      config: { auth: { level: 'pending', states: ['pending_enroll', 'full'] } },
      schema: { body: totpCodeBody },
    },
    async (req, reply) => {
      const actor = req.actor!;
      const user = await loadUser(actor);
      const pending = user.pendingTotpSecretEnc;
      if (!pending) throw new HttpError(409, 'enroll_not_started');
      const now = deps.now();
      const checked = verifyTotp(decryptSecret(pending, deps.config.totpEncKey), req.body.code, 0, now);
      if (!checked.ok) throw new HttpError(422, 'invalid_code');

      const { codes, hashes } = generateRecoveryCodes();
      // Conditional on the pending secret we just verified, so a second enroll/start in between cannot be confirmed with the old code.
      const { matched } = await actor.db.collection('users').updateOne(
        { _id: user._id, pendingTotpSecretEnc: pending },
        {
          $set: {
            totp: { secretEnc: pending, lastStep: checked.step },
            pendingTotpSecretEnc: null,
            recoveryCodes: hashes.map((hash) => ({ hash, usedAt: null })),
          },
        },
      );
      if (matched === 0) throw new HttpError(422, 'invalid_code');
      await audit.record(actor.db, {
        action: 'auth.totp.enrolled',
        actor: { type: 'user', userId: user._id },
        target: { type: 'user', id: user._id },
        ip: req.ip,
      });

      const session = await actor.db.collection('sessions').findOne({ _id: actor.sessionId });
      if (session?.state !== 'pending_enroll') return { recoveryCodes: codes, csrfToken: actor.csrfToken };
      await recordSuccess(actor.db, user._id);
      const upgraded = await app.sessions.upgrade(actor.db, actor.sessionId, 'full');
      setSessionCookie(reply, upgraded.token);
      return { recoveryCodes: codes, csrfToken: upgraded.csrfToken };
    },
  );

  r.post(
    '/api/auth/mfa/totp',
    { config: { auth: { level: 'pending', states: ['pending_mfa'] } }, schema: { body: totpCodeBody } },
    async (req, reply) => {
      const actor = req.actor!;
      const now = deps.now();
      if (!(await assertNotLocked(actor.db, actor.userId, now))) throw invalidCode();
      const user = await loadUser(actor);
      if (!user.totp) throw invalidCode();
      const checked = verifyTotp(decryptSecret(user.totp.secretEnc, deps.config.totpEncKey), req.body.code, user.totp.lastStep, now);
      const claimed = checked.ok && (await claimTotpStep(actor.db, user._id, checked.step));
      // Failures from concurrent guesses may have locked the account while we verified.
      if (!claimed || !(await assertNotLocked(actor.db, user._id, now))) return failSecondFactor(req, now);
      return { csrfToken: await completeSignIn(app.sessions, req, reply) };
    },
  );

  r.post(
    '/api/auth/mfa/recovery',
    { config: { auth: { level: 'pending', states: ['pending_mfa'] } }, schema: { body: recoveryCodeBody } },
    async (req, reply) => {
      const actor = req.actor!;
      const now = deps.now();
      if (!(await assertNotLocked(actor.db, actor.userId, now))) throw invalidCode();
      if (!(await consumeRecoveryCode(actor.db, actor.userId, req.body.code, now))) return failSecondFactor(req, now);
      const csrfToken = await completeSignIn(app.sessions, req, reply);
      const user = await loadUser(actor);
      return { csrfToken, remainingRecoveryCodes: user.recoveryCodes.filter((c) => c.usedAt === null).length };
    },
  );

  r.post(
    '/api/auth/recovery-codes',
    { config: { auth: { level: 'full' } }, schema: { body: totpCodeBody } },
    async (req) => {
      const actor = req.actor!;
      const user = await loadUser(actor);
      await requireCurrentTotp(user, req.body.code, actor.db);
      const { codes, hashes } = generateRecoveryCodes();
      await actor.db
        .collection('users')
        .updateOne({ _id: user._id }, { $set: { recoveryCodes: hashes.map((hash) => ({ hash, usedAt: null })) } });
      await audit.record(actor.db, {
        action: 'auth.recovery.regenerated',
        actor: { type: 'user', userId: user._id },
        target: { type: 'user', id: user._id },
        ip: req.ip,
      });
      return { recoveryCodes: codes };
    },
  );

  r.post('/api/auth/logout', { config: { auth: anySession } }, async (req, reply) => {
    const actor = req.actor!;
    await audit.record(actor.db, {
      action: 'auth.logout',
      actor: { type: 'user', userId: actor.userId },
      target: { type: 'user', id: actor.userId },
      ip: req.ip,
    });
    await app.sessions.revoke(actor.db, actor.sessionId);
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  r.post('/api/auth/logout-all', { config: { auth: { level: 'full' } } }, async (req, reply) => {
    const actor = req.actor!;
    await audit.record(actor.db, {
      action: 'auth.logout_all',
      actor: { type: 'user', userId: actor.userId },
      target: { type: 'user', id: actor.userId },
      ip: req.ip,
    });
    await app.sessions.revokeAllForUser(actor.db, actor.userId);
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  r.get(
    '/api/me',
    { config: { auth: { level: 'full' } }, schema: { response: { 200: meResponseSchema } } },
    async (req) => {
      const actor = req.actor!;
      const user = await actor.db.collection('users').findOne({ _id: actor.userId });
      if (!user) throw new HttpError(401, 'unauthenticated');
      return {
        user: { id: user._id, email: user.email, name: user.name, timezone: user.timezone, ...factorsOf(user) },
        csrfToken: actor.csrfToken,
        memberships: await listMemberships(actor.db, actor.userId),
      };
    },
  );
}
