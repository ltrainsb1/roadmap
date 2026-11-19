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
  memberships: z.array(
    z.object({ roadmapId: z.string(), roadmapName: z.string(), role: z.enum(ROLES) }),
  ),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
