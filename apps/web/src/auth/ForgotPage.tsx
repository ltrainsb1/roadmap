import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.ts';
import { errorCode, messageFor } from '../api/errors.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { formText } from '../ui/formText.ts';
import { Layout } from '../ui/Layout.tsx';
import { useFocusFirstError, type FormErrors } from '../ui/useFocusFirstError.ts';

export function ForgotPage() {
  const form = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<FormErrors | null>(null);
  const [sent, setSent] = useState(false);
  useFocusFirstError(form, errors);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const email = formText(new FormData(e.currentTarget), 'email').trim();
    if (!email) return setErrors({ fields: { email: 'Enter your email.' } });
    try {
      await api('/api/auth/password-reset/request', { method: 'POST', body: { email } });
      setErrors(null);
      setSent(true);
    } catch (err) {
      // The API validates the address; a malformed one is the person's to fix.
      const invalid = errorCode(err) === 'validation';
      setErrors(invalid ? { fields: { email: 'Enter a valid email.' } } : { form: messageFor(err), fields: {} });
    }
  };

  return (
    <Layout>
      <h1>Reset your password</h1>
      {sent ? (
        <>
          <Alert tone="success">
            If an account exists for that email, a reset link is on its way. It works for 1 hour.
          </Alert>
          <Link to="/login" className="text-link">
            Back to sign in
          </Link>
        </>
      ) : (
        <>
          {errors?.form && <Alert>{errors.form}</Alert>}
          <form ref={form} onSubmit={(e) => void onSubmit(e)} noValidate>
            <Field id="email" name="email" label="Email" type="email" autoComplete="username" error={errors?.fields.email} />
            <Button type="submit" variant="primary" className="btn-block">
              Send reset link
            </Button>
          </form>
          <Link to="/login" className="text-link">
            Back to sign in
          </Link>
        </>
      )}
    </Layout>
  );
}
