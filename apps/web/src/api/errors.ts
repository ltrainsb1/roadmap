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
    case 'dependency_cycle':
      return 'These items would end up blocked by each other.';
    case 'order_stale':
      return 'The list changed while you were reordering. Try again.';
    case 'unknown_item':
      return 'That item no longer exists. Reload and try again.';
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
    case 'as_of_in_future':
      return 'Choose today or an earlier date.';
    case 'expiry_in_past':
      return 'Choose a date after today.';
    case 'expiry_too_far':
      return 'Choose a date within two years.';
    case 'too_many_snapshots':
      return 'This roadmap already has 50 snapshots. Revoke one to create another.';
    case 'too_many_notes':
      return 'This roadmap has more than 5,000 notes. Create the snapshot without notes.';
    case 'wrong_password':
      return "That password isn't right.";
    case 'snapshot_locked':
      return 'Too many wrong passwords. Try again in 15 minutes.';
    default:
      return GENERIC_ERROR;
  }
}

export const errorCode = (err: unknown): string => (err instanceof ApiError ? err.code : 'unknown');

/** The message for whatever a screen caught. */
export const messageFor = (err: unknown, ctx?: ErrorContext): string => errorMessage(errorCode(err), ctx);

/** Read-only copy for an item the person may not change, also shown when the server refuses a change with `forbidden`. */
export const ITEM_READ_ONLY = 'Only people assigned to this item, Owners and Admins can change it.';

/** Notes and files on an archived item can be read, not changed; also shown when the server refuses with `item_archived`. */
export const ARCHIVED_CONTENT = "This item is archived, so notes and files can't be added or changed.";

/** The message for a failed action on a project item: a gone item and a refused one get sentences about the item. */
export const itemActionMessage = (err: unknown): string => {
  const code = errorCode(err);
  if (code === 'not_found') return errorMessage('unknown_item');
  if (code === 'forbidden') return ITEM_READ_ONLY;
  return messageFor(err);
};

/** The notifications list could not be fetched; a "Try again" button follows it. */
export const NOTIFICATIONS_LOAD_FAILED = "Couldn't load notifications. Try again.";

/** "Mark all as read" failed. */
export const NOTIFICATIONS_MARK_FAILED = "Couldn't mark notifications as read. Try again.";
