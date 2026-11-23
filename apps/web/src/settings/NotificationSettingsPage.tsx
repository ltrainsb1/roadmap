import { NOTIFICATION_TYPES, type EmailMode, type NotificationPrefs, type NotificationType } from '@roadmap/shared';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { SETTINGS_LOAD_FAILED } from '../api/errors.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { isPlainClick } from '../ui/isPlainClick.ts';
import { Layout } from '../ui/Layout.tsx';
import { useNotificationPrefs, useSaveNotificationPrefs } from './useNotificationPrefs.ts';

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

/**
 * While `dirty`, a plain click on a link within the app waits for the person to agree to discard, and leaving the site
 * (reload, close, another address) asks the browser's own question. The app's router has no navigation blocking (it is
 * not a data router), so links are caught here before React Router's own handler sees them.
 */
function useLeaveGuard(dirty: boolean) {
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || !isPlainClick(e) || !(e.target instanceof Element)) return;
      const link = e.target.closest('a[href]');
      if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
      const to = new URL(link.href);
      if (to.origin !== window.location.origin) return;
      // Link sees the click as handled and leaves it; the person answers the question first.
      e.preventDefault();
      setPending(to.pathname + to.search + to.hash);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title="Discard your unsaved changes?"
      confirmLabel="Discard"
      cancelLabel="Keep editing"
      onConfirm={() => {
        const to = pending;
        setPending(null);
        if (to !== null) void navigate(to);
      }}
      onClose={() => setPending(null)}
    >
      {null}
    </ConfirmDialog>
  );
  return dialog;
}

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

export function NotificationSettingsPage() {
  const prefs = useNotificationPrefs();
  return (
    <Layout width="wide" signedIn>
      <h1>Email notifications</h1>
      <p>Choose how you hear about each kind of notification. Every notification also appears in the app.</p>
      {prefs.isPending && <p role="status">Loading</p>}
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
