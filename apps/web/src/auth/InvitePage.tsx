import type { AcceptInviteResponse, InviteInfo } from '@roadmap/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.ts';
import { errorCode, messageFor } from '../api/errors.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { formText } from '../ui/formText.ts';
import { Layout } from '../ui/Layout.tsx';
import { useFocusFirstError, type FormErrors } from '../ui/useFocusFirstError.ts';
import { PASSWORD_LENGTH_ERROR, passwordLengthError } from './passwordRules.ts';
import { ME_KEY } from './useMe.ts';

const ROLE_NAMES = { admin: 'Admin', contributor: 'Contributor' } as const;

export function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<FormErrors | null>(null);
  useFocusFirstError(form, errors);
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<InviteInfo>(`/api/invites/${encodeURIComponent(token)}`),
    retry: false,
  });

  const accept = async (body?: { name: string; password: string; timezone: string }) => {
    const path = `/api/invites/${encodeURIComponent(token)}/accept`;
    const res = await api<AcceptInviteResponse>(path, { method: 'POST', ...(body ? { body } : {}) });
    await queryClient.invalidateQueries({ queryKey: ME_KEY });
    // Until the roadmap screens exist, both paths end at the roadmap list.
    void navigate(res.next === 'enroll' ? '/setup/totp' : '/');
  };

  const onCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = formText(data, 'name').trim();
    const password = formText(data, 'password');
    const fields: Record<string, string> = {};
    if (!name) fields.name = 'Enter your name.';
    const tooShort = passwordLengthError(password);
    if (tooShort) fields.password = tooShort;
    if (Object.keys(fields).length > 0) return setErrors({ fields });
    try {
      await accept({ name, password, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    } catch (err) {
      const code = errorCode(err);
      if (code === 'password_breached') return setErrors({ fields: { password: messageFor(err) } });
      if (code === 'validation') return setErrors({ fields: { password: PASSWORD_LENGTH_ERROR } });
      setErrors({ form: messageFor(err), fields: {} });
    }
  };

  const onJoin = async () => {
    try {
      await accept();
    } catch (err) {
      // A 401 already sent the person to sign in, and they come back here afterwards.
      if (errorCode(err) !== 'sign_in_required') setErrors({ form: messageFor(err), fields: {} });
    }
  };

  if (invite.isPending) {
    return (
      <Layout>
        <h1>Join a roadmap</h1>
        <p role="status">Loading</p>
      </Layout>
    );
  }
  if (invite.isError) {
    return (
      <Layout>
        <h1>Join a roadmap</h1>
        <Alert>{messageFor(invite.error)}</Alert>
      </Layout>
    );
  }

  const { roadmapName, email, role, accountExists } = invite.data;
  return (
    <Layout>
      <h1>Join {roadmapName}</h1>
      <p>
        You were invited as {ROLE_NAMES[role]} with {email}.
      </p>
      {errors?.form && <Alert>{errors.form}</Alert>}
      {accountExists ? (
        <Button variant="primary" className="btn-block" onClick={() => void onJoin()}>
          Sign in to join
        </Button>
      ) : (
        <form ref={form} onSubmit={(e) => void onCreate(e)} noValidate>
          <Field id="name" name="name" label="Name" autoComplete="name" error={errors?.fields.name} />
          <Field
            id="password"
            name="password"
            label="Password"
            hint="At least 12 characters."
            type="password"
            autoComplete="new-password"
            error={errors?.fields.password}
          />
          <Button type="submit" variant="primary" className="btn-block">
            Create account
          </Button>
        </form>
      )}
    </Layout>
  );
}
