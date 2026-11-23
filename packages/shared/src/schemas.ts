import { z } from 'zod';
import { ROLES } from './roles.ts';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(12).max(128);

/** Sign-in only checks length bounds: a short wrong password is a 401, not a validation error. */
export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const loginResponseSchema = z.object({
  next: z.enum(['mfa', 'enroll']),
  csrfToken: z.string(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const membershipSchema = z.object({
  roadmapId: z.string(),
  roadmapName: z.string(),
  role: z.enum(ROLES),
});
export type Membership = z.infer<typeof membershipSchema>;

export const meResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    timezone: z.string(),
    hasTotp: z.boolean(),
    passkeys: z.array(z.object({ id: z.string(), name: z.string(), createdAt: z.iso.datetime() })),
  }),
  csrfToken: z.string(),
  memberships: z.array(membershipSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const createRoadmapRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
});
export type CreateRoadmapRequest = z.infer<typeof createRoadmapRequestSchema>;

export const idResponseSchema = z.object({ id: z.string() });
export type IdResponse = z.infer<typeof idResponseSchema>;

export const roadmapListResponseSchema = z.array(membershipSchema);
export type RoadmapListResponse = z.infer<typeof roadmapListResponseSchema>;

/** Owners are never invited: ownership moves only by transfer. */
export const INVITE_ROLES = ['admin', 'contributor'] as const;
export const inviteRequestSchema = z.object({ email: emailSchema, role: z.enum(INVITE_ROLES) });
export type InviteRequest = z.infer<typeof inviteRequestSchema>;

export const inviteInfoSchema = z.object({
  roadmapName: z.string(),
  email: z.string(),
  role: z.enum(INVITE_ROLES),
  accountExists: z.boolean(),
});
export type InviteInfo = z.infer<typeof inviteInfoSchema>;

/** Only sent when the invite creates the account; a signed-in user sends no body. */
const isTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const acceptInviteRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  password: passwordSchema,
  timezone: z.string().min(1).max(64).refine(isTimeZone, 'unknown time zone').optional(),
});
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;

export const acceptInviteResponseSchema = z.object({
  roadmapId: z.string(),
  next: z.enum(['enroll', 'done']),
  /** Present when the invite created the account: the new session needs it to enroll. */
  csrfToken: z.string().optional(),
});
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;

export const memberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
});
export const openInviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(INVITE_ROLES),
  expiresAt: z.iso.datetime(),
});
export const membersResponseSchema = z.object({
  members: z.array(memberSchema),
  invites: z.array(openInviteSchema),
});
export type MembersResponse = z.infer<typeof membersResponseSchema>;

/** Owners are never a target role: ownership moves only by transfer. */
export const changeRoleRequestSchema = z.object({ role: z.enum(INVITE_ROLES) });
export type ChangeRoleRequest = z.infer<typeof changeRoleRequestSchema>;

export const transferRequestSchema = z.object({ userId: z.string().min(1).max(100) });
export type TransferRequest = z.infer<typeof transferRequestSchema>;

export const deleteRoadmapRequestSchema = z.object({ confirmName: z.string().max(120) });
export type DeleteRoadmapRequest = z.infer<typeof deleteRoadmapRequestSchema>;

// Later plans add their own action strings here.
export const AUDIT_ACTIONS = [
  'auth.login.success',
  'auth.login.failure',
  'auth.mfa.failure',
  'auth.logout',
  'auth.logout_all',
  'auth.password_reset',
  'auth.totp.enrolled',
  'auth.recovery.regenerated',
  'auth.passkey.added',
  'auth.passkey.removed',
  'roadmap.create',
  'roadmap.delete',
  'roadmap.transfer',
  'invite.create',
  'invite.accept',
  'invite.revoke',
  'member.role_change',
  'member.remove',
  'project.create',
  'project.update',
  'project.delete',
  'project.archive',
  'project.unarchive',
  'project.assign',
  'project.reorder',
  'project.priority_label',
  'note.create',
  'note.update',
  'note.delete',
  'attachment.create',
  'attachment.delete',
  'attachment.rejected',
  'snapshot.create',
  'snapshot.revoke',
  'snapshot.access',
  'snapshot.locked',
  'user.notification_prefs',
] as const;
export type AuditActionName = (typeof AUDIT_ACTIONS)[number];

const isoInstant = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
export const auditQuerySchema = z.object({
  action: z.enum(AUDIT_ACTIONS).optional(),
  actorId: z.string().min(1).max(100).optional(),
  from: isoInstant.optional(),
  to: isoInstant.optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditEventSchema = z.object({
  id: z.string(),
  timestamp: z.iso.datetime(),
  action: z.string(),
  /** `name` is null when the user no longer exists. */
  actor: z.object({
    type: z.enum(['user', 'ai', 'system']),
    userId: z.string().optional(),
    name: z.string().nullable().optional(),
  }),
  target: z.object({ type: z.string(), id: z.string() }),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  ip: z.string().nullable(),
});
export const auditPageSchema = z.object({
  items: z.array(auditEventSchema),
  nextCursor: z.string().nullable(),
});
export type AuditPage = z.infer<typeof auditPageSchema>;
