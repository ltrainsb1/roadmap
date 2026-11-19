import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client.ts';
import { errorCode, messageFor } from '../api/errors.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { formText } from '../ui/formText.ts';
import { Layout } from '../ui/Layout.tsx';
import { useFocusFirstError, type FormErrors } from '../ui/useFocusFirstError.ts';
import { useNext } from './next.ts';
import { passkeyErrorMessage, signInWithPasskey } from './passkey.ts';
import { ME_KEY } from './useMe.ts';

export function MfaPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const next = useNext();
  const form = useRef<HTMLFormElement>(null);
  const [recovery, setRecovery] = useState(false);
  const [errors, setErrors] = useState<FormErrors | null>(null);
  const [expired, setExpired] = useState(false);
  useFocusFirstError(form, errors);

  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: ME_KEY });
    void navigate(next);
  };

  const fail = (err: unknown, asField?: string) => {
    const code = errorCode(err);
    setExpired(code === 'unauthenticated');
    const message = messageFor(err, { recovery });
    // A wrong code belongs to the code field; everything else is about the whole form.
    setErrors(asField && code === 'invalid_code' ? { fields: { [asField]: message } } : { form: message, fields: {} });
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = formText(new FormData(e.currentTarget), 'code').trim();
    if (!code) {
      return setErrors({
        fields: { code: recovery ? 'Enter a recovery code.' : 'Enter the 6-digit code from your app.' },
      });
    }
    try {
      await api(recovery ? '/api/auth/mfa/recovery' : '/api/auth/mfa/totp', { method: 'POST', body: { code } });
      await done();
    } catch (err) {
      fail(err, 'code');
    }
  };

  const onPasskey = async () => {
    try {
      await signInWithPasskey();
      await done();
    } catch (err) {
      setExpired(errorCode(err) === 'unauthenticated');
      setErrors({ form: passkeyErrorMessage(err), fields: {} });
    }
  };

  return (
    <Layout>
      <h1>{recovery ? 'Enter a recovery code' : 'Enter your 6-digit code'}</h1>
      {errors?.form && <Alert>{errors.form}</Alert>}
      {expired && (
        <Link to="/login" className="text-link">
          Back to sign in
        </Link>
      )}
      <form ref={form} onSubmit={(e) => void onSubmit(e)} noValidate>
        {recovery ? (
          <Field
            key="recovery"
            id="code"
            name="code"
            label="Recovery code"
            hint="Each recovery code works once."
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            error={errors?.fields.code}
          />
        ) : (
          <Field
            key="totp"
            id="code"
            name="code"
            label="Code from your authenticator app"
            inputMode="numeric"
            autoComplete="one-time-code"
            error={errors?.fields.code}
          />
        )}
        <Button type="submit" variant="primary" className="btn-block">
          Verify
        </Button>
      </form>
      <div className="link-row">
        <Button
          variant="link"
          onClick={() => {
            setRecovery(!recovery);
            setErrors(null);
          }}
        >
          {recovery ? 'Use your authenticator app' : 'Use a recovery code'}
        </Button>
        <Button variant="link" onClick={() => void onPasskey()}>
          Use a passkey
        </Button>
      </div>
    </Layout>
  );
}
