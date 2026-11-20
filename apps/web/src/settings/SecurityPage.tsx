import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.ts';
import { messageFor } from '../api/errors.ts';
import { passkeyErrorMessage } from '../auth/passkey.ts';
import { RecoveryCodes } from '../auth/RecoveryCodes.tsx';
import { signOut } from '../auth/signOut.ts';
import { ME_KEY, useMe } from '../auth/useMe.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { Field } from '../ui/Field.tsx';
import { formText } from '../ui/formText.ts';
import { Layout } from '../ui/Layout.tsx';

type Passkey = { id: string; name: string; createdAt: string };

const dateOf = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));

// Changing a factor needs the authenticator app's code, or a recovery code when the app is lost.
const STEP_UP_LABEL = '6-digit code or recovery code';
const STEP_UP_HINT = 'Use a recovery code if you lost your authenticator app.';
const EMPTY_CODE = 'Enter the 6-digit code from your authenticator app.';
/** The server tells the two apart by shape, so the error copy does too. */
const stepUpMessage = (err: unknown, code: string) => messageFor(err, { recovery: !/^\d{6}$/.test(code) });

export function SecurityPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [passkeyError, setPasskeyError] = useState<string | undefined>();
  const [askingPasskeyCode, setAskingPasskeyCode] = useState(false);
  const [passkeyCodeError, setPasskeyCodeError] = useState<string | undefined>();
  const passkeyCodeInput = useRef<HTMLInputElement>(null);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [removeError, setRemoveError] = useState<string | undefined>();
  const [codeError, setCodeError] = useState<string | undefined>();
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [sessionError, setSessionError] = useState<string | undefined>();
  const [signingOut, setSigningOut] = useState(false);
  const codeForm = useRef<HTMLFormElement>(null);

  const passkeys = me.data?.user.passkeys ?? [];
  const refreshMe = () => queryClient.invalidateQueries({ queryKey: ME_KEY });

  useEffect(() => {
    if (askingPasskeyCode) passkeyCodeInput.current?.focus();
  }, [askingPasskeyCode]);

  /** Runs the browser ceremony once the server has accepted the step-up code (if one was needed). */
  const registerPasskey = async (code: string | undefined) => {
    setPasskeyError(undefined);
    setPasskeyCodeError(undefined);
    let optionsJSON: PublicKeyCredentialCreationOptionsJSON;
    try {
      optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>('/api/auth/passkeys/register/options', {
        method: 'POST',
        ...(code === undefined ? {} : { body: { code } }),
      });
    } catch (err) {
      if (code !== undefined) return setPasskeyCodeError(stepUpMessage(err, code));
      return setPasskeyError(messageFor(err));
    }
    setAskingPasskeyCode(false);
    try {
      const response = await startRegistration({ optionsJSON });
      const name = `Passkey ${passkeys.length + 1}`;
      await api('/api/auth/passkeys/register/verify', { body: { response, name } });
      await refreshMe();
    } catch (err) {
      setPasskeyError(passkeyErrorMessage(err));
    }
  };

  const addPasskey = () => {
    if (me.data?.user.hasTotp) return setAskingPasskeyCode(true);
    void registerPasskey(undefined);
  };

  const submitPasskeyCode = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = formText(new FormData(e.currentTarget), 'code').trim();
    if (!code) return setPasskeyCodeError(EMPTY_CODE);
    void registerPasskey(code);
  };

  const removePasskey = async () => {
    if (!removing) return;
    try {
      await api(`/api/auth/passkeys/${encodeURIComponent(removing.id)}`, { method: 'DELETE' });
      setRemoving(null);
      setRemoveError(undefined);
      await refreshMe();
    } catch (err) {
      setRemoveError(messageFor(err));
    }
  };

  const makeCodes = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = formText(new FormData(e.currentTarget), 'code').trim();
    if (!code) return setCodeError(EMPTY_CODE);
    try {
      const res = await api<{ recoveryCodes: string[] }>('/api/auth/recovery-codes', { body: { code } });
      setCodeError(undefined);
      setNewCodes(res.recoveryCodes);
    } catch (err) {
      setCodeError(stepUpMessage(err, code));
    }
  };

  const signOutEverywhere = async () => {
    try {
      await signOut(queryClient, true);
      void navigate('/login');
    } catch (err) {
      setSessionError(messageFor(err));
    }
  };

  return (
    <Layout width="wide" signedIn>
      <h1>Security</h1>

      <section aria-labelledby="passkeys-heading">
        <h2 id="passkeys-heading">Passkeys</h2>
        {passkeyError && <Alert>{passkeyError}</Alert>}
        {passkeys.length === 0 ? (
          <p>You have no passkeys yet.</p>
        ) : (
          <ul className="passkey-list" aria-label="Passkeys">
            {passkeys.map((p) => (
              <li key={p.id}>
                <span>
                  {p.name}, added {dateOf(p.createdAt)}
                </span>
                <Button variant="danger" aria-label={`Remove passkey ${p.name}`} onClick={() => setRemoving(p)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {askingPasskeyCode ? (
          <form onSubmit={submitPasskeyCode} noValidate>
            <Field
              id="passkey-code"
              name="code"
              label={STEP_UP_LABEL}
              hint={STEP_UP_HINT}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              ref={passkeyCodeInput}
              error={passkeyCodeError}
            />
            <Button type="submit">Continue</Button>
          </form>
        ) : (
          <Button onClick={addPasskey}>Add a passkey</Button>
        )}
      </section>

      <section aria-labelledby="codes-heading">
        <h2 id="codes-heading">Recovery codes</h2>
        {newCodes ? (
          <>
            <h3>Save your recovery codes</h3>
            <RecoveryCodes
              codes={newCodes}
              submitLabel="Done"
              onDone={() => {
                setNewCodes(null);
              }}
            />
          </>
        ) : (
          <>
            <p>Your old codes stop working.</p>
            <form ref={codeForm} onSubmit={(e) => void makeCodes(e)} noValidate>
              <Field
                id="code"
                name="code"
                label={STEP_UP_LABEL}
                hint={STEP_UP_HINT}
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                error={codeError}
              />
              <Button type="submit">Make new codes</Button>
            </form>
          </>
        )}
      </section>

      <section aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">Sessions</h2>
        <Button variant="danger" onClick={() => setSigningOut(true)}>
          Sign out everywhere
        </Button>
      </section>

      <ConfirmDialog
        open={signingOut}
        title="Sign out everywhere"
        confirmLabel="Sign out everywhere"
        error={sessionError}
        onConfirm={() => void signOutEverywhere()}
        onClose={() => {
          setSigningOut(false);
          setSessionError(undefined);
        }}
      >
        <p>Sign out everywhere? This signs you out on every device, including this one.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={removing !== null}
        title="Remove passkey"
        confirmLabel="Remove"
        error={removeError}
        onConfirm={() => void removePasskey()}
        onClose={() => {
          setRemoving(null);
          setRemoveError(undefined);
        }}
      >
        <p>Remove {removing?.name}? You can't sign in with it afterwards.</p>
      </ConfirmDialog>
    </Layout>
  );
}
