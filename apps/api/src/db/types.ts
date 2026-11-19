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
  createdAt: Date;
}

export interface MembershipDoc {
  _id: string;
  tenantId: string;
  roadmapId: string;
  userId: string;
}

export interface RoadmapDoc {
  _id: string;
  tenantId: string;
  name: string;
  createdAt: Date;
}

export interface SessionDoc {
  _id: string;
  tenantId: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
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
  expiresAt: Date;
}

export interface AuditEventDoc {
  _id: string;
  tenantId: string;
  timestamp: Date;
}
