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
