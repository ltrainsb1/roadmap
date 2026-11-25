import type {
  FeedChoices,
  Milestone,
  NotificationDetail,
  NotificationPrefs,
  NotificationType,
  PriorityLabel,
  ProjectLink,
  ProjectStatus,
  Role,
  SnapshotItem,
} from '@roadmap/shared';

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
  /** Only the settings the person changed; the rest are `DEFAULT_PREFS`. */
  notificationPrefs?: Partial<NotificationPrefs>;
  /** The local date (`YYYY-MM-DD`, in `timezone`) of the last digest sent. */
  digestSentOn?: string;
  /** Set by the worker when SES reports a bounce or a spam complaint; notification emails stop until the person resumes. */
  emailBlocked?: { reason: 'bounced' | 'complained'; at: Date };
  createdAt: Date;
}

export interface MembershipDoc {
  _id: string;
  tenantId: string;
  roadmapId: string;
  userId: string;
  role: Role;
  createdAt: Date;
  /**
   * Bumped each time a notification is written for this member. Removal deletes this document, so a notification
   * written at the same instant conflicts with the removal and one of the two transactions retries.
   */
  notifyRevision?: number;
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
  /** Bumped by every snapshot create, so concurrent creates (and a create and the roadmap's delete) conflict and run one after the other. */
  snapshotRevision?: number;
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

export interface SnapshotDoc {
  _id: string;
  tenantId: string;
  roadmapId: string;
  /** The secret part of the snapshot's link; stored as it is so Admins can copy the link again. */
  linkId: string;
  name: string;
  /** The date label the Admin chose, YYYY-MM-DD. */
  asOf: string;
  roadmapName: string;
  include: { notes: boolean; assignees: boolean };
  passwordHash: string;
  expiresAt: Date | null;
  itemCount: number;
  noteCount: number;
  failedUnlocks: number;
  lockedUntil: Date | null;
  openCount: number;
  lastOpenedAt: Date | null;
  /** Object-store keys of the PDFs made so far. */
  pdfs: { list?: string; timeline?: string };
  createdBy: string;
  createdAt: Date;
}

/** One frozen item. `itemId` is the live item's id, which `parentId` and `blockedBy` refer to. */
export interface SnapshotItemDoc extends Omit<SnapshotItem, 'id'> {
  _id: string;
  tenantId: string;
  roadmapId: string;
  snapshotId: string;
  itemId: string;
}

/** One frozen note. `noteId` is the live note's id, which a reply's `parentId` refers to. */
export interface SnapshotNoteDoc {
  _id: string;
  tenantId: string;
  roadmapId: string;
  snapshotId: string;
  itemId: string;
  noteId: string;
  parentId: string | null;
  authorName: string | null;
  body: string;
  /** Names of the people mentioned. */
  mentions: string[];
  createdAt: Date;
  edited: boolean;
  deleted: boolean;
}

/** A person's calendar feed (FR-4.1): one per person; only the token's SHA-256 hash is kept. */
export interface CalendarFeedDoc {
  _id: string;
  tenantId: string;
  userId: string;
  tokenHash: string;
  choices: FeedChoices;
  createdAt: Date;
  /** When the current link was made (FR-4.4). Feeds stored before it was kept don't have it: read it as createdAt. */
  linkCreatedAt?: Date;
  lastFetchedAt: Date | null;
}

export interface SnapshotSessionDoc {
  _id: string;
  tenantId: string;
  snapshotId: string;
  tokenHash: string;
  kind: 'viewer' | 'render';
  expiresAt: Date;
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

export interface NotificationDoc {
  _id: string;
  tenantId: string;
  roadmapId: string;
  /** The recipient. */
  userId: string;
  type: NotificationType;
  /** Null for due soon. */
  actorId: string | null;
  projectId: string;
  /** The item's title when the row was written. */
  projectTitle: string;
  detail: NotificationDetail;
  /** Due soon only: `due:{projectId}:{end|milestoneId}:{date}`; unique per tenant and recipient. */
  dedupeKey?: string;
  /** Mentioned only: the note that mentioned the recipient, so deleting or editing the note reaches this row. */
  noteId?: string;
  createdAt: Date;
  readAt: Date | null;
  email: {
    state: 'pending' | 'sending' | 'sent' | 'skipped' | 'failed';
    attempts: number;
    nextAttemptAt: Date;
    leaseUntil: Date | null;
    sentAt: Date | null;
  };
}
