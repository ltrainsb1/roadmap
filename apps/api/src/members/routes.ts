import {
  changeRoleRequestSchema,
  deleteRoadmapRequestSchema,
  membersResponseSchema,
  transferRequestSchema,
  type ChangeRoleRequest,
} from '@roadmap/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createAuditLog } from '../audit/audit.ts';
import type { MembershipDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';
import { canEver, type PolicyContext } from '../policy/policy.ts';

export interface MemberRouteDeps {
  now: () => Date;
}

const roadmapParams = z.object({ roadmapId: z.string().min(1).max(100) });
const memberParams = roadmapParams.extend({ userId: z.string().min(1).max(100) });
const inviteParams = roadmapParams.extend({ inviteId: z.string().min(1).max(100) });
const noContent = { 204: z.null().describe('No content') };

export function registerMemberRoutes(app: FastifyInstance, deps: MemberRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();

  /** The target's current membership in this roadmap; anyone else (other roadmap, other tenant) is 404. */
  async function targetMembership(req: FastifyRequest): Promise<MembershipDoc> {
    const { roadmapId, userId } = req.params as z.infer<typeof memberParams>;
    const target = await req.actor!.db.collection('memberships').findOne({ roadmapId, userId });
    if (!target) throw new HttpError(404, 'not_found');
    return target;
  }

  /** Context for member.remove / member.changeRole. A caller who may manage members is told why the owner is untouchable. */
  async function memberCtx(
    req: FastifyRequest,
    action: 'member.remove' | 'member.changeRole',
    extra: PolicyContext,
  ): Promise<PolicyContext> {
    const target = await targetMembership(req);
    if (target.role === 'owner' && canEver(req.actor!.role, action)) throw new HttpError(409, 'owner_immutable');
    return { targetRole: target.role, ...extra };
  }

  r.get(
    '/api/roadmaps/:roadmapId/members',
    {
      config: { auth: { level: 'full', action: 'roadmap.view' } },
      schema: { params: roadmapParams, response: { 200: membersResponseSchema } },
    },
    async (req) => {
      const { roadmapId } = req.params;
      const db = req.actor!.db;
      const memberships = await db.collection('memberships').find({ roadmapId });
      const users = await db.collection('users').find({ _id: { $in: memberships.map((m) => m.userId) } });
      const byId = new Map(users.map((u) => [u._id, u]));
      const members = memberships
        .flatMap((m) => {
          const u = byId.get(m.userId);
          return u ? [{ userId: u._id, name: u.name, email: u.email, role: m.role }] : [];
        })
        .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
      const now = deps.now();
      const open = await db
        .collection('invites')
        .find({ roadmapId, acceptedAt: null, revokedAt: null, expiresAt: { $gt: now } });
      const invites = open
        .map((i) => ({ id: i._id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString() }))
        .sort((a, b) => a.email.localeCompare(b.email));
      return { members, invites };
    },
  );

  r.patch(
    '/api/roadmaps/:roadmapId/members/:userId',
    {
      config: {
        auth: {
          level: 'full',
          action: 'member.changeRole',
          ctx: (req) => memberCtx(req, 'member.changeRole', { newRole: (req.body as ChangeRoleRequest).role }),
        },
      },
      schema: { params: memberParams, body: changeRoleRequestSchema, response: noContent },
    },
    async (req, reply) => {
      const actor = req.actor!;
      const { roadmapId, userId } = req.params;
      const { role } = req.body;
      await actor.db.withTransaction(async (s) => {
        const before = await s.collection('memberships').findOne({ roadmapId, userId });
        if (!before) throw new HttpError(404, 'not_found');
        if (before.role === 'owner') throw new HttpError(409, 'owner_immutable');
        if (before.role === role) return;
        // The role filter keeps a concurrent transfer from being overwritten.
        const done = await s
          .collection('memberships')
          .updateOne({ _id: before._id, role: before.role }, { $set: { role } });
        if (done.matched === 0) throw new HttpError(409, 'conflict');
        await audit.record(s, {
          action: 'member.role_change',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'user', id: userId },
          before: { role: before.role },
          after: { role },
          ip: req.ip,
        });
      });
      return reply.status(204).send(null);
    },
  );

  r.delete(
    '/api/roadmaps/:roadmapId/members/:userId',
    {
      config: { auth: { level: 'full', action: 'member.remove', ctx: (req) => memberCtx(req, 'member.remove', {}) } },
      schema: { params: memberParams, response: noContent },
    },
    async (req, reply) => {
      const actor = req.actor!;
      const { roadmapId, userId } = req.params;
      await actor.db.withTransaction(async (s) => {
        const before = await s.collection('memberships').findOne({ roadmapId, userId });
        if (!before) throw new HttpError(404, 'not_found');
        if (before.role === 'owner') throw new HttpError(409, 'owner_immutable');
        const done = await s.collection('memberships').deleteOne({ _id: before._id, role: before.role });
        if (done.deleted === 0) throw new HttpError(409, 'conflict');
        await audit.record(s, {
          action: 'member.remove',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'user', id: userId },
          before: { role: before.role },
          ip: req.ip,
        });
      });
      // Sessions stay: the user may belong to other roadmaps. This roadmap now answers them with 404.
      return reply.status(204).send(null);
    },
  );

  r.delete(
    '/api/roadmaps/:roadmapId/invites/:inviteId',
    {
      config: {
        auth: {
          level: 'full',
          action: 'member.invite',
          ctx: async (req) => {
            const { roadmapId, inviteId } = req.params as z.infer<typeof inviteParams>;
            const invite = await req.actor!.db.collection('invites').findOne({ _id: inviteId, roadmapId });
            if (!invite) throw new HttpError(404, 'not_found');
            return { newRole: invite.role };
          },
        },
      },
      schema: { params: inviteParams, response: noContent },
    },
    async (req, reply) => {
      const actor = req.actor!;
      const { roadmapId, inviteId } = req.params;
      await actor.db.withTransaction(async (s) => {
        // Only an open invite can be revoked; an accepted or already revoked one is gone as far as the caller knows.
        const invite = await s
          .collection('invites')
          .findOneAndUpdate(
            { _id: inviteId, roadmapId, acceptedAt: null, revokedAt: null },
            { $set: { revokedAt: deps.now() } },
          );
        if (!invite) throw new HttpError(404, 'not_found');
        await audit.record(s, {
          action: 'invite.revoke',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'invite', id: inviteId },
          before: { email: invite.email, role: invite.role },
          ip: req.ip,
        });
      });
      return reply.status(204).send(null);
    },
  );

  r.post(
    '/api/roadmaps/:roadmapId/transfer',
    {
      config: { auth: { level: 'full', action: 'roadmap.transfer' } },
      schema: { params: roadmapParams, body: transferRequestSchema, response: noContent },
    },
    async (req, reply) => {
      const actor = req.actor!;
      const { roadmapId } = req.params;
      const { userId } = req.body;
      if (userId === actor.userId) throw new HttpError(422, 'already_owner');
      await actor.db.withTransaction(async (s) => {
        const target = await s.collection('memberships').findOne({ roadmapId, userId });
        if (!target) throw new HttpError(422, 'not_a_member');
        // Conditional on the caller still being owner, so two racing transfers cannot both win.
        const demoted = await s
          .collection('memberships')
          .updateOne({ roadmapId, userId: actor.userId, role: 'owner' }, { $set: { role: 'admin' } });
        if (demoted.matched === 0) throw new HttpError(403, 'forbidden');
        await s.collection('memberships').updateOne({ _id: target._id }, { $set: { role: 'owner' } });
        await s.collection('roadmaps').updateOne({ _id: roadmapId }, { $set: { ownerId: userId } });
        await audit.record(s, {
          action: 'roadmap.transfer',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'roadmap', id: roadmapId },
          before: { ownerId: actor.userId },
          after: { ownerId: userId },
          ip: req.ip,
        });
      });
      return reply.status(204).send(null);
    },
  );

  r.delete(
    '/api/roadmaps/:roadmapId',
    {
      config: { auth: { level: 'full', action: 'roadmap.delete' } },
      schema: { params: roadmapParams, body: deleteRoadmapRequestSchema, response: noContent },
    },
    async (req, reply) => {
      const actor = req.actor!;
      const { roadmapId } = req.params;
      const roadmap = await actor.db.collection('roadmaps').findOne({ _id: roadmapId });
      if (!roadmap) throw new HttpError(404, 'not_found');
      if (req.body.confirmName !== roadmap.name) throw new HttpError(422, 'confirm_mismatch');
      await actor.db.withTransaction(async (s) => {
        // Later plans extend this with projects and the other data that hangs off a roadmap.
        await s.collection('invites').deleteMany({ roadmapId });
        await s.collection('memberships').deleteMany({ roadmapId });
        await s.collection('roadmaps').deleteOne({ _id: roadmapId });
        await audit.record(s, {
          action: 'roadmap.delete',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'roadmap', id: roadmapId },
          before: { name: roadmap.name },
          ip: req.ip,
        });
      });
      return reply.status(204).send(null);
    },
  );
}
