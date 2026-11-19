import { ApiError } from './client.ts';

export const GENERIC_ERROR = 'Something went wrong. Try again.';

export interface ErrorContext {
  /** The second-step code in question is a recovery code, not an authenticator app code. */
  recovery?: boolean;
  /** The address to name in "already a member" messages. */
  email?: string;
}

/** On-screen copy for each API error code. Screens ask here; unknown codes get the generic message. */
export function errorMessage(code: string, ctx: ErrorContext = {}): string {
  switch (code) {
    case 'invalid_credentials':
      return 'Email or password is incorrect.';
    case 'invalid_code':
      return ctx.recovery
        ? "That recovery code didn't work. Check it and try again."
        : "That code didn't work. Try the next one your app shows.";
    case 'invalid_passkey':
      return "That passkey didn't work. Try again or use another way to sign in.";
    case 'no_passkeys':
      return 'This account has no passkeys. Use your authenticator app instead.';
    case 'password_breached':
      return 'This password has appeared in a data breach. Choose a different one.';
    case 'token_invalid':
      return 'This link has expired or was already used.';
    case 'invite_invalid':
      return 'This invite has expired or was replaced. Ask the person who invited you for a new one.';
    case 'already_member':
      return ctx.email ? `${ctx.email} is already a member.` : 'That person is already a member.';
    case 'unauthenticated':
    case 'sign_in_required':
      return 'Your sign-in has expired. Sign in again.';
    case 'rate_limited':
      return 'Too many attempts. Wait a minute and try again.';
    default:
      return GENERIC_ERROR;
  }
}

export const errorCode = (err: unknown): string => (err instanceof ApiError ? err.code : 'unknown');

/** The message for whatever a screen caught. */
export const messageFor = (err: unknown, ctx?: ErrorContext): string => errorMessage(errorCode(err), ctx);
