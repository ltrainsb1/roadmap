import { can, snapshotState, type SnapshotSummary } from '@roadmap/shared';
import { useEffect, useRef, useState } from 'react';
import { messageFor } from '../api/errors.ts';
import { useMe } from '../auth/useMe.ts';
import { focusRemaining } from '../projects/focusAfterRemove.ts';
import { formatDay } from '../projects/names.ts';
import { todayIn } from '../projects/today.ts';
import { useRoadmap } from '../roadmaps/RoadmapLayout.tsx';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { Field } from '../ui/Field.tsx';
import { CreateSnapshotDialog, useCopyLink } from './CreateSnapshotDialog.tsx';
import { snapshotUrl, useRevokeSnapshot, useSnapshots } from './useSnapshots.ts';

const CREATE_ID = 'create-snapshot';
const COPY_LIST = 'snapshot-copy';

/** An instant as the calendar day it falls on in `timeZone`: "12 Mar 2027". */
const dayOf = (iso: string, timeZone: string) => formatDay(todayIn(timeZone, new Date(iso)));

/** The browser's own zone: the one an expiry instant was built in, so it reads back as the day picked. */
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** An instant as a time of day in `timeZone`: "14:05". */
function timeOf(iso: string, timeZone: string): string {
  const options = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(new Date(iso));
  } catch (error) {
    if (error instanceof RangeError) return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(new Date(iso));
    throw error;
  }
}

function badgeText(s: SnapshotSummary, now: Date, timeZone: string): string {
  if (snapshotState(s, now) === 'expired') return 'Expired';
  if (s.lockedUntil && Date.parse(s.lockedUntil) > now.getTime()) return `Locked until ${timeOf(s.lockedUntil, timeZone)}`;
  return 'Active';
}

function openedLine(s: SnapshotSummary, timeZone: string): string {
  if (s.openCount === 0 || !s.lastOpenedAt) return 'Not opened yet';
  const day = dayOf(s.lastOpenedAt, timeZone);
  return s.openCount === 1 ? `Opened once, on ${day}` : `Opened ${s.openCount} times, last on ${day}`;
}

function showsLine({ include }: SnapshotSummary): string | null {
  if (include.notes && include.assignees) return 'Shows notes and assignee names.';
  if (include.notes) return 'Shows notes.';
  if (include.assignees) return 'Shows assignee names.';
  return null;
}

function SnapshotCard({ snapshot: s, now, timeZone, onRevoke }: { snapshot: SnapshotSummary; now: Date; timeZone: string; onRevoke: () => void }) {
  const copyLink = useCopyLink();
  const url = snapshotUrl(s.linkId);
  const shows = showsLine(s);
  return (
    <li className="snapshot-card">
      <div className="snapshot-head">
        <h2>{s.name}</h2>
        <span className="badge">{badgeText(s, now, timeZone)}</span>
      </div>
      <ul className="snapshot-facts">
        <li>As of {formatDay(s.asOf)}</li>
        <li>
          Created by {s.createdByName ?? 'a former member'} on {dayOf(s.createdAt, timeZone)}
        </li>
        <li>{s.expiresAt ? `Expires ${dayOf(s.expiresAt, browserZone())}` : 'No expiry'}</li>
        <li>{openedLine(s, timeZone)}</li>
        {shows && <li>{shows}</li>}
      </ul>
      {copyLink.result === 'failed' && (
        <>
          <Alert>Couldn't copy the link. Select it and copy it yourself.</Alert>
          <Field id={`snapshot-link-${s.id}`} label="Link" value={url} readOnly onFocus={(e) => e.currentTarget.select()} />
        </>
      )}
      <p role="status" className="notice">
        {copyLink.result === 'copied' ? 'Link copied.' : ''}
      </p>
      <div className="snapshot-actions">
        <Button data-list={COPY_LIST} aria-label={`Copy link to ${s.name}`} onClick={() => void copyLink.copy(url)}>
          Copy link
        </Button>
        <a className="btn btn-secondary" href={`/s/${s.linkId}`} target="_blank" rel="noopener noreferrer" aria-label={`Open ${s.name}`}>
          Open
        </a>
        <Button variant="danger" aria-label={`Revoke ${s.name}`} onClick={onRevoke}>
          Revoke
        </Button>
      </div>
    </li>
  );
}

