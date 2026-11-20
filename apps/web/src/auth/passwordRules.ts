/** Same bounds as the API's passwordSchema. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export const PASSWORD_LENGTH_ERROR = 'Use at least 12 characters.';

/** An error message when the password's length is out of bounds, otherwise undefined. */
export function passwordLengthError(password: string): string | undefined {
  if (password.length < PASSWORD_MIN) return PASSWORD_LENGTH_ERROR;
  if (password.length > PASSWORD_MAX) return 'Use 128 characters or fewer.';
  return undefined;
}
