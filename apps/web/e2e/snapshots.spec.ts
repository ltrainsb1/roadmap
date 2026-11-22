import type { Page } from '@playwright/test';
import { expectNoA11yViolations, field, useCspGuard } from './helpers.ts';
import { expect, joinByApi, test, type ApiCall } from './fixtures.ts';

useCspGuard();

const INTRO = 'A snapshot is a frozen copy of this roadmap. People without an account open it with a link and a password.';

// A card holds a list of facts of its own, so only the outer list's own entries are cards.
const cardsOf = (page: Page) => page.getByRole('list', { name: 'Snapshots' }).locator('> li');
const cardOf = (page: Page, name: string) => cardsOf(page).filter({ has: page.getByRole('heading', { name, exact: true }) });

async function expectNoSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
}

/** Creates a snapshot through the API; the API takes "as of" up to a day past the UTC date, so the UTC date always works. */
function seedSnapshot(call: ApiCall, roadmapId: string, name: string) {
  return call<{ id: string; linkId: string }>('POST', `/api/roadmaps/${roadmapId}/snapshots`, {
    name,
    asOf: new Date().toISOString().slice(0, 10),
    password: 'a long enough password',
    expiresAt: null,
    include: { notes: false, assignees: false },
  });
}

test('FR-3.1: an Owner creates a snapshot and it appears in the list as Active', async ({ page, owner, roadmap }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/r/${roadmap.id}/projects`);
  const tabs = page.getByRole('navigation', { name: 'Roadmap sections' });
  await expect(tabs.getByRole('link')).toHaveText(['Projects', 'Members', 'Snapshots', 'Audit log']);
  await tabs.getByRole('link', { name: 'Snapshots' }).click();
  await expect(page).toHaveURL(`/r/${roadmap.id}/snapshots`);
  await expect(page.getByRole('heading', { name: 'Snapshots', level: 1 })).toBeVisible();
  await expect(page.getByText(INTRO)).toBeVisible();
  await expect(page.getByText('No snapshots yet.')).toBeVisible();
  await expectNoA11yViolations(page);
  await expectNoSidewaysScroll(page);

  await page.getByRole('button', { name: 'Create snapshot' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a snapshot' });
  await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
  await expect(dialog.getByText('Only your team sees this name.')).toBeVisible();
  const asOf = dialog.getByLabel('As of', { exact: true });
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await expect(asOf).toHaveValue(today);
  await expect(asOf).toHaveAttribute('max', today);
  const password = dialog.getByLabel('Password', { exact: true });
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveAttribute('autocomplete', 'off');
  await expect(dialog.getByLabel('Never')).toBeChecked();
  await expect(dialog.getByLabel('Notes', { exact: true })).not.toBeChecked();
  await expect(dialog.getByLabel('Assignee names')).not.toBeChecked();
  await expectNoA11yViolations(page);

  // Refused first, with each message under its field.
  await dialog.getByRole('button', { name: 'Create snapshot' }).click();
  await expect(dialog.getByText('Enter a name.')).toBeVisible();
  await expect(dialog.getByText('Use at least 10 characters.')).toBeVisible();
  await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();

  await dialog.getByLabel('Name', { exact: true }).fill('Board pack');
  await password.fill('a long enough password');
  await dialog.getByLabel('Show password').check();
  await expect(password).toHaveAttribute('type', 'text');
  await dialog.getByLabel('Show password').uncheck();
  await expect(password).toHaveAttribute('type', 'password');
  await dialog.getByLabel('On a date').check();
  await expect(dialog.getByLabel('Expiry date')).toBeVisible();
  await expect(dialog.getByText('The link stops working at the end of this day.')).toBeVisible();
  await dialog.getByLabel('Never').check();
  await expect(dialog.getByLabel('Expiry date')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Create snapshot' }).click();

  const created = page.getByRole('dialog', { name: 'Snapshot created' });
  await expect(created.getByRole('heading', { name: 'Snapshot created' })).toBeFocused();
  await expect(created.getByText('Send this link to the people who should see it. Send the password separately.')).toBeVisible();
  const link = created.getByLabel('Link', { exact: true });
  const origin = new URL(page.url()).origin;
  await expect(link).toHaveValue(new RegExp(`^${origin}/s/[A-Za-z0-9_-]{32}$`));
  await expect(created.getByLabel('Password', { exact: true })).toHaveCount(0);
  await expectNoA11yViolations(page);
  await expectNoSidewaysScroll(page);

  await created.getByRole('button', { name: 'Copy link' }).click();
  await expect(created.getByRole('status')).toHaveText('Link copied.');
  const url = await link.inputValue();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await created.getByRole('button', { name: 'Done' }).click();
  await expect(created).toHaveCount(0);

  const card = cardOf(page, 'Board pack');
  await expect(cardsOf(page)).toHaveCount(1);
  await expect(card.getByText('Active', { exact: true })).toBeVisible();
  await expect(card.getByText(/^As of \d{1,2} [A-Z][a-z]{2} \d{4}$/)).toBeVisible();
  await expect(card.getByText(new RegExp(`^Created by ${owner.name} on \\d{1,2} [A-Z][a-z]{2} \\d{4}$`))).toBeVisible();
  await expect(card.getByText('No expiry')).toBeVisible();
  await expect(card.getByText('Not opened yet')).toBeVisible();
  await expect(card.getByText(/^Shows/)).toHaveCount(0);
  const open = card.getByRole('link', { name: 'Open Board pack' });
  await expect(open).toHaveAttribute('href', new URL(url).pathname);
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.getByText('No snapshots yet.')).toHaveCount(0);

  // The card copies the same link again.
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await card.getByRole('button', { name: 'Copy link to Board pack' }).click();
  await expect(card.getByRole('status')).toHaveText('Link copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);

  // Each action is a 44 by 44 px target.
  for (const action of [card.getByRole('button', { name: 'Copy link to Board pack' }), open, card.getByRole('button', { name: 'Revoke Board pack' })]) {
    const box = (await action.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await expectNoA11yViolations(page);
  await expectNoSidewaysScroll(page);
});

test("FR-3.2: revoking asks first, removes the card and moves focus to the next card's Copy link", async ({ page, call, roadmap }) => {
  for (const name of ['First', 'Second', 'Third']) await seedSnapshot(call, roadmap.id, name);
  await page.goto(`/r/${roadmap.id}/snapshots`);
  // Newest first.
  await expect(cardsOf(page).getByRole('heading')).toHaveText(['Third', 'Second', 'First']);

  await page.getByRole('button', { name: 'Revoke Second' }).click();
  const confirm = page.getByRole('dialog', { name: 'Revoke Second?' });
  await expect(confirm.getByText("The link stops working for everyone and the snapshot is deleted. This can't be undone.")).toBeVisible();
  await expectNoA11yViolations(page);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(cardsOf(page)).toHaveCount(3);

  await page.getByRole('button', { name: 'Revoke Second' }).click();
  await confirm.getByRole('button', { name: 'Revoke snapshot' }).click();
  await expect(cardsOf(page).getByRole('heading')).toHaveText(['Third', 'First']);
  await expect(page.getByRole('button', { name: 'Copy link to First' })).toBeFocused();

  // The last card: focus goes to the one before it.
  await page.getByRole('button', { name: 'Revoke First' }).click();
  await page.getByRole('dialog', { name: 'Revoke First?' }).getByRole('button', { name: 'Revoke snapshot' }).click();
  await expect(cardsOf(page).getByRole('heading')).toHaveText(['Third']);
  await expect(page.getByRole('button', { name: 'Copy link to Third' })).toBeFocused();

  // The only card: focus goes to Create snapshot.
  await page.getByRole('button', { name: 'Revoke Third' }).click();
  await page.getByRole('dialog', { name: 'Revoke Third?' }).getByRole('button', { name: 'Revoke snapshot' }).click();
  await expect(page.getByText('No snapshots yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create snapshot' })).toBeFocused();

  // Gone on the server too.
  expect((await call<{ snapshots: unknown[] }>('GET', `/api/roadmaps/${roadmap.id}/snapshots`)).snapshots).toEqual([]);
});

test('FR-3.1: a Contributor has no Snapshots tab, and the Snapshots address shows them what the Audit log address shows a Contributor', async ({
  browser,
  call,
  roadmap,
}) => {
  const guest = await joinByApi(browser, call, roadmap.id, 'contributor', 'reader');
  const p = guest.page;
  await p.goto(`/r/${roadmap.id}/projects`);
  const tabs = p.getByRole('navigation', { name: 'Roadmap sections' });
  await expect(tabs.getByRole('link')).toHaveText(['Projects', 'Members']);

  await p.goto(`/r/${roadmap.id}/audit`);
  await expect(p.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  await expect(p.getByRole('alert')).toHaveText('Only Owners and Admins can see the audit log.');

  await p.goto(`/r/${roadmap.id}/snapshots`);
  await expect(p.getByRole('heading', { name: 'Snapshots', level: 1 })).toBeVisible();
  await expect(p.getByRole('alert')).toHaveText('Only Owners and Admins can see snapshots.');
  await expect(p.getByRole('button', { name: 'Create snapshot' })).toHaveCount(0);
  await expectNoA11yViolations(p);
  await guest.context.close();
});

test('FR-3.1: the audit log shows "created a snapshot." and "revoked a snapshot."', async ({ page, call, owner, roadmap }) => {
  const { id } = await seedSnapshot(call, roadmap.id, 'Board pack');
  await call('DELETE', `/api/roadmaps/${roadmap.id}/snapshots/${id}`);

  await page.goto(`/r/${roadmap.id}/audit`);
  const log = page.getByRole('list', { name: 'Events' });
  await expect(log.getByRole('listitem').filter({ hasText: `${owner.name} created a snapshot.` })).toHaveCount(1);
  await expect(log.getByRole('listitem').filter({ hasText: `${owner.name} revoked a snapshot.` })).toHaveCount(1);
  // Never the snapshot's name.
  await expect(log).not.toContainText('Board pack');

  await field(page, 'Action').selectOption({ label: 'Snapshot created' });
  await expect(log.getByRole('listitem')).toHaveCount(1);
  await expect(log).toContainText('created a snapshot.');
  await field(page, 'Action').selectOption({ label: 'Snapshot revoked' });
  await expect(log.getByRole('listitem')).toHaveCount(1);
  await expect(log).toContainText('revoked a snapshot.');
  await expect(field(page, 'Action').locator('option')).toContainText(['Snapshot opened', 'Snapshot link locked']);
});
