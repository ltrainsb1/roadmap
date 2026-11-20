import {
  acceptInviteRequestSchema,
  acceptInviteResponseSchema,
  idResponseSchema,
  inviteInfoSchema,
  inviteRequestSchema,
  type InviteRequest,
} from '@roadmap/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { createAuditLog } from '../audit/audit.ts';
import { assertNewPasswordAllowed, hashPassword } from '../auth/passwords.ts';
import { setSessionCookie } from '../auth/sessions.ts';
import { hashToken, newToken } from '../auth/tokens.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { scoped, type ScopedDb } from '../db/scoped.ts';
import type { InviteDoc, UserDoc } from '../db/types.ts';
import { unscoped } from '../db/unscoped.ts';
import { HttpError } from '../errors.ts';
import type { Mailer } from '../mail/mailer.ts';
import { inviteEmail } from '../mail/templates.ts';
import { csrfMatches } from '../policy/hook.ts';
import { isDuplicateKey } from '../db/errors.ts';
import { roadmapParams } from '../params.ts';

export interface InviteRouteDeps {
  db: Db;
  config: Config;
  mailer: Mailer;
  now: () => Date;
  fetch?: typeof fetch;
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

const tokenParams = z.object({ token: z.string().min(1).max(200) });
// Unknown, expired, revoked and used links all look the same.
const inviteInvalid = () => new HttpError(410, 'invite_invalid');

const isOpen = (i: InviteDoc, now: Date): boolean => i.acceptedAt === null && i.revokedAt === null && i.expiresAt > now;

export function registerInviteRoutes(app: FastifyInstance, deps: InviteRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();
  const lookup = unscoped(deps.db);

  /** Whether `email` already belongs to a member of the roadmap. */
  const isMember = async (s: ScopedDb, roadmapId: string, email: string): Promise<boolean> => {
    const user = await s.collection('users').findOne({ email });
    return user !== null && (await s.collection('memberships').findOne({ roadmapId, userId: user._id })) !== null;
  };

  r.post(
    '/api/roadmaps/:roadmapId/invites',
    {
      config: {
        auth: { level: 'full', action: 'member.invite', ctx: (req) => Promise.resolve({ newRole: (req.body as InviteRequest).role }) },
      },
      schema: { params: roadmapParams, body: inviteRequestSchema, response: { 201: idResponseSchema } },
    },
    async (req, reply) => {
      const actor = req.actor!;
      const { email, role } = req.body;
      const { roadmapId } = req.params;
      const roadmap = await actor.db.collection('roadmaps').findOne({ _id: roadmapId });
      const inviter = await actor.db.collection('users').findOne({ _id: actor.userId });
      if (!roadmap || !inviter) throw new HttpError(404, 'not_found');
      if (await isMember(actor.db, roadmapId, email)) throw new HttpError(409, 'already_member');

      const { token, hash } = newToken();
      const now = deps.now();
      const id = uuidv7();
      await actor.db.withTransaction(async (s) => {
        // Two invites for one address at the same moment would each see no open link and both stay open. Every
        // invite writes this one document, so MongoDB reports a write conflict to the second transaction; it
        // retries and revokes the first one's link. Nothing matched: the roadmap was deleted meanwhile.
        const { matched } = await s.collection('roadmaps').updateOne({ _id: roadmapId }, { $inc: { membershipRevision: 1 } });
        if (matched === 0) throw new HttpError(404, 'not_found');
        // One open link per person and roadmap: the earlier one stops working.
        const open = await s.collection('invites').find({ roadmapId, email, acceptedAt: null, revokedAt: null });
        for (const old of open) {
          await s.collection('invites').updateOne({ _id: old._id, acceptedAt: null, revokedAt: null }, { $set: { revokedAt: now } });
        }
        const invite = await s.collection('invites').insertOne({
          _id: id,
          roadmapId,
          email,
          role,
          tokenHash: hash,
          invitedBy: actor.userId,
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
          acceptedAt: null,
          revokedAt: null,
        });
        await audit.record(s, {
          action: 'invite.create',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'invite', id },
          after: { email, role, expiresAt: invite.expiresAt },
          ip: req.ip,
        });
      });
      await deps.mailer.send({
        to: email,
        ...inviteEmail({
          roadmapName: roadmap.name,
          inviterName: inviter.name,
          url: `${deps.config.appOrigin}/invite/${token}`,
        }),
      });
      return reply.status(201).send({ id });
    },
  );

  r.get(
    '/api/invites/:token',
    {
      config: { auth: { level: 'public' } },
      schema: { params: tokenParams, response: { 200: inviteInfoSchema } },
    },
    async (req) => {
      const invite = await lookup.findInviteByTokenHash(hashToken(req.params.token));
      if (!invite || !isOpen(invite, deps.now())) throw inviteInvalid();
      const roadmap = await scoped(deps.db, invite.tenantId).collection('roadmaps').findOne({ _id: invite.roadmapId });
      if (!roadmap) throw inviteInvalid();
      return {
        roadmapName: roadmap.name,
        email: invite.email,
        role: invite.role,
        accountExists: (await lookup.findUserByEmail(invite.email)) !== null,
      };
    },
  );

