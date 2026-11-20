import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { api } from '../api/client.ts';
import { errorCode, errorMessage } from '../api/errors.ts';

/**
 * Signs in with a passkey: either the second step of a password sign-in (the server sees the pending
 * session) or the whole sign-in. Either way the response carries the new session's CSRF token, which
 * `api` stores. A cancelled browser prompt throws, and the caller shows the passkey error.
 */
export async function signInWithPasskey(): Promise<void> {
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>('/api/auth/passkeys/login/options', {
    method: 'POST',
  });
  const response = await startAuthentication({ optionsJSON });
  await api('/api/auth/passkeys/login/verify', { method: 'POST', body: { response } });
}

/**
 * The message for a failed passkey attempt. The server answers a bad passkey with `invalid_credentials`,
 * and a dismissed browser prompt is not an API error at all; both read as a passkey problem.
 */
export function passkeyErrorMessage(err: unknown): string {
  const code = errorCode(err);
  return errorMessage(code === 'invalid_credentials' || code === 'unknown' ? 'invalid_passkey' : code);
}
