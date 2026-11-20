import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client.ts';
import { messageFor } from '../api/errors.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { formText } from '../ui/formText.ts';
import { Layout } from '../ui/Layout.tsx';
import { useFocusFirstError, type FormErrors } from '../ui/useFocusFirstError.ts';
import { useNext, withNext } from './next.ts';
import { ME_KEY } from './useMe.ts';
import { passkeyErrorMessage, signInWithPasskey } from './passkey.ts';

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const next = useNext();
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  const form = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<FormErrors | null>(null);
  useFocusFirstError(form, errors);

  const finish = async () => {
    await queryClient.invalidateQueries({ queryKey: ME_KEY });
    void navigate(next);
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const email = formText(data, 'email').trim();
    const password = formText(data, 'password');
    const fields: Record<string, string> = {};
    if (!email) fields.email = 'Enter your email.';
    if (!password) fields.password = 'Enter your password.';
    if (Object.keys(fields).length > 0) return setErrors({ fields });
    try {
      const res = await api<{ next: 'mfa' | 'enroll' }>('/api/auth/login', { method: 'POST', body: { email, password } });
      void navigate(withNext(res.next === 'mfa' ? '/login/mfa' : '/setup/totp', next));
    } catch (err) {
      setErrors({ form: messageFor(err), fields: {} });
    }
  };

  const onPasskey = async () => {
    try {
      await signInWithPasskey();
      await finish();
    } catch (err) {
      setErrors({ form: passkeyErrorMessage(err), fields: {} });
    }
  };

  return (
    <Layout>
      <h1>Sign in</h1>
      {notice && <Alert tone="success">{notice}</Alert>}
      {errors?.form && <Alert>{errors.form}</Alert>}
      <form ref={form} onSubmit={(e) => void onSubmit(e)} noValidate>
        <Field id="email" name="email" label="Email" type="email" autoComplete="username" error={errors?.fields.email} />
        <Field
          id="password"
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          error={errors?.fields.password}
        />
        <Link to="/forgot" className="text-link">
          Forgot password?
        </Link>
        <Button type="submit" variant="primary" className="btn-block">
          Sign in
        </Button>
      </form>
      <Button className="btn-block" onClick={() => void onPasskey()}>
        Sign in with a passkey
      </Button>
    </Layout>
  );
}
