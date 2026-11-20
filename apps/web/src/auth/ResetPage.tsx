import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.ts';
import { errorCode, errorMessage, messageFor } from '../api/errors.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { formText } from '../ui/formText.ts';
import { Layout } from '../ui/Layout.tsx';
import { useFocusFirstError, type FormErrors } from '../ui/useFocusFirstError.ts';
import { PASSWORD_LENGTH_ERROR, passwordLengthError } from './passwordRules.ts';

/** Also the page the first Owner's setup link opens. */
export function ResetPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const form = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<FormErrors | null>(null);
  const [badLink, setBadLink] = useState(false);
  useFocusFirstError(form, errors);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = formText(new FormData(e.currentTarget), 'password');
    const tooShort = passwordLengthError(password);
    if (tooShort) return setErrors({ fields: { password: tooShort } });
    try {
      await api('/api/auth/password-reset/confirm', { method: 'POST', body: { token, password } });
      void navigate('/login', { state: { notice: 'Password saved. Sign in with your new password.' } });
    } catch (err) {
      const code = errorCode(err);
      if (code === 'token_invalid') return setBadLink(true);
      if (code === 'password_breached') return setErrors({ fields: { password: messageFor(err) } });
      if (code === 'validation') return setErrors({ fields: { password: PASSWORD_LENGTH_ERROR } });
      setErrors({ form: messageFor(err), fields: {} });
    }
  };

  return (
    <Layout>
      <h1>Choose a new password</h1>
      {badLink ? (
        <>
          <Alert>{errorMessage('token_invalid')}</Alert>
          <Link to="/forgot" className="text-link">
            Send a new link
          </Link>
        </>
      ) : (
        <>
          {errors?.form && <Alert>{errors.form}</Alert>}
          <form ref={form} onSubmit={(e) => void onSubmit(e)} noValidate>
            <Field
              id="password"
              name="password"
              label="New password"
              hint="At least 12 characters."
              type="password"
              autoComplete="new-password"
              error={errors?.fields.password}
            />
            <Button type="submit" variant="primary" className="btn-block">
              Save password
            </Button>
          </form>
        </>
      )}
    </Layout>
  );
}
