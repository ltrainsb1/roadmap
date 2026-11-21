import { signInWithTotp, useCspGuard } from './helpers.ts';
import { expect, joinByApi, test } from './fixtures.ts';

useCspGuard();

test('the owner fixture is signed in without visiting the sign-in screens', async ({ page, owner }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Roadmaps' })).toBeVisible();
  expect(owner.recoveryCodes).toHaveLength(10);
});

test('the roadmap fixture exists and joinByApi adds a member who can open it', async ({ browser, call, roadmap }) => {
  const member = await joinByApi(browser, call, roadmap.id, 'contributor', 'joiner');
  await member.page.goto(`/r/${roadmap.id}/projects`);
  await expect(member.page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await member.context.close();
});

test('a code from the fixture secret is accepted', async ({ page, owner }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  await signInWithTotp(page, owner.email, owner.secret);
  await expect(page).toHaveURL('/');
});
