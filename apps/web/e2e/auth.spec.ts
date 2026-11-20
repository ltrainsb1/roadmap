import { expect, test, type Page } from '@playwright/test';
import {
  addVirtualAuthenticator,
  bootstrapUser,
  createEnrolledUser,
  enrollTotp,
  expectNoA11yViolations,
  field,
  PASSWORD,
  pathOf,
  readLastMail,
  setPassword,
  signIn,
  signInWithRecoveryCode,
  signInWithTotp,
  totpFor,
  uniqueEmail,
  useCspGuard,
} from './helpers.ts';

const NEW_PASSWORD = 'another long passphrase 42';
const BAD_CODE = "That code didn't work. Try the next one your app shows.";

useCspGuard();

test('Auth: bootstrap owner sets password, enrolls TOTP, saves recovery codes, lands on roadmap picker', async ({ page }) => {
  const email = uniqueEmail('owner');
  const { setupUrl } = await bootstrapUser(email, 'Olive Owner');
  await setPassword(page, setupUrl);
  await signIn(page, email);
  await enrollTotp(page, { axe: true });
});

test('Auth: a wrong code at enrollment shows the code error and keeps the form', async ({ page }) => {
  const email = uniqueEmail('badcode');
  const { setupUrl } = await bootstrapUser(email, 'Bad Code');
  await setPassword(page, setupUrl);
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Set up your authenticator app' })).toBeVisible();
  const code = field(page, '6-digit code');
  await code.fill('000000');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText(BAD_CODE)).toBeVisible();
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute('aria-invalid', 'true');
  expect(await code.getAttribute('aria-describedby')).toBeTruthy();
});

test('Auth: sign in with password + TOTP', async ({ page }) => {
  const { email, secret } = await createEnrolledUser(page, 'totp');
  await signInWithTotp(page, email, secret);
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Roadmaps' })).toBeVisible();
});

