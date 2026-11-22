import type { Milestone, PriorityLabel, ProjectLink, ProjectStatus, Role } from '@roadmap/shared';

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
  createdAt: Date;
}

export interface RoadmapDoc {
  _id: string;
  tenantId: string;
  name: string;
  description: string;
  ownerId: string;
  /** Archived roadmaps drop out of /api/me and /api/roadmaps. */
  archived: boolean;
  /** Bumped by every blocked-by change so concurrent changes in one roadmap conflict and run one after the other. */
  dependencyRevision?: number;
  /** Bumped by every member removal and every assignment of members, so the two conflict and run one after the other. */
  membershipRevision?: number;
  /** Bumped by every reorder that writes, so two reorders in one roadmap conflict and run one after the other. */
  orderRevision?: number;
  createdAt: Date;
}

export interface ProjectDoc {
  _id: string;
  tenantId: string;
  roadmapId: string;
  parentId: string | null;
  depth: 1 | 2 | 3 | 4;
  /** Ancestor ids from the top-level item down to the parent; empty at depth 1. */
  path: string[];
  title: string;
  description: string;
  status: ProjectStatus;
  startDate: string | null;
  endDate: string | null;
  milestones: Milestone[];
  tags: string[];
  links: ProjectLink[];
  blockedBy: string[];
  assigneeIds: string[];
  /** Order among siblings, from 0. */
  rank: number;
  priorityLabel: PriorityLabel | null;
  archived: boolean;
  /** Bumped on every edit; a stale client version is refused. */
  version: number;
  /**
   * Bumped by every change to the item's notes and files, so such a change and a delete of the item conflict and
   * one retries. Not in the DTO and never changes `version`.
   */
  contentRevision?: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NoteDoc {
  _id: string;
  tenantId: string;
  roadmapId: string;
  projectId: string;
  /** The top-level note this replies to; null for a top-level note. Replies are one level deep. */
  parentId: string | null;
  authorId: string;
  body: string;
  /** Each person mentioned, with their name when the note was saved. */
  mentions: { userId: string; name: string }[];
  createdAt: Date;
  editedAt: Date | null;
  /** Set when a top-level note with replies is deleted; its body and mentions are erased then. */
  deletedAt: Date | null;
}

export interface AttachmentDoc {
  _id: string;
  tenantId: string;
  roadmapId: string;
  projectId: string;
  /** Display name, already cleaned with `cleanFileName`. Never part of `key`. */
  name: string;
  /** Bytes. */
  size: number;
  /** Where the bytes are in the object store: `${tenantId}/${roadmapId}/${_id}`. Never sent to the browser. */
  key: string;
  uploadedById: string;
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
  roadmapId: string;
  email: string;
  role: 'admin' | 'contributor';
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
  /** Set by the atomic claim in accept; a claimed invite never works again unless the claim is released. */
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export interface ResetTokenDoc {
  _id: string;
  tenantId: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  /** Set when the token is spent; a spent token never works again. */
  usedAt: Date | null;
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
