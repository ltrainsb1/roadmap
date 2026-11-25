import { NOTIFICATION_TYPES, type EmailMode, type NotificationPrefs, type NotificationType } from '@roadmap/shared';
import { useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { SETTINGS_LOAD_FAILED } from '../api/errors.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { Layout } from '../ui/Layout.tsx';
import { useLeaveGuard } from '../ui/useLeaveGuard.tsx';
import { SettingsTabs } from './SettingsTabs.tsx';
import { useNotificationPrefs, useResumeEmails, useSaveNotificationPrefs } from './useNotificationPrefs.ts';

/** In the order the page shows them. */
const ROWS: ReadonlyArray<{ type: NotificationType; name: string; description: string }> = [
  { type: 'assigned', name: 'Assigned to you', description: 'Someone adds you to an item.' },
  { type: 'mentioned', name: 'Mentions', description: 'Someone mentions you in a note.' },
  {
    type: 'dates_changed',
    name: 'Dates changed on your items',
    description: "Someone changes the dates or milestones of an item you're assigned to.",
  },
  {
    type: 'due_soon',
    name: 'Due soon',
    description: "An end date or milestone of an item you're assigned to is 3 days away.",
  },
];

const CHOICES: ReadonlyArray<{ mode: EmailMode; label: string }> = [
  { mode: 'instant', label: 'Instantly' },
  { mode: 'digest', label: 'Daily digest' },
  { mode: 'off', label: 'Off' },
];

const RESUME_FAILED = "Couldn't turn emails back on. Try again.";
const SAVE_FAILED = "Couldn't save your settings. Try again.";

const WIDE = '(min-width: 600px)';
const subscribeWide = (onChange: () => void) => {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const list = window.matchMedia(WIDE);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
};
/** Whether the window is 600 px or wider; a browser that cannot tell gets the table. */
const isWide = () => typeof window.matchMedia !== 'function' || window.matchMedia(WIDE).matches;

interface RowsProps {
  values: NotificationPrefs;
  onChoose: (type: NotificationType, mode: EmailMode) => void;
}

/** 600 px and wider: one row per kind, its three choices under the column headings, one radio group per row. */
function PrefsTable({ values, onChoose }: RowsProps) {
  const id = useId();
  return (
    <table className="prefs-table">
      <thead>
        <tr>
          <th scope="col">Notification</th>
          {CHOICES.map((c) => (
            <th scope="col" key={c.mode} className="pref-column">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((r) => (
          <tr key={r.type}>
            <th scope="row">
              <span id={`${id}-${r.type}-name`} className="pref-name">
                {r.name}
              </span>
              <span id={`${id}-${r.type}-description`} className="pref-description">
                {r.description}
              </span>
            </th>
            <td colSpan={CHOICES.length}>
              <div
                role="radiogroup"
                aria-labelledby={`${id}-${r.type}-name`}
                aria-describedby={`${id}-${r.type}-description`}
                className="pref-choices"
              >
                {CHOICES.map((c) => (
                  <label key={c.mode} className="pref-choice">
                    <input
                      type="radio"
                      name={r.type}
                      value={c.mode}
                      checked={values[r.type] === c.mode}
                      onChange={() => onChoose(r.type, c.mode)}
                    />
                    <span className="sr-only">{c.label}</span>
                  </label>
                ))}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Below 600 px: each kind is a fieldset with its choices stacked and labelled. */
function PrefsFieldsets({ values, onChoose }: RowsProps) {
  const id = useId();
  return ROWS.map((r) => (
    <fieldset
      key={r.type}
      role="radiogroup"
      aria-labelledby={`${id}-${r.type}-name`}
      aria-describedby={`${id}-${r.type}-description`}
      className="pref-fieldset"
    >
      <legend id={`${id}-${r.type}-name`} className="pref-name">
        {r.name}
      </legend>
      <p id={`${id}-${r.type}-description`} className="pref-description">
        {r.description}
      </p>
      {CHOICES.map((c) => (
        <label key={c.mode} className="check">
          <input type="radio" name={r.type} value={c.mode} checked={values[r.type] === c.mode} onChange={() => onChoose(r.type, c.mode)} />
          <span>{c.label}</span>
        </label>
      ))}
    </fieldset>
  ));
}

/**
 * The form starts from the saved settings and is not touched by later refetches, so nothing chosen is lost. Save sends
 * all four; a second press while one is on its way sends nothing more.
 */
function PrefsForm({ saved, timezone }: { saved: NotificationPrefs; timezone: string }) {
  const save = useSaveNotificationPrefs();
  const [values, setValues] = useState(saved);
  // What the form was last started or saved from, to tell whether anything is unsaved.
  const [base, setBase] = useState(saved);
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle');
  const sending = useRef(false);
  const wide = useSyncExternalStore(subscribeWide, isWide);
  const dirty = NOTIFICATION_TYPES.some((t) => values[t] !== base[t]);
  const leaveDialog = useLeaveGuard(dirty);

  const onChoose = (type: NotificationType, mode: EmailMode) => {
    setValues((v) => ({ ...v, [type]: mode }));
    setStatus((s) => (s === 'saved' ? 'idle' : s));
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (sending.current) return;
    sending.current = true;
    setStatus('idle');
    save.mutate(values, {
      onSuccess: (data) => {
        setBase(data.prefs);
        setStatus('saved');
      },
      onError: () => setStatus('failed'),
      onSettled: () => {
        sending.current = false;
      },
    });
  };

  return (
    <>
      <form onSubmit={onSubmit} noValidate className="prefs-form">
        {wide ? <PrefsTable values={values} onChoose={onChoose} /> : <PrefsFieldsets values={values} onChoose={onChoose} />}
        <p className="digest-line">The daily digest arrives at 8 am in your time zone ({timezone}), on days with something in it.</p>
        {status === 'failed' && <Alert>{SAVE_FAILED}</Alert>}
        <Button type="submit" variant="primary">
          Save changes
        </Button>
        <div role="status" className="saved">
          {/* A choice made while the save was on its way is not in it, so the screen is not what was saved. */}
          {status === 'saved' && !dirty ? 'Saved.' : ''}
        </div>
      </form>
      {/* Outside the form: the dialog has a form of its own. */}
      {leaveDialog}
    </>
  );
}

/** SES reported a bounce or a spam complaint, so the worker stopped sending. The button asks for them again. */
function BlockedNotice({ blocked, onResumed }: { blocked: { reason: 'bounced' | 'complained'; email: string }; onResumed: () => void }) {
  const resume = useResumeEmails();
  const [failed, setFailed] = useState(false);
  const sending = useRef(false);
  const onClick = () => {
    if (sending.current) return;
    sending.current = true;
    setFailed(false);
    resume.mutate(undefined, {
      onSuccess: onResumed,
      onError: () => setFailed(true),
      onSettled: () => {
        sending.current = false;
      },
    });
  };
  return (
    <div className="alert alert-info">
      <p>
        {blocked.reason === 'bounced'
          ? `Emails to ${blocked.email} bounced, so we stopped sending them.`
          : 'One of our emails was marked as spam, so we stopped sending them.'}
      </p>
      {failed && <Alert>{RESUME_FAILED}</Alert>}
      <Button onClick={onClick}>Send emails again</Button>
    </div>
  );
}

export function NotificationSettingsPage() {
  const prefs = useNotificationPrefs();
  const [resumed, setResumed] = useState(false);
  return (
    <Layout width="wide" signedIn>
      <SettingsTabs current="notifications" />
      <h1>Email notifications</h1>
      <p>Choose how you hear about each kind of notification. Every notification also appears in the app.</p>
      {prefs.isPending && <p role="status">Loading</p>}
      {resumed && <Alert tone="success">Emails are on again.</Alert>}
      {prefs.data?.emailBlocked && <BlockedNotice blocked={prefs.data.emailBlocked} onResumed={() => setResumed(true)} />}
      {prefs.data ? (
        <PrefsForm saved={prefs.data.prefs} timezone={prefs.data.timezone} />
      ) : (
        prefs.isError && (
          <>
            <Alert>{SETTINGS_LOAD_FAILED}</Alert>
            <Button onClick={() => void prefs.refetch()}>Try again</Button>
          </>
        )
      )}
    </Layout>
  );
}
