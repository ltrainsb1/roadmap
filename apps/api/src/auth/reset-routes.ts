import { emailSchema, passwordSchema } from '@roadmap/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createAuditLog } from '../audit/audit.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { scoped } from '../db/scoped.ts';
import { unscoped } from '../db/unscoped.ts';
import { HttpError } from '../errors.ts';
import { resetEmail } from '../mail/templates.ts';
import type { Mailer } from '../mail/mailer.ts';
import { assertNewPasswordAllowed, hashPassword } from './passwords.ts';
import { issueResetToken } from './reset-tokens.ts';
import { hashToken } from './tokens.ts';

export interface ResetRouteDeps {
  db: Db;
  config: Config;
  mailer: Mailer;
  now: () => Date;
  fetch?: typeof fetch;
}

export const RESET_TTL_MS = 60 * 60_000;

const requestBody = z.object({ email: emailSchema });
const confirmBody = z.object({ token: z.string().min(1).max(200), password: passwordSchema });
const tokenInvalid = () => new HttpError(410, 'token_invalid');

export function registerResetRoutes(app: FastifyInstance, deps: ResetRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();
  const lookup = unscoped(deps.db);

  // Work done after the reply is tracked, so shutdown (and tests) can wait for it.
  const background = new Set<Promise<void>>();
  app.addHook('onClose', async () => {
    await Promise.allSettled(background);
  });
  const afterReply = (task: () => Promise<void>, onError: (err: unknown) => void): void => {
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(task)
      .catch(onError)
      .finally(() => background.delete(p));
    background.add(p);
  };

  r.post(
    '/api/auth/password-reset/request',
    { config: { auth: { level: 'public' } }, schema: { body: requestBody } },
    async (req, reply) => {
      const user = await lookup.findUserByEmail(req.body.email);
      // Everything that differs between a known and an unknown address happens after the 202 is on its way.
      if (user) {
        afterReply(
          async () => {
            const url = await issueResetToken(scoped(deps.db, user.tenantId), user._id, RESET_TTL_MS, {
              appOrigin: deps.config.appOrigin,
              now: deps.now,
            });
            await deps.mailer.send({ to: user.email, ...resetEmail({ url, expiresInMinutes: RESET_TTL_MS / 60_000 }) });
          },
          (err) => req.log.error({ err }, 'password reset email failed'),
        );
      }
      return reply.status(202).send({ status: 'accepted' });
    },
  );

  r.post(
    '/api/auth/password-reset/confirm',
    { config: { auth: { level: 'public' } }, schema: { body: confirmBody } },
    async (req, reply) => {
      const now = deps.now();
      const tokenHash = hashToken(req.body.token);
      const found = await lookup.findResetByTokenHash(tokenHash);
      if (!found || found.usedAt !== null || found.expiresAt <= now) throw tokenInvalid();
      const s = scoped(deps.db, found.tenantId);
      const user = await s.collection('users').findOne({ _id: found.userId });
      if (!user) throw tokenInvalid();

      // Checked before the token is spent, so a rejected password does not cost the user their link.
      await assertNewPasswordAllowed(req.body.password, { config: deps.config, ...(deps.fetch ? { fetch: deps.fetch } : {}), log: req.log });
      const passwordHash = await hashPassword(req.body.password);

      // The conditional update is the single-use gate: of two concurrent confirms only one gets the token back.
      const claimed = await s
        .collection('resetTokens')
        .findOneAndUpdate({ _id: found._id, usedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } });
      if (!claimed) throw tokenInvalid();

      // Clears the lock directly: a reset is not a sign-in, so it does not go through recordSuccess.
      await s
        .collection('users')
        .updateOne({ _id: user._id }, { $set: { passwordHash, failedLogins: 0, lockedUntil: null } });
      await app.sessions.revokeAllForUser(s, user._id);
      await s.collection('resetTokens').deleteMany({ userId: user._id, usedAt: null });
      await audit.record(s, {
        action: 'auth.password_reset',
        actor: { type: 'user', userId: user._id },
        target: { type: 'user', id: user._id },
        ip: req.ip,
      });
      return reply.status(204).send();
    },
  );
}
