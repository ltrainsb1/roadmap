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
