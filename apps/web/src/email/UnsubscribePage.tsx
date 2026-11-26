import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client.ts';
import { messageFor } from '../api/errors.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { Layout } from '../ui/Layout.tsx';

const SETTINGS = '/settings/notifications';

const settingsLink = (
  <Link to={SETTINGS} className="text-link">
    notification settings
  </Link>
);

/** The link from an email's footer: opening it changes nothing, the button does (a mail scanner may open links). */
export function UnsubscribePage() {
  const token = useSearchParams()[0].get('t') ?? '';
  const [state, setState] = useState<'ready' | 'done' | 'bad' | { failed: string }>('ready');

  const turnOff = async () => {
    try {
      // Public route: no session, no CSRF token. Quiet, so nothing here ever sends anyone to sign in.
      await api(`/api/email/unsubscribe?t=${encodeURIComponent(token)}`, { method: 'POST', quiet: true });
      setState('done');
    } catch (err) {
      setState(err instanceof ApiError && err.status === 404 ? 'bad' : { failed: messageFor(err) });
    }
  };

  const bad = token === '' || state === 'bad';
  return (
    <Layout>
      <h1>Turn off notification emails</h1>
      {bad ? (
        <Alert>This link doesn't work. You can change your emails in your {settingsLink}.</Alert>
      ) : state === 'done' ? (
        <Alert tone="success">Emails are off. You can turn them back on in your {settingsLink}.</Alert>
      ) : (
        <>
          <p>This turns off every notification email. You'll still see notifications in the app.</p>
          {typeof state === 'object' && <Alert>{state.failed}</Alert>}
          <Button variant="primary" onClick={() => void turnOff()}>
            Turn off emails
          </Button>
        </>
      )}
    </Layout>
  );
}
