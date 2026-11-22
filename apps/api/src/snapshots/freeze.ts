import { v7 as uuidv7 } from 'uuid';
import type { ScopedDb } from '../db/scoped.ts';
import type { ProjectDoc, SnapshotItemDoc, SnapshotNoteDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';

export interface FreezeInput {
  roadmapId: string;
  snapshotId: string;
  include: { notes: boolean; assignees: boolean };
  /** Most notes one snapshot may hold; with more, it must be made without notes. */
  maxNotes: number;
}

/** Items that are not archived and have no archived ancestor. */
function liveItems(items: ProjectDoc[]): ProjectDoc[] {
  const archived = new Set(items.filter((p) => p.archived).map((p) => p._id));
  return items.filter((p) => !p.archived && !p.path.some((id) => archived.has(id)));
}

/** User names by id; anyone who no longer exists is left out. */
async function namesOf(s: ScopedDb, userIds: Iterable<string>): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const users = await s.collection('users').find({ _id: { $in: ids } });
  return new Map(users.map((u) => [u._id, u.name]));
}

/**
 * Copies the roadmap's live items (and, when asked, their notes and assignee names) into the snapshot's rows.
 * Call it inside a transaction with that transaction's `s`, so every read sees one moment of the roadmap.
 * Throws 422 too_many_notes when notes are included and there are more than `maxNotes`.
 */
export async function freezeRoadmap(s: ScopedDb, input: FreezeInput): Promise<{ itemCount: number; noteCount: number }> {
  const { roadmapId, snapshotId, include, maxNotes } = input;
  const items = liveItems(await s.collection('projects').find({ roadmapId }, { sort: { depth: 1, rank: 1, _id: 1 } }));
  const kept = new Set(items.map((p) => p._id));

  let noteRows: Array<Omit<SnapshotNoteDoc, 'tenantId'>> = [];
  const liveNotesPerItem = new Map<string, number>();
  if (include.notes) {
    const filter = { roadmapId, projectId: { $in: [...kept] } };
    if ((await s.collection('notes').countDocuments(filter)) > maxNotes) throw new HttpError(422, 'too_many_notes');
    const notes = await s.collection('notes').find(filter, { sort: { createdAt: 1, _id: 1 } });
    const authors = await namesOf(s, notes.map((n) => n.authorId));
    noteRows = notes.map((n) => {
      const deleted = n.deletedAt !== null;
      if (!deleted) liveNotesPerItem.set(n.projectId, (liveNotesPerItem.get(n.projectId) ?? 0) + 1);
      return {
        _id: uuidv7(),
        roadmapId,
        snapshotId,
        itemId: n.projectId,
        noteId: n._id,
        parentId: n.parentId,
        authorName: deleted ? null : (authors.get(n.authorId) ?? null),
        body: deleted ? '' : n.body,
        mentions: deleted ? [] : n.mentions.map((m) => m.name),
        createdAt: n.createdAt,
        edited: n.editedAt !== null,
        deleted,
      };
    });
  }

  const assignees = include.assignees ? await namesOf(s, items.flatMap((p) => p.assigneeIds)) : new Map<string, string>();
  const itemRows: Array<Omit<SnapshotItemDoc, 'tenantId'>> = items.map((p) => ({
    _id: uuidv7(),
    roadmapId,
    snapshotId,
    itemId: p._id,
    parentId: p.parentId,
    depth: p.depth,
    title: p.title,
    description: p.description,
    status: p.status,
    startDate: p.startDate,
    endDate: p.endDate,
    milestones: p.milestones,
    tags: p.tags,
    links: p.links,
    blockedBy: p.blockedBy.filter((id) => kept.has(id)),
    priorityLabel: p.priorityLabel,
    rank: p.rank,
    ...(include.assignees && {
      assignees: p.assigneeIds.flatMap((id) => {
        const name = assignees.get(id);
        return name === undefined ? [] : [name];
      }),
    }),
    ...(include.notes && { noteCount: liveNotesPerItem.get(p._id) ?? 0 }),
  }));

  await s.collection('snapshotItems').insertMany(itemRows);
  await s.collection('snapshotNotes').insertMany(noteRows);
  return { itemCount: itemRows.length, noteCount: [...liveNotesPerItem.values()].reduce((a, b) => a + b, 0) };
}
