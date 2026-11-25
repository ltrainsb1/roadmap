import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PutObjectCommand, DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import {
  contentDisposition,
  createObjectStore,
  DOWNLOAD_SECONDS,
  LocalObjectStore,
  MemoryObjectStore,
  S3ObjectStore,
} from '../../src/files/object-store.ts';

const ORIGIN = 'https://roadmap.example.com';
const KEY = Buffer.alloc(32, 3);

function tokenOf(url: string): string {
  const u = new URL(url);
  expect(`${u.origin}${u.pathname}`).toBe(`${ORIGIN}/api/files/local`);
  return u.searchParams.get('token')!;
}

/** The same token with one character changed. */
function alter(token: string, at: number): string {
  const c = token[at] === 'A' ? 'B' : 'A';
  return token.slice(0, at) + c + token.slice(at + 1);
}

describe('contentDisposition (FR-1.4)', () => {
  const names = ['report.pdf', 'ré sumé".pdf', 'plan 🚀.md', 'a\\b\r\nc.txt', "it's (1)*.txt", '日本語'];

  test.each(names)('%j: attachment, a printable-ASCII fallback and a filename* that round-trips', (name) => {
    const h = contentDisposition(name);
    expect(h.startsWith('attachment;')).toBe(true);
    const m = /^attachment; filename="([^"]*)"; filename\*=UTF-8''(\S+)$/.exec(h);
    expect(m, h).not.toBeNull();
    const fallback = m![1]!;
    expect(fallback).toMatch(/^[\x20-\x7e]+$/);
    expect(fallback).not.toMatch(/["\\]/);
    // Only RFC 5987 attr-chars and percent escapes in the extended value.
    expect(m![2]).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
    expect(decodeURIComponent(m![2]!)).toBe(name);
  });

  test('plain names keep their ASCII fallback; accents fall back to the base letter', () => {
    expect(contentDisposition('report.pdf')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(contentDisposition('ré sumé".pdf')).toContain('filename="re sume.pdf"');
  });
});

describe('LocalObjectStore (FR-1.4)', () => {
  let dir: string;
  let now = new Date('2026-11-21T10:00:00Z');
  let store: LocalObjectStore;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'roadmap-files-'));
    store = new LocalObjectStore(dir, KEY, ORIGIN, () => now);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('put, then read through a signed link, returns the bytes and the name', async () => {
    await store.put('t1/r1/a1', Buffer.from('hello'));
    const url = await store.signedGetUrl('t1/r1/a1', { fileName: 'plan 🚀.md', expiresSeconds: DOWNLOAD_SECONDS });
    const got = await store.read(tokenOf(url));
    expect(got).toEqual({ body: Buffer.from('hello'), fileName: 'plan 🚀.md' });
  });

  test('a token changed in any one character is refused', async () => {
    await store.put('t1/r1/a2', Buffer.from('x'));
    const token = tokenOf(await store.signedGetUrl('t1/r1/a2', { fileName: 'x.txt', expiresSeconds: 60 }));
    for (const at of [0, Math.floor(token.length / 2), token.indexOf('.') + 1, token.length - 1]) {
      expect(await store.read(alter(token, at)), `at ${at}`).toBeNull();
    }
    expect(await store.read('')).toBeNull();
    expect(await store.read('no-dot')).toBeNull();
    expect(await store.read('a.b.c')).toBeNull();
  });

  test('a token signed with another key is refused', async () => {
    await store.put('t1/r1/a3', Buffer.from('x'));
    const other = new LocalObjectStore(dir, Buffer.alloc(32, 4), ORIGIN, () => now);
    const token = tokenOf(await other.signedGetUrl('t1/r1/a3', { fileName: 'x', expiresSeconds: 60 }));
    expect(await store.read(token)).toBeNull();
    expect(await other.read(token)).not.toBeNull();
  });

  test('an expired token is refused', async () => {
    await store.put('t1/r1/a4', Buffer.from('x'));
    const token = tokenOf(await store.signedGetUrl('t1/r1/a4', { fileName: 'x', expiresSeconds: 60 }));
    const start = now;
    try {
      now = new Date(start.getTime() + 59_000);
      expect(await store.read(token)).not.toBeNull();
      now = new Date(start.getTime() + 60_000);
      expect(await store.read(token)).toBeNull();
    } finally {
      now = start;
    }
  });

  test('a token for a deleted key is refused; deleting a missing key is not an error', async () => {
    await store.put('t1/r1/a5', Buffer.from('x'));
    await store.put('t1/r1/a6', Buffer.from('y'));
    const token = tokenOf(await store.signedGetUrl('t1/r1/a5', { fileName: 'x', expiresSeconds: 60 }));
    await store.deleteMany(['t1/r1/a5', 't1/r1/never']);
    await store.deleteMany([]);
    expect(await store.read(token)).toBeNull();
    const kept = tokenOf(await store.signedGetUrl('t1/r1/a6', { fileName: 'y', expiresSeconds: 60 }));
    expect((await store.read(kept))?.body).toEqual(Buffer.from('y'));
  });

  test('put refuses a key that could leave the folder', async () => {
    for (const key of ['../x', 't1/../../x', '..', 'a/./b', '/abs', 'a//b', '', 'a\\b', 'a/b/']) {
      await expect(store.put(key, Buffer.from('x')), key).rejects.toThrow(/invalid_key/);
    }
    expect(await readdir(dir)).toEqual(['t1']);
  });
});

