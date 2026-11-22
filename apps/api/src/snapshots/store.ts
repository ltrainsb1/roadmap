import type { ScopedDb } from '../db/scoped.ts';

/**
 * Deletes the snapshots of a roadmap (or the one `snapshotId`) with their frozen items, notes and viewer sessions.
 * Call it inside a transaction. Returns the object-store keys of their PDFs, which the caller deletes after the
 * transaction commits.
 */
export async function deleteSnapshots(
  s: ScopedDb,
  filter: { roadmapId: string; snapshotId?: string },
): Promise<{ deleted: number; keys: string[] }> {
  const { roadmapId, snapshotId } = filter;
  const snapshots = await s.collection('snapshots').find({ roadmapId, ...(snapshotId !== undefined && { _id: snapshotId }) });
  if (snapshots.length === 0) return { deleted: 0, keys: [] };
  const ids = snapshots.map((x) => x._id);
  await s.collection('snapshotItems').deleteMany({ snapshotId: { $in: ids } });
  await s.collection('snapshotNotes').deleteMany({ snapshotId: { $in: ids } });
  await s.collection('snapshotSessions').deleteMany({ snapshotId: { $in: ids } });
  const { deleted } = await s.collection('snapshots').deleteMany({ _id: { $in: ids } });
  const keys = snapshots.flatMap((x) => [x.pdfs.list, x.pdfs.timeline].filter((k): k is string => k !== undefined));
  return { deleted, keys };
}
