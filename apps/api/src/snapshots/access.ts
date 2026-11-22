import type { FastifyRequest } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { hashToken, newToken } from '../auth/tokens.ts';
import type { Db } from '../db/client.ts';
import { scoped, type ScopedDb } from '../db/scoped.ts';
import type { SnapshotDoc } from '../db/types.ts';
import { unscoped } from '../db/unscoped.ts';
import { HttpError } from '../errors.ts';

/** The viewer's cookie; its path is the one link, so one browser can hold several snapshots open. */
export const SNAPSHOT_COOKIE = '__Secure-snap';
export const VIEWER_SESSION_MS = 12 * 60 * 60_000;
/** A render token lets the PDF service's browser read one snapshot, briefly, without a cookie. */
export const RENDER_TOKEN_MS = 2 * 60_000;
export const RENDER_HEADER = 'x-snapshot-render';

const LIFETIME_MS = { viewer: VIEWER_SESSION_MS, render: RENDER_TOKEN_MS } as const;

/** Stores a new session for the snapshot (only the token's hash is kept) and returns the token. */
export async function createSnapshotSession(
  s: ScopedDb,
  snapshotId: string,
  kind: 'viewer' | 'render',
  now: Date,
): Promise<string> {
  const { token, hash } = newToken();
  await s.collection('snapshotSessions').insertOne({
    _id: uuidv7(),
    snapshotId,
    tokenHash: hash,
    kind,
    expiresAt: new Date(now.getTime() + LIFETIME_MS[kind]),
  });
  return token;
}

export const isExpired = (snapshot: Pick<SnapshotDoc, 'expiresAt'>, now: Date): boolean =>
  snapshot.expiresAt !== null && snapshot.expiresAt <= now;

/** The snapshot behind a link. Throws 404 not_found when there is none, 410 snapshot_expired once it has expired. */
export async function findSnapshot(db: Db, linkId: string, now: Date): Promise<SnapshotDoc> {
  const snapshot = await unscoped(db).findSnapshotByLinkId(linkId);
  if (!snapshot) throw new HttpError(404, 'not_found');
  if (isExpired(snapshot, now)) throw new HttpError(410, 'snapshot_expired');
  return snapshot;
}

/** Which unexpired session of this snapshot the request carries, if any: the render header first, then the cookie. */
async function sessionKind(req: FastifyRequest, s: ScopedDb, snapshotId: string, now: Date) {
  const offered: Array<['viewer' | 'render', unknown]> = [
    ['render', req.headers[RENDER_HEADER]],
    ['viewer', req.cookies[SNAPSHOT_COOKIE]],
  ];
  for (const [kind, token] of offered) {
    if (typeof token !== 'string' || token === '') continue;
    const session = await s
      .collection('snapshotSessions')
      .findOne({ tokenHash: hashToken(token), snapshotId, kind, expiresAt: { $gt: now } });
    if (session) return kind;
  }
  return null;
}

/** Finds the snapshot for the link and checks the cookie or the render header. Throws 404 not_found, 410 snapshot_expired, 401 password_required. */
export async function snapshotAccess(
  req: FastifyRequest,
  db: Db,
  now: Date,
): Promise<{ snapshot: SnapshotDoc; db: ScopedDb; via: 'viewer' | 'render' }> {
  const { linkId } = req.params as { linkId?: unknown };
  if (typeof linkId !== 'string') throw new HttpError(404, 'not_found');
  const snapshot = await findSnapshot(db, linkId, now);
  // The tenant comes from the snapshot, never from a member's session: a signed-in member's cookie changes nothing.
  const s = scoped(db, snapshot.tenantId);
  const via = await sessionKind(req, s, snapshot._id, now);
  if (via === null) throw new HttpError(401, 'password_required');
  return { snapshot, db: s, via };
}
