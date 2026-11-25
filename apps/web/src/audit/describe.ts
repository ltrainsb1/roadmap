import type { AuditPage, Role } from '@roadmap/shared';
import { roleName } from '../roles.ts';

type AuditEvent = AuditPage['items'][number];

const FORMER = 'a former member';

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
const text = (value: unknown, key: string): string | undefined => {
  const v = field(value, key);
  return typeof v === 'string' && v !== '' ? v : undefined;
};
const role = (value: unknown): string | undefined => {
  const v = text(value, 'role');
  return v ? roleName(v as Role) : undefined;
};

/** The stored title of the item an event is about; the item may be gone, so this reads the event, not the list. */
const item = (value: unknown): string => text(value, 'title') ?? 'an item';

function actorName(actor: AuditEvent['actor']): string {
  if (actor.type === 'system') return 'The system';
  return actor.name ?? 'A former member';
}

/**
 * One sentence for an audit event, built from a template per action. `nameOf` looks up a member's
 * name from their id; someone it does not know (removed, or no longer an account) reads as a former member.
 */
export function describeAuditEvent(e: AuditEvent, nameOf: (userId: string) => string | undefined): string {
  const who = actorName(e.actor);
  const member = (id: string | undefined) => (id && nameOf(id)) || FORMER;
  switch (e.action) {
    case 'roadmap.create': {
      const name = text(e.after, 'name');
      return name ? `${who} created the roadmap "${name}".` : `${who} created the roadmap.`;
    }
    case 'roadmap.transfer':
      return `${who} transferred ownership to ${member(text(e.after, 'ownerId'))}.`;
    case 'invite.create': {
      const email = text(e.after, 'email') ?? 'someone';
      const r = role(e.after);
      return `${who} invited ${email} as ${r ?? 'a member'}.`;
    }
    case 'invite.accept': {
      const r = role(e.after);
      return r ? `${who} accepted an invite and joined as ${r}.` : `${who} accepted an invite and joined.`;
    }
    case 'invite.revoke':
      return `${who} revoked the invite for ${text(e.before, 'email') ?? 'someone'}.`;
    case 'member.role_change': {
      const from = role(e.before);
      const to = role(e.after);
      const base = `${who} changed ${member(e.target.id)}'s role`;
      return from && to ? `${base} from ${from} to ${to}.` : `${base}.`;
    }
    case 'member.remove':
      return `${who} removed ${member(e.target.id)} from the roadmap.`;
    case 'project.create':
      return `${who} added ${item(e.after)}.`;
    case 'project.update':
      return `${who} changed ${item(e.after)}.`;
    case 'project.delete':
      // The item is gone, so its name comes from what was stored before.
      return `${who} deleted ${item(e.before)}.`;
    case 'project.archive':
      return `${who} archived ${item(e.after)}.`;
    case 'project.unarchive':
      return `${who} unarchived ${item(e.after)}.`;
    case 'project.assign':
      return `${who} changed who is assigned to ${item(e.after)}.`;
    case 'project.reorder': {
      const parent = text(e.after, 'parentTitle');
      return parent ? `${who} reordered the items under ${parent}.` : `${who} reordered the projects.`;
    }
    case 'project.priority_label': {
      const label = text(e.after, 'priorityLabel');
      return label ? `${who} set the priority label of ${item(e.after)} to ${label}.` : `${who} removed the priority label of ${item(e.after)}.`;
    }
    case 'note.create':
      return `${who} added a note.`;
    case 'note.update':
      return `${who} edited a note.`;
    case 'note.delete':
      return `${who} deleted a note.`;
    case 'attachment.create':
      return `${who} added a file.`;
    case 'attachment.delete':
      return `${who} removed a file.`;
    case 'attachment.rejected':
      return `${who} tried to add a file that failed the virus check.`;
    case 'snapshot.create':
      return `${who} created a snapshot.`;
    case 'snapshot.revoke':
      return `${who} revoked a snapshot.`;
    case 'snapshot.access':
      return 'A snapshot was opened.';
    case 'snapshot.locked':
      return 'A snapshot link was locked after too many wrong passwords.';
    case 'user.notification_prefs':
      return `${who} changed their email notification settings.`;
    case 'user.unsubscribed':
      return `${who} turned off their notification emails from an email link.`;
    case 'user.calendar_feed':
      return `${who} changed their calendar feed.`;
    default:
      return `${who} made a change: ${e.action}.`;
  }
}
