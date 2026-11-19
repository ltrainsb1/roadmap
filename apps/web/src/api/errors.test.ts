import { describe, expect, test } from 'vitest';
import { ApiError } from './client.ts';
import { errorMessage, GENERIC_ERROR, messageFor } from './errors.ts';

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
