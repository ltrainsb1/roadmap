import type { Db, IndexDescription } from 'mongodb';

const AUDIT_TTL_SECONDS = 2592000; // 30 days

// One createIndexes call per collection: each call is one round of index-build bookkeeping on the server,
// so a fresh database (every test file makes one) costs 11 builds rather than 24.
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
  webauthnChallenges: [{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
};

export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all(
    Object.entries(INDEXES).map(([name, specs]) => db.collection(name).createIndexes(specs)),
  );
}