  r.post(
    '/api/invites/:token/accept',
    {
      config: { auth: { level: 'public' } },
      schema: { params: tokenParams, response: { 200: acceptInviteResponseSchema } },
    },
    async (req, reply) => {
      const now = deps.now();
      const tokenHash = hashToken(req.params.token);
      const found = await lookup.findInviteByTokenHash(tokenHash);
      if (!found || !isOpen(found, now)) throw inviteInvalid();
      // The route is public, so the hook did not check CSRF; whenever a session is present, we do.
      if (req.actor && !csrfMatches(req.headers['x-csrf-token'], req.actor.csrfToken)) throw new HttpError(403, 'csrf');
      const s = scoped(deps.db, found.tenantId);
      const account = await lookup.findUserByEmail(found.email);

      // Everything that can be refused is checked before the claim, so most failures never spend the link.
      let newAccount: { name: string; timezone: string; passwordHash: string } | null = null;
      if (account) {
        if (account.tenantId !== found.tenantId) throw new HttpError(409, 'other_tenant');
        await requireSignedInAs(req, account);
        if (await isMember(s, found.roadmapId, found.email)) throw new HttpError(409, 'already_member');
      } else {
        const body = acceptInviteRequestSchema.parse(req.body);
        await assertNewPasswordAllowed(body.password, {
          config: deps.config,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          log: req.log,
        });
        newAccount = { name: body.name, timezone: body.timezone ?? 'UTC', passwordHash: await hashPassword(body.password) };
      }

      // The conditional update is the single-use gate: of two concurrent accepts only one gets the invite back.
      const claimed = await s
        .collection('invites')
        .findOneAndUpdate({ tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { $gt: now } }, { $set: { acceptedAt: now } });
      if (!claimed) throw inviteInvalid();

      // Set once the membership is stored. A failure after that must not reopen a link that has done its work.
      let granted = false;
      try {
        const membership = (s2: ScopedDb, userId: string) =>
          s2.collection('memberships').insertOne({ _id: uuidv7(), roadmapId: claimed.roadmapId, userId, role: claimed.role, createdAt: now });
        const auditAccept = (s2: ScopedDb, userId: string) =>
          audit.record(s2, {
            action: 'invite.accept',
            actor: { type: 'user', userId },
            roadmapId: claimed.roadmapId,
            target: { type: 'invite', id: claimed._id },
            after: { email: claimed.email, role: claimed.role, userId },
            ip: req.ip,
          });

        if (!account && newAccount) {
          const userId = uuidv7();
          const fresh = newAccount;
          await s.withTransaction(async (tx) => {
            try {
              await tx.collection('users').insertOne({
                _id: userId,
                email: claimed.email,
                name: fresh.name,
                timezone: fresh.timezone,
                passwordHash: fresh.passwordHash,
                failedLogins: 0,
                lockedUntil: null,
                totp: null,
                pendingTotpSecretEnc: null,
                recoveryCodes: [],
                createdAt: now,
              });
            } catch (err) {
              if (isDuplicateKey(err)) throw new HttpError(409, 'email_exists');
              throw err;
            }
            await membership(tx, userId);
            await auditAccept(tx, userId);
          });
          granted = true;
          // After the commit, so a failed accept never leaves a session for an account that was rolled back.
          const { token, session } = await app.sessions.create(s, userId, 'pending_enroll', {
            ip: req.ip,
            userAgent: req.headers['user-agent'] ?? '',
          });
          setSessionCookie(reply, token);
          return { roadmapId: claimed.roadmapId, next: 'enroll' as const, csrfToken: session.csrfToken };
        }

        const userId = account!._id;
        try {
          await membership(s, userId);
        } catch (err) {
          if (isDuplicateKey(err)) throw new HttpError(409, 'already_member');
          throw err;
        }
        granted = true;
        await auditAccept(s, userId);
        return { roadmapId: claimed.roadmapId, next: 'done' as const };
      } catch (err) {
        // Nothing was granted, so the link stays usable.
        if (!granted) await s.collection('invites').updateOne({ _id: claimed._id }, { $set: { acceptedAt: null } });
        throw err;
      }
    },
  );

  /** The existing-account path: the caller must hold a full session of that very user. */
  async function requireSignedInAs(req: import('fastify').FastifyRequest, account: UserDoc): Promise<void> {
    const actor = req.actor;
    if (!actor) throw new HttpError(401, 'sign_in_required');
    const session = await actor.db.collection('sessions').findOne({ _id: actor.sessionId });
    if (session?.state !== 'full' || actor.userId !== account._id) throw new HttpError(401, 'sign_in_required');
  }
}
