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
    default:
      return `${who} made a change: ${e.action}.`;
  }
}
