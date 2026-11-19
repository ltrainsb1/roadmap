import type { Db } from 'mongodb';

const AUDIT_TTL_SECONDS = 2592000; // 30 days

export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    // Pre-auth lookups (not tenant-first by design).
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('users').createIndex({ 'passkeys.credentialId': 1 }, { unique: true, sparse: true }),
    db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection('invites').createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection('resetTokens').createIndex({ tokenHash: 1 }, { unique: true }),

    // Tenant-first indexes.
    db.collection('users').createIndex({ tenantId: 1, email: 1 }),
    db.collection('memberships').createIndex(
      { tenantId: 1, roadmapId: 1, userId: 1 },
      { unique: true },
    ),
    db.collection('memberships').createIndex({ tenantId: 1, userId: 1 }),
    db.collection('roadmaps').createIndex({ tenantId: 1, createdAt: -1 }),
    db.collection('sessions').createIndex({ tenantId: 1, userId: 1 }),
    db.collection('invites').createIndex({ tenantId: 1, email: 1 }),
    db.collection('resetTokens').createIndex({ tenantId: 1, userId: 1 }),
    db.collection('auditEvents').createIndex({ tenantId: 1, timestamp: -1 }),
    db.collection('auditEvents').createIndex({ tenantId: 1, roadmapId: 1, timestamp: -1 }),

    // TTL indexes (single-field by necessity).
    db.collection('auditEvents').createIndex({ timestamp: 1 }, { expireAfterSeconds: AUDIT_TTL_SECONDS }),
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('resetTokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('webauthnChallenges').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}
