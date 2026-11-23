import type { FastifyBaseLogger } from 'fastify';
import type { ScopedDb } from '../db/scoped.ts';
import type { ProjectDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';
import type { ObjectStore } from '../files/object-store.ts';
import { loadProject } from './access.ts';

/**
 * The item, open for a change to its notes or files: 404 not_found if it is gone, 409 item_archived if archived.
 * Call it first in every transaction that adds, edits or removes a note or file. It writes the item (contentRevision,
 * never `version`), so a delete of the item at the same instant writes the same document: one of the two
 * transactions conflicts and retries, and no note or file is left on an item that no longer exists.
 */
export async function assertOpenForContent(s: ScopedDb, roadmapId: string, projectId: string): Promise<ProjectDoc> {
  const item = await loadProject(s, roadmapId, projectId);
  if (item.archived) throw new HttpError(409, 'item_archived');
  await s.collection('projects').updateOne({ _id: projectId, roadmapId }, { $inc: { contentRevision: 1 } });
  return item;
}

/**
 * Deletes the notes, notifications and file records of the given items, or of the whole roadmap when `projectIds` is
 * left out.
 * Returns the storage keys of the files, which the caller deletes after the transaction commits.
 */
export async function deleteContentOf(
  s: ScopedDb,
  filter: { roadmapId: string; projectIds?: string[] },
): Promise<{ keys: string[] }> {
  const { roadmapId, projectIds } = filter;
  const filterFor = { roadmapId, ...(projectIds !== undefined && { projectId: { $in: projectIds } }) };
  await s.collection('notes').deleteMany(filterFor);
  await s.collection('notifications').deleteMany(filterFor);
  const attachments = s.collection('attachments');
  const keys = (await attachments.find(filterFor)).map((a) => a.key);
  await attachments.deleteMany(filterFor);
  return { keys };
}

/**
 * Deletes stored files once the transaction that removed their records has committed (or, for an upload, failed).
 * A failure leaves orphaned objects, which is logged and not thrown: the records are already gone.
 */
export async function deleteStoredFiles(store: ObjectStore, keys: string[], log: FastifyBaseLogger): Promise<void> {
  if (keys.length === 0) return;
  try {
    await store.deleteMany(keys);
  } catch (err) {
    log.error({ err, keys }, 'stored files not deleted');
  }
}
