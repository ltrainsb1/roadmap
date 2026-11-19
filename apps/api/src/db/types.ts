import type { Role } from '@roadmap/shared';

// _id is a UUID v7 string. Every doc except TenantDoc and WebauthnChallengeDoc carries tenantId.
// Later tasks add their fields to these types.

export interface TenantDoc {
  _id: string;
  name: string;
  createdAt: Date;
}

export interface UserDoc {
  _id: string;
  tenantId: string;
  email: string;
  name: string;
  timezone: string;
  passwordHash: string | null;
  failedLogins: number;
  lockedUntil: Date | null;
  /** Null until the user has confirmed enrollment. `lastStep` is the newest 30 s step accepted (replay guard). */
  totp: { secretEnc: string; lastStep: number } | null;
  /** Secret from enroll/start, waiting for the first valid code. */
  pendingTotpSecretEnc: string | null;
  /** SHA-256 hex of each code; `usedAt` is set when it is spent. */
  recoveryCodes: { hash: string; usedAt: Date | null }[];
  /**
   * Absent until the first passkey is added (the unique sparse index on `credentialId` needs that).
   * `id` is ours, used in URLs; `credentialId` and `publicKey` are base64url.
   */
  passkeys?: Array<{
    id: string;
    credentialId: string;
    publicKey: string;
    counter: number;
    transports: string[];
    name: string;
    createdAt: Date;
  }>;
  createdAt: Date;
}

export interface MembershipDoc {
  _id: string;
  tenantId: string;
  roadmapId: string;
  userId: string;
  role: Role;
}

export interface RoadmapDoc {
  _id: string;
  tenantId: string;
  name: string;
  /** Set when a roadmap is archived; archived roadmaps drop out of /api/me. */
  archivedAt?: Date | null;
  createdAt: Date;
}

export interface SessionDoc {
  _id: string;
  tenantId: string;
  userId: string;
  tokenHash: string;
  state: 'pending_mfa' | 'pending_enroll' | 'full';
  csrfToken: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string;
  userAgent: string;
  /** Registration or second-factor challenge; cleared when read, so it works once. */
  webauthnChallenge?: string;
  webauthnChallengeExpiresAt?: Date;
}

export interface InviteDoc {
  _id: string;
  tenantId: string;
  email: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface ResetTokenDoc {
  _id: string;
  tenantId: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface WebauthnChallengeDoc {
  _id: string;
  challenge: string;
  expiresAt: Date;
}

export type AuditActorDoc =
  | { type: 'user'; userId: string }
  | { type: 'ai'; onBehalfOf: string }
  | { type: 'system' };

export interface AuditEventDoc {
  _id: string;
  tenantId: string;
  timestamp: Date;
  action: string;
  actor: AuditActorDoc;
  roadmapId?: string;
  target: { type: string; id: string };
  before?: unknown;
  after?: unknown;
  ip: string | null;
}