function SnapshotList({ roadmapId, timeZone }: { roadmapId: string; timeZone: string }) {
  const snapshots = useSnapshots(roadmapId);
  const revoke = useRevokeSnapshot(roadmapId);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<{ snapshot: SnapshotSummary; index: number } | null>(null);
  const [dialogError, setDialogError] = useState<string | undefined>();
  const [focusAt, setFocusAt] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const revokeBusy = useRef(false);

  // After a revoke, once the card is gone and the dialog has closed (its effect runs first), keep focus in the list.
  useEffect(() => {
    if (focusAt === null || !list.current) return;
    focusRemaining(list.current, COPY_LIST, focusAt, CREATE_ID);
    setFocusAt(null);
  }, [focusAt]);

  const closeRevoke = () => {
    setRevoking(null);
    setDialogError(undefined);
  };

  const confirmRevoke = async () => {
    // A second press while the first is on its way would come back "not found" and leave a stale error. A ref, not
    // `isPending`: the mutation's state reaches the render only after a tick, and a double press is quicker.
    if (!revoking || revokeBusy.current) return;
    revokeBusy.current = true;
    try {
      await revoke.mutateAsync(revoking.snapshot.id);
      closeRevoke();
      setFocusAt(revoking.index);
    } catch (err) {
      setDialogError(messageFor(err));
      void snapshots.refetch();
    } finally {
      revokeBusy.current = false;
    }
  };

  const now = new Date();
  const items = snapshots.data?.snapshots ?? [];
  return (
    <div ref={list}>
      <Button id={CREATE_ID} variant="primary" className="snapshot-create" onClick={() => setCreating(true)}>
        Create snapshot
      </Button>

      {snapshots.isError && (
        <div className="snapshot-error">
          <Alert>Couldn't load snapshots. Try again.</Alert>
          <Button onClick={() => void snapshots.refetch()}>Try again</Button>
        </div>
      )}
      {snapshots.isSuccess && items.length === 0 && <p>No snapshots yet.</p>}
      {items.length > 0 && (
        <ul className="snapshot-list" aria-label="Snapshots">
          {items.map((s, index) => (
            <SnapshotCard key={s.id} snapshot={s} now={now} timeZone={timeZone} onRevoke={() => {
                setDialogError(undefined);
                setRevoking({ snapshot: s, index });
              }} />
          ))}
        </ul>
      )}

      <CreateSnapshotDialog roadmapId={roadmapId} open={creating} onClose={() => setCreating(false)} />
      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke ${revoking?.snapshot.name ?? ''}?`}
        confirmLabel="Revoke snapshot"
        error={dialogError}
        onConfirm={() => void confirmRevoke()}
        onClose={closeRevoke}
      >
        <p>The link stops working for everyone and the snapshot is deleted. This can't be undone.</p>
      </ConfirmDialog>
    </div>
  );
}

export function SnapshotsPage() {
  const { roadmapId, role } = useRoadmap();
  const me = useMe();
  const timeZone = me.data?.user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const allowed = can({ role, action: 'snapshot.create' });
  return (
    <>
      <h1>Snapshots</h1>
      {allowed ? (
        <>
          <p>A snapshot is a frozen copy of this roadmap. People without an account open it with a link and a password.</p>
          <SnapshotList roadmapId={roadmapId} timeZone={timeZone} />
        </>
      ) : (
        <Alert>Only Owners and Admins can see snapshots.</Alert>
      )}
    </>
  );
}
