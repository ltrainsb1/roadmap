import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import {
  createMailer,
  FileMailer,
  MemoryMailer,
  SesMailer,
  type SesLikeClient,
} from '../../src/mail/mailer.ts';
import { inviteEmail, resetEmail } from '../../src/mail/templates.ts';

const msg = (n: number) => ({ to: `u${n}@example.com`, subject: `Subject ${n}`, text: `text ${n}`, html: `<p>${n}</p>` });

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'roadmap-mailer-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const env = {
  NODE_ENV: 'test',
  MONGO_URI: 'mongodb://unused',
  APP_ORIGIN: 'https://roadmap.example.com',
  TOTP_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  MAIL_FROM: 'Roadmap <no-reply@roadmap.example.com>',
};

describe('mailers (FR-1)', () => {
  test('FileMailer appends one JSON line per send', async () => {
    const file = join(dir, 'outbox.jsonl');
    const mailer = new FileMailer(file);
    await mailer.send(msg(1));
    await mailer.send(msg(2));
    const lines = (await readFile(file, 'utf8')).split('\n');
    expect(lines.at(-1)).toBe('');
    const parsed = lines.slice(0, -1).map((l) => JSON.parse(l) as unknown);
    expect(parsed).toEqual([msg(1), msg(2)]);
  });

  test('MemoryMailer keeps what was sent, in order', async () => {
    const mailer = new MemoryMailer();
    await mailer.send(msg(1));
    await mailer.send(msg(2));
    expect(mailer.sent).toEqual([msg(1), msg(2)]);
  });

  test('SesMailer sends a SESv2 SendEmail with the sender, recipient, subject, text and html', async () => {
    const commands: Array<{ input: unknown }> = [];
    const client: SesLikeClient = { send: (c) => Promise.resolve(void commands.push(c)) };
    await new SesMailer(client, 'Roadmap <no-reply@roadmap.example.com>').send(msg(1));
    expect(commands).toHaveLength(1);
    expect(commands[0]!.input).toEqual({
      FromEmailAddress: 'Roadmap <no-reply@roadmap.example.com>',
      Destination: { ToAddresses: ['u1@example.com'] },
      Content: {
        Simple: {
          Subject: { Data: 'Subject 1', Charset: 'UTF-8' },
          Body: { Text: { Data: 'text 1', Charset: 'UTF-8' }, Html: { Data: '<p>1</p>', Charset: 'UTF-8' } },
        },
      },
    });
  });

  test('SesMailer lets a send failure reach the caller', async () => {
    const client: SesLikeClient = { send: async () => Promise.reject(new Error('ses_down')) };
    await expect(new SesMailer(client, 'a@b.c').send(msg(1))).rejects.toThrow('ses_down');
  });

  test('createMailer picks the mailer named in the config', () => {
    expect(createMailer(loadConfig({ ...env, MAILER: 'memory' }))).toBeInstanceOf(MemoryMailer);
    expect(createMailer(loadConfig({ ...env, MAILER: 'file', MAIL_OUTBOX_FILE: join(dir, 'x.jsonl') }))).toBeInstanceOf(FileMailer);
    expect(createMailer(loadConfig({ ...env, MAILER: 'ses' }))).toBeInstanceOf(SesMailer);
  });

  test('createMailer refuses the file mailer without an outbox file', () => {
    expect(() => createMailer(loadConfig({ ...env, MAILER: 'file' }))).toThrow(/MAIL_OUTBOX_FILE/);
  });
});

describe('email templates (FR-1)', () => {
  test('inviteEmail escapes HTML in every interpolated value', () => {
    const m = inviteEmail({
      roadmapName: '<script>alert(1)</script>',
      inviterName: 'Eve "the" <b>Admin</b> & co',
      url: 'https://x.example/invite/abc?a=1&b="2"',
    });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(m.html).not.toContain('<b>Admin</b>');
    expect(m.html).toContain('&amp; co');
    expect(m.html).toContain('&quot;2&quot;');
    expect(m.html).toContain('&amp;b=');
  });

  test('inviteEmail text is plain, and the subject has no line breaks even if a name does', () => {
    const m = inviteEmail({ roadmapName: 'Q3\r\nBcc: x@evil.example', inviterName: 'Sam', url: 'https://x.example/i/1' });
    expect(m.text).toContain('https://x.example/i/1');
    expect(m.text).toContain('Sam');
    expect(m.subject).not.toMatch(/[\r\n]/);
  });

  test('resetEmail carries the link and how long it lasts', () => {
    const m = resetEmail({ url: 'https://x.example/reset/tok?x=1&y=2', expiresInMinutes: 60 });
    expect(m.text).toContain('https://x.example/reset/tok?x=1&y=2');
    expect(m.text).toContain('60 minutes');
    expect(m.html).toContain('https://x.example/reset/tok?x=1&amp;y=2');
    expect(m.html).toContain('60 minutes');
    expect(m.subject).toBeTruthy();
  });
});
