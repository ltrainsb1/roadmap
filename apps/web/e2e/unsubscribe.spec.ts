import { apiAs, expectNoA11yViolations, readMails, seedProject, useCspGuard, waitForTwoWorkerPasses } from './helpers.ts';
import { expect, joinByApi, test } from './fixtures.ts';

useCspGuard();

/** The unsubscribe page's address, read from the footer of the last email to `to`. */
async function unsubscribeLinkIn(to: string, after: number): Promise<string> {
  for (let tries = 0; tries < 50; tries += 1) {
    const mails = await readMails(to);
    const last = mails[mails.length - 1];
    if (mails.length > after && last) {
      const link = /Turn off these emails: (\S+)/.exec(last.text)?.[1];
      if (link) return link;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no email with an unsubscribe link to ${to}`);
}

test('FR-5: the link in an email opens a page that turns every email off only when the button is pressed; the page passes axe', async ({
  browser,
  call,
  roadmap,
}) => {
  const member = await joinByApi(browser, call, roadmap.id, 'contributor', 'unsub');
  const m = member.page;
  const before = (await readMails(member.user.email)).length;
  const itemId = await seedProject(call, roadmap.id, 'Unsubscribe item');
  const { members } = await call<{ members: { userId: string; email: string }[] }>('GET', `/api/roadmaps/${roadmap.id}/members`);
  const userId = members.find((x) => x.email === member.user.email)!.userId;
  await call('PUT', `/api/roadmaps/${roadmap.id}/projects/${itemId}/assignees`, { userIds: [userId] });
  const link = await unsubscribeLinkIn(member.user.email, before);

  await m.goto(link);
  await expect(m.getByRole('heading', { level: 1, name: 'Turn off notification emails' })).toBeVisible();
  await expect(m.getByText("This turns off every notification email. You'll still see notifications in the app.")).toBeVisible();
  await expectNoA11yViolations(m);
  // Opening the link changed nothing.
  const prefs = () => apiAs(m).then((get) => get<{ prefs: Record<string, string> }>('GET', '/api/me/notification-prefs'));
  expect((await prefs()).prefs.assigned).toBe('instant');

  await m.getByRole('button', { name: 'Turn off emails' }).click();
  await expect(m.getByRole('status')).toHaveText('Emails are off. You can turn them back on in your notification settings.');
  await expectNoA11yViolations(m);
  expect(Object.values((await prefs()).prefs)).toEqual(['off', 'off', 'off', 'off']);
  await m.getByRole('link', { name: 'notification settings' }).click();
  await expect(m).toHaveURL('/settings/notifications');

  // A second assignment now sends nothing.
  const count = (await readMails(member.user.email)).length;
  const other = await seedProject(call, roadmap.id, 'Quiet item');
  await call('PUT', `/api/roadmaps/${roadmap.id}/projects/${other}/assignees`, { userIds: [userId] });
  await waitForTwoWorkerPasses();
  expect(await readMails(member.user.email)).toHaveLength(count);
  await member.context.close();
});

test('FR-5: a link that does not work shows the bad-link text and passes axe', async ({ page }) => {
  await page.goto('/unsubscribe?t=not.a.token');
  await page.getByRole('button', { name: 'Turn off emails' }).click();
  await expect(page.getByRole('alert')).toHaveText("This link doesn't work. You can change your emails in your notification settings.");
  await expectNoA11yViolations(page);
  await page.goto('/unsubscribe');
  await expect(page.getByRole('alert')).toHaveText("This link doesn't work. You can change your emails in your notification settings.");
});
