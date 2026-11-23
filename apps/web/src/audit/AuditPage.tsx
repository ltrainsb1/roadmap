import { can, type AuditActionName, type AuditPage as AuditPageData, type MembersResponse } from '@roadmap/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../api/client.ts';
import { messageFor } from '../api/errors.ts';
import { useMe } from '../auth/useMe.ts';
import { useRoadmap } from '../roadmaps/RoadmapLayout.tsx';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { SelectField } from '../ui/SelectField.tsx';
import { dayRange, formatWhen } from './dates.ts';
import { describeAuditEvent } from './describe.ts';

/** The roadmap-level events this screen lists, with the words the Action filter shows. */
const ACTION_FILTERS: ReadonlyArray<[AuditActionName, string]> = [
  ['roadmap.create', 'Roadmap created'],
  ['roadmap.transfer', 'Ownership transferred'],
  ['invite.create', 'Invite sent'],
  ['invite.accept', 'Invite accepted'],
  ['invite.revoke', 'Invite revoked'],
  ['member.role_change', 'Role changed'],
  ['member.remove', 'Member removed'],
  ['project.create', 'Item added'],
  ['project.update', 'Item changed'],
  ['project.delete', 'Item deleted'],
  ['project.archive', 'Item archived'],
  ['project.unarchive', 'Item unarchived'],
  ['project.assign', 'Assignees changed'],
  ['project.reorder', 'Items reordered'],
  ['project.priority_label', 'Priority label changed'],
  ['note.create', 'Note added'],
  ['note.update', 'Note edited'],
  ['note.delete', 'Note deleted'],
  ['attachment.create', 'File added'],
  ['attachment.delete', 'File removed'],
  ['attachment.rejected', 'File blocked by the virus check'],
  ['snapshot.create', 'Snapshot created'],
  ['snapshot.revoke', 'Snapshot revoked'],
  ['snapshot.access', 'Snapshot opened'],
  ['snapshot.locked', 'Snapshot link locked'],
];

export function AuditPage() {
  const { roadmapId, role } = useRoadmap();
  const me = useMe();
  const timeZone = me.data?.user.timezone ?? 'UTC';
  const allowed = can({ role, action: 'audit.view' });
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (action) q.set('action', action);
    if (from) q.set('from', dayRange(from, timeZone).from);
    if (to) q.set('to', dayRange(to, timeZone).to);
    return q;
  }, [action, from, to, timeZone]);

  const base = `/api/roadmaps/${encodeURIComponent(roadmapId)}`;
  const log = useInfiniteQuery({
    queryKey: ['audit', roadmapId, query.toString()],
    enabled: allowed,
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams(query);
      if (pageParam) q.set('cursor', pageParam);
      return api<AuditPageData>(`${base}/audit?${q.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  // Names for the people an event is about; a removed member has none and reads as a former member.
  const members = useQuery({ queryKey: ['members', roadmapId], queryFn: () => api<MembersResponse>(`${base}/members`), enabled: allowed });
  const names = useMemo(() => new Map(members.data?.members.map((m) => [m.userId, m.name])), [members.data]);

  if (!allowed) {
    return (
      <>
        <h1>Audit log</h1>
        <Alert>Only Owners and Admins can see the audit log.</Alert>
      </>
    );
  }

  const events = log.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <h1>Audit log</h1>
      <form className="filters" onSubmit={(e) => e.preventDefault()} noValidate>
        <SelectField id="audit-action" label="Action" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          {ACTION_FILTERS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        <Field id="audit-from" label="From" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        <Field id="audit-to" label="To" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
      </form>

      {log.isError && <Alert>{messageFor(log.error)}</Alert>}
      {log.isSuccess && events.length === 0 && <p>No events in this range.</p>}
      {events.length > 0 && (
        <ol className="audit-list" aria-label="Events">
          {events.map((e) => (
            <li key={e.id}>
              <time dateTime={e.timestamp}>{formatWhen(e.timestamp, timeZone)}</time>
              <span>{describeAuditEvent(e, (id) => names.get(id))}</span>
            </li>
          ))}
        </ol>
      )}
      {log.hasNextPage && (
        <Button variant="primary" onClick={() => void log.fetchNextPage()}>
          Load more
        </Button>
      )}
    </>
  );
}