describe('MemoryObjectStore (FR-1.4)', () => {
  test('keeps objects, signs links with its own random key, and honours expiry and deletes', async () => {
    let now = new Date('2026-11-21T10:00:00Z');
    const store = new MemoryObjectStore(ORIGIN, () => now);
    await store.put('k1', Buffer.from('bytes'));
    expect(store.objects.get('k1')).toEqual(Buffer.from('bytes'));
    const token = tokenOf(await store.signedGetUrl('k1', { fileName: 'f.txt', expiresSeconds: 1 }));
    expect(await store.read(token)).toEqual({ body: Buffer.from('bytes'), fileName: 'f.txt' });
    expect(await new MemoryObjectStore(ORIGIN, () => now).read(token)).toBeNull();
    expect(await store.read(alter(token, 3))).toBeNull();
    now = new Date(now.getTime() + 1000);
    expect(await store.read(token)).toBeNull();
    now = new Date('2026-11-21T10:00:00Z');
    await store.deleteMany(['k1', 'missing']);
    expect(store.objects.size).toBe(0);
    expect(await store.read(token)).toBeNull();
  });
});

describe('S3ObjectStore (FR-1.4)', () => {
  function client(): { s3: S3Client; sent: unknown[] } {
    const s3 = new S3Client({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'not-a-real-secret' },
    });
    const sent: unknown[] = [];
    s3.send = ((command: unknown) => {
      sent.push(command);
      return Promise.resolve({});
    }) as S3Client['send'];
    return { s3, sent };
  }

  test('put stores the bytes as octet-stream with KMS encryption', async () => {
    const { s3, sent } = client();
    await new S3ObjectStore(s3, 'roadmap-files').put('t/r/a', Buffer.from('x'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect((sent[0] as PutObjectCommand).input).toEqual({
      Bucket: 'roadmap-files',
      Key: 't/r/a',
      Body: Buffer.from('x'),
      ContentType: 'application/octet-stream',
      ServerSideEncryption: 'aws:kms',
    });
  });

  test('put leaves encryption unset when asked (MinIO in tests has no KMS)', async () => {
    const { s3, sent } = client();
    await new S3ObjectStore(s3, 'b', { serverSideEncryption: false }).put('k', Buffer.from('x'));
    expect((sent[0] as PutObjectCommand).input).not.toHaveProperty('ServerSideEncryption');
  });

  test('signedGetUrl forces a download as octet-stream and expires', async () => {
    const { s3 } = client();
    const url = new URL(
      await new S3ObjectStore(s3, 'roadmap-files').signedGetUrl('t/r/a', { fileName: 'plan 🚀.md', expiresSeconds: 60 }),
    );
    expect(url.pathname).toContain('t/r/a');
    expect(url.searchParams.get('response-content-disposition')).toBe(contentDisposition('plan 🚀.md'));
    expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream');
    expect(url.searchParams.get('response-cache-control')).toBe('private, no-store');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
  });

  test('signedGetUrl signs at the injected time', async () => {
    const { s3 } = client();
    const store = new S3ObjectStore(s3, 'b', { now: () => new Date('2026-11-21T10:00:00Z') });
    const url = new URL(await store.signedGetUrl('k', { fileName: 'f', expiresSeconds: 1 }));
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261121T100000Z');
  });

  test('deleteMany sends nothing for no keys, batches by 1000, and fails when S3 reports errors', async () => {
    const { s3, sent } = client();
    const store = new S3ObjectStore(s3, 'b');
    await store.deleteMany([]);
    expect(sent).toHaveLength(0);
    await store.deleteMany(Array.from({ length: 1001 }, (_, i) => `k${i}`));
    expect(sent).toHaveLength(2);
    const first = (sent[0] as DeleteObjectsCommand).input;
    expect(first).toMatchObject({ Bucket: 'b', Delete: { Quiet: true } });
    expect(first.Delete?.Objects).toHaveLength(1000);
    expect((sent[1] as DeleteObjectsCommand).input.Delete?.Objects).toEqual([{ Key: 'k1000' }]);

    s3.send = (() => Promise.resolve({ Errors: [{ Key: 'k', Code: 'AccessDenied' }] })) as S3Client['send'];
    await expect(store.deleteMany(['k'])).rejects.toThrow(/AccessDenied/);
  });
});

describe('createObjectStore (FR-1.4)', () => {
  const env = {
    NODE_ENV: 'test',
    MONGO_URI: 'mongodb://unused',
    APP_ORIGIN: ORIGIN,
    TOTP_ENC_KEY: KEY.toString('base64'),
    UNSUBSCRIBE_KEY: KEY.toString('base64'),
  };

  test('picks the store named in the config', () => {
    expect(createObjectStore(loadConfig({ ...env, FILES: 'memory' }))).toBeInstanceOf(MemoryObjectStore);
    expect(
      createObjectStore(loadConfig({ ...env, FILES: 'local', FILES_DIR: '/tmp/x', FILES_SIGNING_KEY: KEY.toString('base64') })),
    ).toBeInstanceOf(LocalObjectStore);
    expect(createObjectStore(loadConfig({ ...env, FILES: 's3', S3_BUCKET: 'b' }))).toBeInstanceOf(S3ObjectStore);
    expect(
      createObjectStore(loadConfig({ ...env, FILES: 's3', S3_BUCKET: 'b', S3_ENDPOINT: 'http://minio:9000' })),
    ).toBeInstanceOf(S3ObjectStore);
  });

  test('a local store built from config signs links for the app origin', async () => {
    const store = createObjectStore(
      loadConfig({ ...env, FILES: 'local', FILES_DIR: '/tmp/x', FILES_SIGNING_KEY: KEY.toString('base64') }),
    );
    expect(await store.signedGetUrl('k', { fileName: 'f', expiresSeconds: 60 })).toMatch(
      /^https:\/\/roadmap\.example\.com\/api\/files\/local\?token=/,
    );
  });
});
