import { NOTIFICATION_LIMITS } from '@roadmap/shared';
import type { Db, IndexDescription } from 'mongodb';

const AUDIT_TTL_SECONDS = 2592000; // 30 days
const NOTIFICATION_TTL_SECONDS = NOTIFICATION_LIMITS.keepDays * 86400; // 90 days

// One createIndexes call per collection: each call is one round of index-build bookkeeping on the server,
// so a fresh database (every test file makes one) costs one build per collection rather than one per index.
const INDEXES: Record<string, IndexDescription[]> = {
  users: [
    // Pre-auth lookups (not tenant-first by design).
    { key: { email: 1 }, unique: true },
    { key: { 'passkeys.credentialId': 1 }, unique: true, sparse: true },
    { key: { tenantId: 1, email: 1 } },
  ],
  sessions: [
    { key: { tokenHash: 1 }, unique: true },
    { key: { tenantId: 1, userId: 1 } },
    // TTL indexes are single-field by necessity.
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
  invites: [{ key: { tokenHash: 1 }, unique: true }, { key: { tenantId: 1, email: 1 } }],
  resetTokens: [
    { key: { tokenHash: 1 }, unique: true },
    { key: { tenantId: 1, userId: 1 } },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
  memberships: [
    { key: { tenantId: 1, roadmapId: 1, userId: 1 }, unique: true },
    { key: { tenantId: 1, userId: 1 } },
  ],
  roadmaps: [{ key: { tenantId: 1, createdAt: -1 } }],
  projects: [
    { key: { tenantId: 1, roadmapId: 1, parentId: 1, rank: 1 } },
    { key: { tenantId: 1, roadmapId: 1, path: 1 } },
  ],
  notes: [{ key: { tenantId: 1, projectId: 1, createdAt: 1 } }, { key: { tenantId: 1, roadmapId: 1 } }],
  attachments: [{ key: { tenantId: 1, projectId: 1, createdAt: 1 } }, { key: { tenantId: 1, roadmapId: 1 } }],
  auditEvents: [
    { key: { tenantId: 1, timestamp: -1 } },
    { key: { tenantId: 1, roadmapId: 1, timestamp: -1 } },
    { key: { timestamp: 1 }, expireAfterSeconds: AUDIT_TTL_SECONDS },
  ],
  snapshots: [
    // Pre-auth lookup by the link's secret part (not tenant-first by design).
    { key: { linkId: 1 }, unique: true },
    { key: { tenantId: 1, roadmapId: 1, createdAt: -1 } },
  ],
  snapshotItems: [{ key: { tenantId: 1, snapshotId: 1 } }],
  snapshotNotes: [{ key: { tenantId: 1, snapshotId: 1, itemId: 1, createdAt: 1 } }],
  snapshotSessions: [
    { key: { tokenHash: 1 }, unique: true },
    { key: { tenantId: 1, snapshotId: 1 } },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
  notifications: [
    { key: { tenantId: 1, userId: 1, createdAt: -1 } },
    { key: { tenantId: 1, userId: 1, readAt: 1 } },
    { key: { tenantId: 1, roadmapId: 1, projectId: 1 } },
    // The worker's scan for rows due to send, across tenants (not tenant-first by design).
    { key: { 'email.state': 1, 'email.nextAttemptAt': 1 } },
    // One due-soon reminder per person and date; other rows carry no dedupeKey.
    { key: { tenantId: 1, userId: 1, dedupeKey: 1 }, unique: true, partialFilterExpression: { dedupeKey: { $exists: true } } },
    { key: { createdAt: 1 }, expireAfterSeconds: NOTIFICATION_TTL_SECONDS },
  ],
  webauthnChallenges: [{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
};

export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all(
    Object.entries(INDEXES).map(([name, specs]) => db.collection(name).createIndexes(specs)),
  );
}
