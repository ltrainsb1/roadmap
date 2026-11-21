import { expect, test as base, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { apiAs, bootstrapUser, PASSWORD, readLastMail, totpFor, uniqueEmail, watchCsp, type TestUser } from './helpers.ts';

export { expect };

export type ApiCall = Awaited<ReturnType<typeof apiAs>>;

async function post<T>(request: APIRequestContext, path: string, data: unknown, csrfToken?: string): Promise<T> {
  const res = await request.post(path, { data, ...(csrfToken && { headers: { 'x-csrf-token': csrfToken } }) });
  expect(res.ok(), `POST ${path} answered ${res.status()}`).toBe(true);
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** Turns on an authenticator app for a session that is waiting to enroll; the session is fully signed in afterwards. */
async function enrollByApi(request: APIRequestContext, csrfToken: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  const { secret } = await post<{ secret: string }>(request, '/api/auth/totp/enroll/start', {}, csrfToken);
  const { recoveryCodes } = await post<{ recoveryCodes: string[] }>(request, '/api/auth/totp/enroll/confirm', { code: totpFor(secret) }, csrfToken);
  return { secret, recoveryCodes };
}

/** Creates an account through the bootstrap command and the API, and leaves `context` signed in as it. */
export async function signUpByApi(context: BrowserContext, label: string): Promise<TestUser> {
  const email = uniqueEmail(label);
  const name = `${label} user`;
  const { setupUrl } = await bootstrapUser(email, name);
  const token = new URL(setupUrl).pathname.split('/').pop()!;
  const request = context.request;
  await post(request, '/api/auth/password-reset/confirm', { token, password: PASSWORD });
  const { csrfToken } = await post<{ csrfToken: string }>(request, '/api/auth/login', { email, password: PASSWORD });
  const { secret, recoveryCodes } = await enrollByApi(request, csrfToken);
  return { email, name, secret, recoveryCodes };
}

/** Invites a new person to the roadmap and has them accept and enroll in a new browser context, all through the API. */
export async function joinByApi(
  browser: Browser,
  call: ApiCall,
  roadmapId: string,
  role: 'admin' | 'contributor',
  label: string,
): Promise<{ context: BrowserContext; page: Page; user: TestUser }> {
  const email = uniqueEmail(label);
  const name = `${label} user`;
  await call('POST', `/api/roadmaps/${roadmapId}/invites`, { email, role });
  const token = /\/invite\/([^\s/]+)/.exec((await readLastMail(email)).text)?.[1];
  expect(token, `invite link in the mail to ${email}`).toBeTruthy();

  const use = base.info().project.use;
  const context = await browser.newContext({
    ...(use.baseURL && { baseURL: use.baseURL }),
    ...(use.viewport && { viewport: use.viewport }),
    ...(use.isMobile !== undefined && { isMobile: use.isMobile }),
    ...(use.hasTouch !== undefined && { hasTouch: use.hasTouch }),
  });
  const page = await context.newPage();
  watchCsp(page);
  const { csrfToken } = await post<{ csrfToken: string }>(context.request, `/api/invites/${token}/accept`, { name, password: PASSWORD });
  const { secret, recoveryCodes } = await enrollByApi(context.request, csrfToken);
  return { context, page, user: { email, name, secret, recoveryCodes } };
}

export const test = base.extend<{ owner: TestUser; call: ApiCall; roadmap: { id: string; name: string } }>({
  owner: async ({ page }, use) => {
    await use(await signUpByApi(page.context(), 'owner'));
  },
  call: async ({ page, owner }, use) => {
    void owner;
    await use(await apiAs(page));
  },
  roadmap: async ({ call }, use) => {
    const name = 'Fixture plan';
    const { id } = await call<{ id: string }>('POST', '/api/roadmaps', { name });
    await use({ id, name });
  },
});
