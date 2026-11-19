import { useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';
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
import { RecoveryCodes } from './RecoveryCodes.tsx';
import { ME_KEY } from './useMe.ts';

interface Pending {
  secret: string;
  qr: string;
}

export function EnrollTotpPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const next = useNext();
  const form = useRef<HTMLFormElement>(null);
  const started = useRef(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [errors, setErrors] = useState<FormErrors | null>(null);
  const [expired, setExpired] = useState(false);
  useFocusFirstError(form, errors);

  // Starting replaces the pending secret, so it must run once even when React mounts the page twice.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const res = await api<{ secret: string; otpauthUrl: string }>('/api/auth/totp/enroll/start', { method: 'POST' });
        setPending({ secret: res.secret, qr: await QRCode.toDataURL(res.otpauthUrl, { width: 192, margin: 1 }) });
      } catch (err) {
        setExpired(errorCode(err) === 'unauthenticated');
        setErrors({ form: messageFor(err), fields: {} });
      }
    })();
  }, []);

  const onConfirm = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = formText(new FormData(e.currentTarget), 'code').trim();
    if (!code) return setErrors({ fields: { code: 'Enter the 6-digit code from your app.' } });
    try {
      const res = await api<{ recoveryCodes: string[] }>('/api/auth/totp/enroll/confirm', {
        method: 'POST',
        body: { code },
      });
      setErrors(null);
      setRecoveryCodes(res.recoveryCodes);
    } catch (err) {
      const message = messageFor(err);
      setErrors(errorCode(err) === 'invalid_code' ? { fields: { code: message } } : { form: message, fields: {} });
    }
  };

  const onContinue = async () => {
    await queryClient.invalidateQueries({ queryKey: ME_KEY });
    void navigate(next);
  };

  if (recoveryCodes) {
    return (
      <Layout>
        <h1>Save your recovery codes</h1>
        <RecoveryCodes codes={recoveryCodes} submitLabel="Continue" onDone={onContinue} />
      </Layout>
    );
  }

  return (
    <Layout>
      <h1>Set up your authenticator app</h1>
      {errors?.form && <Alert>{errors.form}</Alert>}
      {expired && (
        <Link to="/login" className="text-link">
          Back to sign in
        </Link>
      )}
      {pending && (
        <>
          <img className="qr" src={pending.qr} width="192" height="192" alt="QR code to scan with your authenticator app" />
          <p>Can't scan? Enter this key:</p>
          <p>
            <code className="secret" data-testid="totp-secret">
              {pending.secret}
            </code>
          </p>
          <form ref={form} onSubmit={(e) => void onConfirm(e)} noValidate>
            <Field
              id="code"
              name="code"
              label="6-digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              error={errors?.fields.code}
            />
            <Button type="submit" variant="primary" className="btn-block">
              Turn on
            </Button>
          </form>
        </>
      )}
    </Layout>
  );
}
