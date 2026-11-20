import { describe, expect, test } from 'vitest';
import { ApiError } from './client.ts';
import { errorMessage, GENERIC_ERROR, itemActionMessage, messageFor } from './errors.ts';

describe('error messages', () => {
  test.each([
    ['invalid_credentials', 'Email or password is incorrect.'],
    ['invalid_code', "That code didn't work. Try the next one your app shows."],
    ['password_breached', 'This password has appeared in a data breach. Choose a different one.'],
    ['token_invalid', 'This link has expired or was already used.'],
    ['invite_invalid', 'This invite has expired or was replaced. Ask the person who invited you for a new one.'],
    ['owner_immutable', "The owner can't be changed here. Transfer ownership instead."],
    ['conflict', 'Someone else changed this at the same time. Reload and try again.'],
    ['already_owner', 'You already own this roadmap.'],
    ['not_a_member', "That person isn't a member of this roadmap."],
    ['too_deep', "A sub-task can't have items under it."],
    ['parent_archived', 'Unarchive the item above this one first.'],
    ['dependency_cycle', 'These items would end up blocked by each other.'],
    ['order_stale', 'The list changed while you were reordering. Try again.'],
    ['unknown_item', 'That item no longer exists. Reload and try again.'],
    ['too_many_items', 'This roadmap has reached 2,000 items.'],
    ['confirm_mismatch', "The name doesn't match."],
    ['last_factor', "You can't remove your only passkey. Set up your authenticator app first."],
    ['password_too_short', 'Use at least 12 characters.'],
    ['csrf', 'Your session changed. Reload the page and try again.'],
    ['other_tenant', 'This email belongs to a different organization. Ask the person who invited you to use another address.'],
    ['enroll_not_started', 'Start setting up your authenticator app again.'],
    ['mfa_required', 'Finish signing in first.'],
    ['something_new', 'Something went wrong. Try again.'],
  ])('%s', (code, text) => {
    expect(errorMessage(code)).toBe(text);
  });

  test('names the address and the recovery code where the message needs it', () => {
    expect(errorMessage('already_member', { email: 'a@b.co' })).toBe('a@b.co is already a member.');
    expect(errorMessage('invalid_code', { recovery: true })).toContain('recovery code');
  });

  test('an error that is not an ApiError gets the generic message', () => {
    expect(messageFor(new TypeError('network'))).toBe(GENERIC_ERROR);
    expect(messageFor(new ApiError(401, 'invalid_credentials'))).toBe('Email or password is incorrect.');
  });
});

describe('messages for an action on an item', () => {
  test('an item that is gone says so, as an unknown item does', () => {
    expect(itemActionMessage(new ApiError(404, 'not_found'))).toBe('That item no longer exists. Reload and try again.');
  });

  test('a refused action names who may change the item', () => {
    expect(itemActionMessage(new ApiError(403, 'forbidden'))).toBe('Only people assigned to this item, Owners and Admins can change it.');
  });

  test('every other error keeps its own message', () => {
    expect(itemActionMessage(new ApiError(409, 'conflict'))).toBe('Someone else changed this at the same time. Reload and try again.');
    expect(itemActionMessage(new ApiError(422, 'not_a_member'))).toBe("That person isn't a member of this roadmap.");
    expect(itemActionMessage(new TypeError('network'))).toBe(GENERIC_ERROR);
  });
});
