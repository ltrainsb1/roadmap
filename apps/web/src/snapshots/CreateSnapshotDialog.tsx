import { SNAPSHOT_LIMITS } from '@roadmap/shared';
import { useEffect, useRef, useState } from 'react';
import { errorCode, errorMessage, messageFor } from '../api/errors.ts';
import { todayIn } from '../projects/today.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { Field } from '../ui/Field.tsx';
import { COPY_FAILED, LINK_COPIED, useCopyLink } from '../ui/useCopyLink.ts';
import { useFocusFirstError } from '../ui/useFocusFirstError.ts';
import { endOfLocalDay, snapshotUrl, useCreateSnapshot } from './useSnapshots.ts';

const DAY_MS = 86_400_000;

type FieldName = 'name' | 'asOf' | 'password' | 'expiry';
type Errors = Partial<Record<FieldName, string>>;

/** The calendar date it is in the browser's own zone. */
const localToday = () => todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);

/** The day after a `YYYY-MM-DD` date. */
const nextDay = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** The server's refusals that belong under one field. */
const FIELD_CODES: Record<string, FieldName> = { as_of_in_future: 'asOf', expiry_in_past: 'expiry', expiry_too_far: 'expiry' };

export function CreateSnapshotDialog({ roadmapId, open, onClose }: { roadmapId: string; open: boolean; onClose: () => void }) {
  const create = useCreateSnapshot(roadmapId);
  const [today, setToday] = useState(localToday);
  const [name, setName] = useState('');
  const [asOf, setAsOf] = useState(today);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [expires, setExpires] = useState<'never' | 'date'>('never');
  const [expiryDate, setExpiryDate] = useState('');
  const [notes, setNotes] = useState(false);
  const [assignees, setAssignees] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [failedAt, setFailedAt] = useState(0);
  const [linkId, setLinkId] = useState<string | null>(null);
  const copyLink = useCopyLink();
  // Each opening is dated by the clock at that moment, so a page left open past midnight offers the new day.
  const [openSeen, setOpenSeen] = useState(open);
  if (open !== openSeen) {
    setOpenSeen(open);
    if (open) {
      const now = localToday();
      setToday(now);
      setAsOf(now);
    }
  }
  const busy = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);

  useFocusFirstError(body, failedAt);
  useEffect(() => {
    if (linkId) title.current?.focus();
  }, [linkId]);

  // Closing clears the form, so the next opening starts blank and the password is gone, from the mutation's record too.
  const close = () => {
    setName('');
    setPassword('');
    setShowPassword(false);
    setExpires('never');
    setExpiryDate('');
    setNotes(false);
    setAssignees(false);
    setErrors({});
    setFormError(undefined);
    setLinkId(null);
    copyLink.reset();
    create.reset();
    onClose();
  };

  const fail = (next: Errors, form?: string) => {
    setErrors(next);
    setFormError(form);
    setFailedAt((n) => n + 1);
  };

  const submit = async () => {
    // A second press while the first is on its way would make a second snapshot. A ref, not `isPending`: the
    // mutation's state reaches the render only after a tick, and a double press is quicker.
    if (busy.current) return;
    const found: Errors = {};
    if (!name.trim()) found.name = 'Enter a name.';
    if (password.length < SNAPSHOT_LIMITS.passwordMin) found.password = 'Use at least 10 characters.';
    if (!asOf || asOf > today) found.asOf = errorMessage('as_of_in_future');
    const expiresAt = expires === 'date' && expiryDate ? endOfLocalDay(expiryDate) : null;
    if (expires === 'date') {
      if (!expiryDate || expiryDate <= today) found.expiry = errorMessage('expiry_in_past');
      else if (Date.parse(expiresAt!) - Date.now() > SNAPSHOT_LIMITS.maxExpiryDays * DAY_MS) found.expiry = errorMessage('expiry_too_far');
    }
    if (Object.keys(found).length > 0) return fail(found);

    busy.current = true;
    try {
      const created = await create.mutateAsync({ name: name.trim(), asOf, password, expiresAt, include: { notes, assignees } });
      setErrors({});
      setFormError(undefined);
      setPassword('');
      setLinkId(created.linkId);
    } catch (err) {
      const fieldName = FIELD_CODES[errorCode(err)];
      if (fieldName) fail({ [fieldName]: messageFor(err) });
      else fail({}, messageFor(err));
    } finally {
      // The mutation keeps what it sent, password included; the form's own state is all a retry needs.
      create.reset();
      busy.current = false;
    }
  };

  if (linkId) {
    const url = snapshotUrl(linkId);
    return (
      <ConfirmDialog
        open={open}
        title="Snapshot created"
        // Only this state's heading takes focus; the form's opening focuses its first field.
        titleRef={title}
        confirmLabel="Done"
        informOnly
        cancelLabel="Done"
        onConfirm={close}
        onClose={close}
      >
        <p>Send this link to the people who should see it. Send the password separately.</p>
        <Field id="snapshot-link" label="Link" value={url} readOnly onFocus={(e) => e.currentTarget.select()} />
        {copyLink.result === 'failed' && <Alert>{COPY_FAILED}</Alert>}
        <p role="status" className="notice">
          {copyLink.result === 'copied' ? LINK_COPIED : ''}
        </p>
        <div className="dialog-extra">
          <Button onClick={() => void copyLink.copy(url)}>Copy link</Button>
        </div>
      </ConfirmDialog>
    );
  }

  return (
    <ConfirmDialog
      open={open}
      title="Create a snapshot"
      confirmLabel="Create snapshot"
      danger={false}
      error={formError}
      onConfirm={() => void submit()}
      onClose={close}
    >
      <div ref={body}>
        <Field
          id="snapshot-name"
          label="Name"
          hint="Only your team sees this name."
          value={name}
          maxLength={SNAPSHOT_LIMITS.name}
          autoComplete="off"
          error={errors.name}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          id="snapshot-as-of"
          label="As of"
          hint="The date shown at the top. The snapshot holds the roadmap as it is right now."
          type="date"
          value={asOf}
          max={today}
          error={errors.asOf}
          onChange={(e) => setAsOf(e.target.value)}
        />
        <Field
          id="snapshot-password"
          label="Password"
          hint="At least 10 characters. Send it separately from the link."
          type={showPassword ? 'text' : 'password'}
          value={password}
          maxLength={SNAPSHOT_LIMITS.passwordMax}
          autoComplete="off"
          error={errors.password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="check">
          <input id="snapshot-show-password" type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} />
          <label htmlFor="snapshot-show-password">Show password</label>
        </div>

        <fieldset className="panel-group">
          <legend>Link expires</legend>
          <div className="check">
            <input
              id="snapshot-expires-never"
              type="radio"
              name="snapshot-expires"
              checked={expires === 'never'}
              onChange={() => setExpires('never')}
            />
            <label htmlFor="snapshot-expires-never">Never</label>
          </div>
          <div className="check">
            <input
              id="snapshot-expires-date"
              type="radio"
              name="snapshot-expires"
              checked={expires === 'date'}
              onChange={() => setExpires('date')}
            />
            <label htmlFor="snapshot-expires-date">On a date</label>
          </div>
          {expires === 'date' && (
            <Field
              id="snapshot-expiry-date"
              label="Expiry date"
              hint="The link stops working at the end of this day."
              type="date"
              value={expiryDate}
              min={nextDay(today)}
              error={errors.expiry}
              onChange={(e) => setExpiryDate(e.target.value)}
            />
          )}
        </fieldset>

        <fieldset className="panel-group">
          <legend>Include</legend>
          <div className="check">
            <input
              id="snapshot-include-notes"
              type="checkbox"
              checked={notes}
              aria-describedby="snapshot-include-notes-hint"
              onChange={(e) => setNotes(e.target.checked)}
            />
            <label htmlFor="snapshot-include-notes">Notes</label>
          </div>
          <p id="snapshot-include-notes-hint" className="hint check-hint">
            Notes are shown with their authors' names. Files are never included.
          </p>
          <div className="check">
            <input id="snapshot-include-assignees" type="checkbox" checked={assignees} onChange={(e) => setAssignees(e.target.checked)} />
            <label htmlFor="snapshot-include-assignees">Assignee names</label>
          </div>
        </fieldset>
      </div>
    </ConfirmDialog>
  );
}