test('Auth: a wrong authenticator code shows the message and the next code signs in', async ({ page }) => {
  const { email, secret } = await createEnrolledUser(page, 'wrongtotp');
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Enter your 6-digit code' })).toBeVisible();
  const code = field(page, 'Code from your authenticator app');
  await code.fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText(BAD_CODE)).toBeVisible();
  await expect(code).toBeFocused();
  // The retry must still carry the CSRF token of the pending session.
  await code.fill(totpFor(secret, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Roadmaps' })).toBeVisible();
});

test('Auth: a wrong recovery code shows the message and a valid one signs in', async ({ page }) => {
  const { email, recoveryCodes } = await createEnrolledUser(page, 'wrongrec');
  await signIn(page, email);
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  const code = field(page, 'Recovery code');
  await code.fill('AAAAA-AAAAA');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText("That recovery code didn't work. Check it and try again.")).toBeVisible();
  await code.fill(recoveryCodes[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Roadmaps' })).toBeVisible();
});

test('Auth: sign in with a recovery code', async ({ page }) => {
  const { email, recoveryCodes } = await createEnrolledUser(page, 'recovery');
  await signIn(page, email);
  await expect(page).toHaveURL(/\/login\/mfa/);
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await field(page, 'Recovery code').fill(recoveryCodes[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Roadmaps' })).toBeVisible();
});

test('Auth: opening the app with a half-finished sign-in goes back to sign in, and finishing it works', async ({ page }) => {
  const { email, recoveryCodes } = await createEnrolledUser(page, 'halfway');
  await signIn(page, email);
  await expect(page).toHaveURL(/\/login\/mfa/);
  // The password step passed and the second step did not: the app is not open to this session.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?next=%2F$/);
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  // Without a reload in between, so the refusal the app cached must not bounce the finished sign-in.
  await field(page, 'Email').fill(email);
  await field(page, 'Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/login\/mfa/);
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await field(page, 'Recovery code').fill(recoveryCodes[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Roadmaps' })).toBeVisible();
});

test('Auth: forgot password → email link → reset → sign in', async ({ page }) => {
  const { email, secret } = await createEnrolledUser(page, 'forgot');
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await field(page, 'Email').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(
    page.getByText('If an account exists for that email, a reset link is on its way. It works for 1 hour.'),
  ).toBeVisible();

  const mail = await readLastMail(email);
  const link = /https?:\/\/\S+\/reset\/\S+/.exec(mail.text)?.[0];
  expect(link).toBeTruthy();

  await page.goto(pathOf(link!));
  await field(page, 'New password').fill('short');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByText('Use at least 12 characters.', { exact: true }).last()).toBeVisible();
  await field(page, 'New password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();

  // The old password no longer works; the new one does.
  await signIn(page, email, PASSWORD);
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
  await field(page, 'Password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/login\/mfa/);
  await field(page, 'Code from your authenticator app').fill(totpFor(secret, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL('/');
});

test('Auth: a used reset link shows the expired message with a way to get a new one', async ({ page }) => {
  const { setupUrl } = await bootstrapUser(uniqueEmail('reuse'), 'Reuse Link');
  await setPassword(page, setupUrl);
  await page.goto(pathOf(setupUrl));
  await field(page, 'New password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('alert')).toContainText('This link has expired or was already used.');
  await page.getByRole('link', { name: 'Send a new link' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
});

test('Auth: add a passkey in settings, sign out, sign in passwordless with it', async ({ page, browserName }) => {
  // Chromium only: the virtual authenticator is a CDP feature. Nothing is stubbed: the credential the API stores must verify in a real ceremony.
  test.skip(browserName !== 'chromium');
  await addVirtualAuthenticator(page);
  const { email, secret, recoveryCodes } = await createEnrolledUser(page, 'passkey');
  // A recovery code signs in, so the authenticator app's next code is still free for the step-up (R18).
  await signInWithRecoveryCode(page, email, recoveryCodes[0]!);
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  const passkeys = page.getByRole('region', { name: 'Passkeys' });
  await passkeys.getByLabel('6-digit code or recovery code', { exact: true }).fill(totpFor(secret, 1));
  await passkeys.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('list', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Roadmaps' })).toBeVisible();
});

test('Auth: the passkey button explains a passkey that did not work', async ({ page }) => {
  await addVirtualAuthenticator(page); // holds no passkeys, so the browser refuses the prompt
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('alert')).toHaveText("That passkey didn't work. Try again or use another way to sign in.");
  await expect(page).toHaveURL(/\/login$/);
});

test('Auth: 5 wrong passwords show the generic error and the right password then fails', async ({ page, request }) => {
  const email = uniqueEmail('lock');
  const { setupUrl } = await bootstrapUser(email, 'Lock Out');
  const confirm = await request.post('/api/auth/password-reset/confirm', {
    data: { token: setupUrl.split('/').pop(), password: PASSWORD },
  });
  expect(confirm.status()).toBe(204);

  for (let i = 0; i < 5; i++) {
    await signIn(page, email, `wrong password ${i}`);
    await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
  }
  await signIn(page, email, PASSWORD);
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
  await expect(page).toHaveURL(/\/login$/);
});

/** Owner creates a roadmap and invites `to` through the API, the way the next task's screens will. */
async function inviteBy(page: Page, to: string, roadmapName: string): Promise<string> {
  await page.evaluate(
    async ({ inviteeEmail, name }) => {
      const call = async (path: string, csrf: string, body: unknown) => {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`${path} ${res.status}`);
        return (await res.json()) as { id: string };
      };
      const me = (await (await fetch('/api/me')).json()) as { csrfToken: string };
      const roadmap = await call('/api/roadmaps', me.csrfToken, { name });
      await call(`/api/roadmaps/${roadmap.id}/invites`, me.csrfToken, { email: inviteeEmail, role: 'contributor' });
    },
    { inviteeEmail: to, name: roadmapName },
  );
  // The mail is sent after the reply; wait for the one about this roadmap.
  await expect.poll(async () => (await readLastMail(to)).subject).toContain(roadmapName);
  const link = /https?:\/\/\S+\/invite\/\S+/.exec((await readLastMail(to)).text)?.[0];
  expect(link).toBeTruthy();
  return pathOf(link!);
}

test('Auth: an invited person creates an account, enrolls TOTP and lands on the roadmap list', async ({ page }) => {
  const owner = await createEnrolledUser(page, 'inviter');
  await signInWithTotp(page, owner.email, owner.secret);
  await expect(page).toHaveURL('/');
  const invitee = uniqueEmail('newcomer');
  const invitePath = await inviteBy(page, invitee, 'Launch plan');
  await page.context().clearCookies();

  await page.goto(invitePath);
  await expect(page.getByRole('heading', { name: 'Join Launch plan' })).toBeVisible();
  await expect(page.getByText(`You were invited as Contributor with ${invitee}.`)).toBeVisible();
  await field(page, 'Name').fill('Nina Newcomer');
  await field(page, 'Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await enrollTotp(page);
});

test('Auth: an invited person with an account signs in, then joins', async ({ page }) => {
  // An account belongs to one tenant, so the second invite goes to someone the owner already invited.
  const owner = await createEnrolledUser(page, 'host');
  await signInWithTotp(page, owner.email, owner.secret);
  await expect(page).toHaveURL('/');
  const guest = uniqueEmail('guest');
  const firstInvite = await inviteBy(page, guest, 'First plan');
  const secondInvite = await inviteBy(page, guest, 'Second plan');
  await page.context().clearCookies();

  await page.goto(firstInvite);
  await field(page, 'Name').fill('Gus Guest');
  await field(page, 'Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  const { secret } = await enrollTotp(page);
  await page.context().clearCookies();

  await page.goto(secondInvite);
  await expect(page.getByRole('heading', { name: 'Join Second plan' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in to join' }).click();
  await expect(page).toHaveURL(/\/login\?next=/);
  await field(page, 'Email').fill(guest);
  await field(page, 'Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/login\/mfa/);
  await field(page, 'Code from your authenticator app').fill(totpFor(secret, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(secondInvite);
  await page.getByRole('button', { name: 'Sign in to join' }).click();
  await expect(page).toHaveURL(/\/r\/[^/]+\/projects$/);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
});

test('Auth: an unknown invite link shows the expired message', async ({ page }) => {
  await page.goto('/invite/not-a-real-token');
  await expect(page.getByRole('alert')).toHaveText(
    'This invite has expired or was replaced. Ask the person who invited you for a new one.',
  );
});

test('Auth screens pass axe at 375px and 1280px', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  const screens: [string, string][] = [
    ['/login', 'Sign in'],
    ['/login/mfa', 'Enter your 6-digit code'],
    ['/setup/totp', 'Set up your authenticator app'],
    ['/forgot', 'Reset your password'],
    ['/reset/x', 'Choose a new password'],
    ['/invite/x', 'Join a roadmap'],
  ];
  for (const [route, heading] of screens) {
    await test.step(route, async () => {
      await page.goto(route);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      // Let async states (an expired session, a bad invite link) settle before scanning.
      await page.waitForLoadState('networkidle');
      await expectNoA11yViolations(page);
      if (mobile) {
        const width = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(width, `horizontal scroll on ${route}`).toBeLessThanOrEqual(375);
      }
    });
  }
});
