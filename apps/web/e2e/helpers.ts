import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { authenticator } from 'otplib';

const run = promisify(execFile);
const bootstrapCli = path.resolve(import.meta.dirname, '../../api/dist/cli/bootstrap.js');

/** The last email sent to `to`. Mail is sent after the HTTP reply, so this waits for it. */
export async function readLastMail(to: string): Promise<{ subject: string; text: string }> {
  const file = process.env.E2E_MAIL_OUTBOX;
  if (!file) throw new Error('E2E_MAIL_OUTBOX is not set; global setup did not run');
  const deadline = Date.now() + 10_000;
  for (;;) {
    const lines = (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    const mails = lines.map((l) => JSON.parse(l) as { to: string; subject: string; text: string });
    const last = mails.reverse().find((m) => m.to === to);
    if (last) return { subject: last.subject, text: last.text };
    if (Date.now() > deadline) throw new Error(`no mail to ${to} within 10 s`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * A 6-digit code for `secret`. The server rejects a step it already accepted, so a second code for the
 * same secret inside 30 s must come from a later step: pass `stepOffset: 1` (the server accepts one step ahead).
 */
export function totpFor(secret: string, stepOffset = 0): string {
  return authenticator.clone({ epoch: Date.now() + stepOffset * 30_000 }).generate(secret);
}

/** Creates a tenant and its first user through the built bootstrap command; returns the setup link. */
export async function bootstrapUser(email: string, name: string): Promise<{ setupUrl: string }> {
  const env = process.env.E2E_API_ENV;
  if (!env) throw new Error('E2E_API_ENV is not set; global setup did not run');
  const { stdout } = await run(
    process.execPath,
    [bootstrapCli, '--tenant', `Tenant ${email}`, '--email', email, '--name', name],
    { env: { ...process.env, ...(JSON.parse(env) as Record<string, string>) } },
  );
  return { setupUrl: stdout.trim() };
}

/** A software passkey, so the browser answers WebAuthn prompts without a person. Chromium only. */
export async function addVirtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
}

export async function expectNoA11yViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.target.join(' ')),
  }));
  expect(summary, `axe violations on ${page.url()}`).toEqual([]);
}

export const PASSWORD = 'correct horse battery staple';

export const uniqueEmail = (label: string) => `${label}-${randomBytes(4).toString('hex')}@example.com`;
export const pathOf = (url: string) => new URL(url).pathname;
export const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

// The built app is served with the strict policy (no inline script or style); any violation fails the test.
const cspViolations: string[] = [];
export function watchCsp(page: Page): void {
  page.on('console', (m) => {
    if (m.text().includes('Content Security Policy')) cspViolations.push(m.text());
  });
}
/** Call once at the top of a spec file: every page the test opens is watched, and a violation fails the test. */
export function useCspGuard(): void {
  test.beforeEach(({ page }) => {
    cspViolations.length = 0;
    watchCsp(page);
  });
  test.afterEach(() => {
    expect(cspViolations).toEqual([]);
  });
}

