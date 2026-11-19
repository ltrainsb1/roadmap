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
    case 'owner_immutable':
      return "The owner can't be changed here. Transfer ownership instead.";
    case 'conflict':
      return 'Someone else changed this at the same time. Reload and try again.';
    case 'already_owner':
      return 'You already own this roadmap.';
    case 'not_a_member':
      return "That person isn't a member of this roadmap.";
    case 'date_order':
      return 'The end date is before the start date.';
    case 'too_deep':
      return "A sub-task can't have items under it.";
    case 'parent_archived':
      return 'Unarchive the item above this one first.';
    case 'too_many_items':
      return 'This roadmap has reached 2,000 items.';
    case 'confirm_mismatch':
      return "The name doesn't match.";
    case 'last_factor':
      return "You can't remove your only passkey. Set up your authenticator app first.";
    case 'password_too_short':
      return 'Use at least 12 characters.';
    case 'csrf':
      return 'Your session changed. Reload the page and try again.';
    case 'unauthenticated':
    case 'sign_in_required':
      return 'Your sign-in has expired. Sign in again.';
    case 'other_tenant':
      return 'This email belongs to a different organization. Ask the person who invited you to use another address.';
    case 'enroll_not_started':
      return 'Start setting up your authenticator app again.';
    case 'mfa_required':
      return 'Finish signing in first.';
    case 'rate_limited':
      return 'Too many attempts. Wait a minute and try again.';
    default:
      return GENERIC_ERROR;
  }
}

export const errorCode = (err: unknown): string => (err instanceof ApiError ? err.code : 'unknown');

/** The message for whatever a screen caught. */
export const messageFor = (err: unknown, ctx?: ErrorContext): string => errorMessage(errorCode(err), ctx);
