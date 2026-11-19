import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
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