export async function setPassword(page: Page, setupUrl: string, password = PASSWORD) {
  await page.goto(pathOf(setupUrl));
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await field(page, 'New password').fill(password);
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
}

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto('/login');
  await field(page, 'Email').fill(email);
  await field(page, 'Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

export async function enrollTotp(page: Page, opts: { axe?: boolean } = {}) {
  await expect(page).toHaveURL(/\/setup\/totp/);
  await expect(page.getByRole('heading', { name: 'Set up your authenticator app' })).toBeVisible();
  await expect(page.getByText("Can't scan? Enter this key:")).toBeVisible();
  const secret = (await page.getByTestId('totp-secret').innerText()).trim();
  if (opts.axe) await expectNoA11yViolations(page);
  await field(page, '6-digit code').fill(totpFor(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  await expect(page.getByText('Each code works once. You need one if you lose your phone.')).toBeVisible();
  const recoveryCodes = await page.getByTestId('recovery-codes').getByRole('listitem').allInnerTexts();
  expect(recoveryCodes).toHaveLength(10);
  if (opts.axe) {
    await expectNoA11yViolations(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download codes' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('roadmap-recovery-codes.txt');
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toHaveText('Tick the box to confirm you saved your codes.');
  await page.getByLabel('I saved these codes').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Roadmaps' })).toBeVisible();
  return { secret, recoveryCodes };
}

export interface TestUser {
  email: string;
  name: string;
  secret: string;
  recoveryCodes: string[];
}

/** A user with a password and an authenticator app, signed out. */
export async function createEnrolledUser(page: Page, label: string): Promise<TestUser> {
  const email = uniqueEmail(label);
  const name = `${label} user`;
  const { setupUrl } = await bootstrapUser(email, name);
  await setPassword(page, setupUrl);
  await signIn(page, email);
  const { secret, recoveryCodes } = await enrollTotp(page);
  await page.context().clearCookies();
  return { email, name, secret, recoveryCodes };
}

export async function signInWithTotp(page: Page, email: string, secret: string) {
  await signIn(page, email);
  await expect(page).toHaveURL(/\/login\/mfa/);
  await expect(page.getByRole('heading', { name: 'Enter your 6-digit code' })).toBeVisible();
  // Enrollment used this step already; the server accepts the next one.
  await field(page, 'Code from your authenticator app').fill(totpFor(secret, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
}

/** Signs in with a recovery code, which leaves the authenticator code free for a later prompt. */
export async function signInWithRecoveryCode(page: Page, email: string, code: string) {
  await signIn(page, email);
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await field(page, 'Recovery code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL('/');
}

/** An owner with an authenticator app, signed in on `page` and looking at the roadmap list. */
export async function createSignedInUser(page: Page, label: string): Promise<TestUser> {
  const user = await createEnrolledUser(page, label);
  await signInWithTotp(page, user.email, user.secret);
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Roadmaps' })).toBeVisible();
  return user;
}

/** Creates a roadmap from the picker; returns its id once the page has moved into it. */
export async function createRoadmap(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New roadmap' }).click();
  const dialog = page.getByRole('dialog', { name: 'New roadmap' });
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Create roadmap' }).click();
  await expect(page).toHaveURL(/\/r\/[^/]+\/projects$/);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  return /\/r\/([^/]+)\//.exec(page.url())![1]!;
}

/** Opens the Members tab of the roadmap the page is in. */
export async function openMembers(page: Page) {
  await page.getByRole('link', { name: 'Members', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Members', level: 1 })).toBeVisible();
}

/** Sends an invite from the Members screen, opening its tab first. */
export async function sendInvite(page: Page, email: string, role: 'Admin' | 'Contributor') {
  await openMembers(page);
  await field(page, 'Email').fill(email);
  await page.getByLabel('Role', { exact: true }).selectOption({ label: role });
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByText(`Invite sent to ${email}.`)).toBeVisible();
}

export async function inviteLinkFor(email: string, roadmapName: string): Promise<string> {
  await expect.poll(async () => (await readLastMail(email)).subject).toContain(roadmapName);
  const link = /https?:\/\/\S+\/invite\/\S+/.exec((await readLastMail(email)).text)?.[0];
  expect(link).toBeTruthy();
  return pathOf(link!);
}

export interface Joined extends TestUser {
  context: BrowserContext;
  page: Page;
}

/** A second browser context in which a newcomer opens an invite link, creates an account and enrolls. */
export async function joinViaInvite(browser: Browser, info: TestInfo, invitePath: string, name: string, email: string): Promise<Joined> {
  const use = info.project.use;
  const context = await browser.newContext({
    ...(use.baseURL && { baseURL: use.baseURL }),
    ...(use.viewport && { viewport: use.viewport }),
    ...(use.isMobile !== undefined && { isMobile: use.isMobile }),
    ...(use.hasTouch !== undefined && { hasTouch: use.hasTouch }),
  });
  const page = await context.newPage();
  watchCsp(page);
  await page.goto(invitePath);
  await field(page, 'Name').fill(name);
  await field(page, 'Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  const { secret, recoveryCodes } = await enrollTotp(page);
  return { email, name, secret, recoveryCodes, context, page };
}

/** Invites `email` from the owner's Members screen and has them join in a new context. */
export async function inviteAndJoin(
  owner: Page,
  browser: Browser,
  info: TestInfo,
  roadmapName: string,
  label: string,
  role: 'Admin' | 'Contributor',
): Promise<Joined> {
  const email = uniqueEmail(label);
  await sendInvite(owner, email, role);
  const path = await inviteLinkFor(email, roadmapName);
  return joinViaInvite(browser, info, path, `${label} user`, email);
}

/** The row of the project list for the item titled `title`. */
export const projectRow = (page: Page, title: string) =>
  page.getByRole('row').filter({ has: page.getByRole('link', { name: title, exact: true }) });

const newItemInput = (page: Page) => page.getByRole('textbox', { name: /^Title of the new / });

/** Adds a top-level project through the "New project" button and closes the add row. */
export async function addProject(page: Page, title: string) {
  await page.getByRole('button', { name: 'New project' }).click();
  await newItemInput(page).fill(title);
  await newItemInput(page).press('Enter');
  await expect(projectRow(page, title)).toBeVisible();
  await newItemInput(page).press('Escape');
  await expect(newItemInput(page)).toHaveCount(0);
}

/** Adds an item under `parentTitle` through that row's menu and closes the add row. */
export async function addChild(page: Page, parentTitle: string, title: string) {
  await page.getByRole('button', { name: `Actions for ${parentTitle}` }).click();
  await page.getByRole('menuitem', { name: /^Add (sub-project|task|sub-task)$/ }).click();
  await newItemInput(page).fill(title);
  await newItemInput(page).press('Enter');
  await expect(projectRow(page, title)).toBeVisible();
  await newItemInput(page).press('Escape');
  await expect(newItemInput(page)).toHaveCount(0);
}

/** Opens the item's panel by choosing its title. */
export async function openProject(page: Page, title: string) {
  await page.getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(/\/r\/[^/]+\/projects\/[^/]+$/);
}

/** Calls the API as the signed-in person on `page`, for seeding data the screen under test then shows. */
export async function apiAs(page: Page) {
  const { csrfToken } = (await (await page.request.get('/api/me')).json()) as { csrfToken: string };
  return async <T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<T> => {
    const res = await page.request.fetch(path, { method, headers: { 'x-csrf-token': csrfToken }, ...(data === undefined ? {} : { data }) });
    expect(res.ok(), `${method} ${path} answered ${res.status()}`).toBe(true);
    return (res.status() === 204 ? undefined : await res.json()) as T;
  };
}

/** Creates an item through the API; returns its id. */
export async function seedProject(call: Awaited<ReturnType<typeof apiAs>>, roadmapId: string, title: string, parentId: string | null = null) {
  return (await call<{ id: string }>('POST', `/api/roadmaps/${roadmapId}/projects`, { parentId, title })).id;
}
