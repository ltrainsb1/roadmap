import { expect, test } from '@playwright/test';
import {
  addVirtualAuthenticator,
  createEnrolledUser,
  expectNoA11yViolations,
  field,
  signIn,
  signInWithRecoveryCode,
  signInWithTotp,
  totpFor,
  useCspGuard,
  watchCsp,
} from './helpers.ts';

useCspGuard();

test('Sign out of all sessions logs out a second browser context', async ({ page, browser }, testInfo) => {
  const user = await createEnrolledUser(page, 'everywhere');
  await signInWithTotp(page, user.email, user.secret);
  await expect(page).toHaveURL('/');

  // A second browser signs in with a recovery code (the authenticator step is used up).
  const use = testInfo.project.use;
  const other = await browser.newContext({ ...(use.baseURL && { baseURL: use.baseURL }), ...(use.viewport && { viewport: use.viewport }) });
  const otherPage = await other.newPage();
  watchCsp(otherPage);
  await signInWithRecoveryCode(otherPage, user.email, user.recoveryCodes[0]!);
  await expect(otherPage.getByRole('heading', { name: 'Roadmaps' })).toBeVisible();

  await page.getByRole('link', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();

  await otherPage.reload();
  await expect(otherPage.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  await other.close();
});

test('Sign out in the header shows the sign-in screen', async ({ page }) => {
  const user = await createEnrolledUser(page, 'leaver');
  await signInWithTotp(page, user.email, user.secret);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});

test('Security: new recovery codes need the authenticator code, show once, and replace the old ones', async ({ page }) => {
  const user = await createEnrolledUser(page, 'codes');
  await signInWithRecoveryCode(page, user.email, user.recoveryCodes[0]!);
  await page.getByRole('link', { name: 'Security' }).click();
  await expect(page.getByText('Your old codes stop working.')).toBeVisible();

  await page.getByRole('button', { name: 'Make new codes' }).click();
  await expect(page.getByText('Enter the 6-digit code from your app.')).toBeVisible();
  await field(page, '6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Make new codes' }).click();
  await expect(page.getByText("That code didn't work. Try the next one your app shows.")).toBeVisible();

  await field(page, '6-digit code').fill(totpFor(user.secret, 1));
  await page.getByRole('button', { name: 'Make new codes' }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  const fresh = await page.getByTestId('recovery-codes').getByRole('listitem').allInnerTexts();
  expect(fresh).toHaveLength(10);
  expect(fresh).not.toContain(user.recoveryCodes[1]);
  await expectNoA11yViolations(page);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Tick the box to confirm you saved your codes.')).toBeVisible();
  await page.getByLabel('I saved these codes').check();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: 'Make new codes' })).toBeVisible();
  await expect(page.getByTestId('recovery-codes')).toHaveCount(0);

  // An old code no longer signs in; a new one does.
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, user.email);
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await field(page, 'Recovery code').fill(user.recoveryCodes[1]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText("That recovery code didn't work. Check it and try again.")).toBeVisible();
  await field(page, 'Recovery code').fill(fresh[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL('/');
});

test('Security: add and remove a passkey', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium');
  await addVirtualAuthenticator(page);
  const user = await createEnrolledUser(page, 'keys');
  await signInWithTotp(page, user.email, user.secret);
  await page.getByRole('link', { name: 'Security' }).click();
  await expect(page.getByText('You have no passkeys yet.')).toBeVisible();

  await page.getByRole('button', { name: 'Add a passkey' }).click();
  const list = page.getByRole('list', { name: 'Passkeys' });
  await expect(list.getByRole('listitem')).toHaveCount(1);

  const remove = list.getByRole('button', { name: /^Remove passkey/ });
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'Remove passkey' });
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('You have no passkeys yet.')).toBeVisible();
});
