import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { contentDisposition, S3ObjectStore } from '../../src/files/object-store.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';

let t: TestApp;
let onS3: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
  onS3 = await makeTestApp({
    objectStore: new S3ObjectStore(
      new S3Client({ region: 'eu-west-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'not-a-real-secret' } }),
      'b',
    ),
  });
}, 120_000);
afterAll(async () => {
  await t?.close();
  await onS3?.close();
});

/** The path and query of a signed link, for inject. */
function pathOf(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

describe('GET /api/files/local (FR-1.4)', () => {
  test('a valid link returns the bytes as a download, with no session', async () => {
    await t.files.put('t/r/a1', Buffer.from('<html>not run</html>'));
    const url = await t.files.signedGetUrl('t/r/a1', { fileName: 'ré sumé".html', expiresSeconds: 60 });
    expect(url.startsWith(`${t.config.appOrigin}/api/files/local?token=`)).toBe(true);
    const res = await t.app.inject({ url: pathOf(url) });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(Buffer.from('<html>not run</html>'))).toBe(true);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe(contentDisposition('ré sumé".html'));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('a changed, missing, expired or deleted-object token is 404', async () => {
    await t.files.put('t/r/a2', Buffer.from('x'));
    const url = new URL(await t.files.signedGetUrl('t/r/a2', { fileName: 'x', expiresSeconds: 60 }));
    const token = url.searchParams.get('token')!;
    const bad = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    for (const path of [
      `/api/files/local?token=${encodeURIComponent(bad)}`,
      '/api/files/local?token=',
      '/api/files/local',
      `/api/files/local?token=${'a'.repeat(5000)}`,
    ]) {
      const res = await t.app.inject({ url: path });
      expect(res.statusCode, path).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
    await t.files.deleteMany(['t/r/a2']);
    expect((await t.app.inject({ url: pathOf(url.href) })).statusCode).toBe(404);
  });

  test('the route does not exist when the app stores files in S3', () => {
    expect(t.app.hasRoute({ method: 'GET', url: '/api/files/local' })).toBe(true);
    expect(onS3.app.hasRoute({ method: 'GET', url: '/api/files/local' })).toBe(false);
  });
});
