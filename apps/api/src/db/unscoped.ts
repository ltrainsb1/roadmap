import type { Db } from 'mongodb';
import type {
  CalendarFeedDoc,
  InviteDoc,
  ResetTokenDoc,
  SessionDoc,
  SnapshotDoc,
  TenantDoc,
  UserDoc,
  WebauthnChallengeDoc,
} from './types.ts';

/** The only pre-auth data access: lookups by secret hash or email, before a tenant is known. */
export function unscoped(db: Db) {
  const users = db.collection<UserDoc>('users');
  const sessions = db.collection<SessionDoc>('sessions');
  const invites = db.collection<InviteDoc>('invites');
  const resets = db.collection<ResetTokenDoc>('resetTokens');
  const challenges = db.collection<WebauthnChallengeDoc>('webauthnChallenges');
  const tenants = db.collection<TenantDoc>('tenants');
  const snapshots = db.collection<SnapshotDoc>('snapshots');
  const calendarFeeds = db.collection<CalendarFeedDoc>('calendarFeeds');

  return {
    findUserByEmail: (email: string): Promise<UserDoc | null> => users.findOne({ email }),
    findSessionByTokenHash: (h: string): Promise<SessionDoc | null> =>
      sessions.findOne({ tokenHash: h }),
    findInviteByTokenHash: (h: string): Promise<InviteDoc | null> =>
      invites.findOne({ tokenHash: h }),
    findResetByTokenHash: (h: string): Promise<ResetTokenDoc | null> =>
      resets.findOne({ tokenHash: h }),
    async insertChallenge(c: WebauthnChallengeDoc): Promise<void> {
      await challenges.insertOne(c);
    },
    takeChallenge: (id: string): Promise<WebauthnChallengeDoc | null> =>
      challenges.findOneAndDelete({ _id: id }),
    findUserByCredentialId: (id: string): Promise<UserDoc | null> =>
      users.findOne({ 'passkeys.credentialId': id }),
    /** A viewer opening a snapshot link: the tenant is known only once the snapshot is found. */
    findSnapshotByLinkId: (linkId: string): Promise<SnapshotDoc | null> => snapshots.findOne({ linkId }),
    /** A calendar app fetching a feed: the tenant is known only once the feed is found. */
    findCalendarFeedByTokenHash: (h: string): Promise<CalendarFeedDoc | null> => calendarFeeds.findOne({ tokenHash: h }),
    async insertTenant(t: TenantDoc): Promise<void> {
      await tenants.insertOne(t);
    },
  };
}
