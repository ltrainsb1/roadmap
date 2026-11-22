import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { S3ObjectStore } from '../../src/files/object-store.ts';
import { ClamdScanner, EICAR } from '../../src/files/scanner.ts';

/**
 * The drivers against the real services, started with Testcontainers. Each block runs only when its variable is
 * `container` (CI sets both); elsewhere they are skipped. Ports are mapped at random and reached through
 * `getHost()`, which honours TESTCONTAINERS_HOST_OVERRIDE for a remote Docker host.
 */

// MinIO's own images are no longer published on Docker Hub; this is the last Bitnami build, pinned.
const MINIO_IMAGE = 'bitnamilegacy/minio:2025.7.23-debian-12-r5';
const CLAMAV_IMAGE = 'clamav/clamav:1.4.7';
// Throwaway credentials for a container that lives for one test run.
const MINIO_USER = 'roadmap-test';
const MINIO_PASSWORD = 'roadmap-test-password';

describe.skipIf(process.env.TEST_S3 !== 'container')('S3ObjectStore against MinIO (FR-1.4)', () => {
  let container: StartedTestContainer | undefined;
  let s3: S3Client;
  const bucket = 'roadmap-files';

  beforeAll(async () => {
    const { GenericContainer, Wait } = await import('testcontainers');
    container = await new GenericContainer(MINIO_IMAGE)
      .withEnvironment({ MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASSWORD })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
      // A 2-vCPU CI runner, possibly pulling the image cold.
      .withStartupTimeout(180_000)
      .start();
    s3 = new S3Client({
      region: 'us-east-1',
      endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
      forcePathStyle: true,
      credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD },
    });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }, 240_000);
  afterAll(async () => {
    s3?.destroy();
    await container?.stop();
  });

  test('put, download through a signed link, refuse an expired link, delete', async () => {
    const store = new S3ObjectStore(s3, bucket, { serverSideEncryption: false });
    const body = Buffer.from('<html><script>not run</script></html>');
    await store.put('t/r/a1', body);

    const res = await fetch(await store.signedGetUrl('t/r/a1', { fileName: 'plan 🚀.html', expiresSeconds: 60 }));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');

    // A 1-second link signed a minute ago has already expired: no waiting in the test.
    const past = new S3ObjectStore(s3, bucket, { serverSideEncryption: false, now: () => new Date(Date.now() - 60_000) });
    const expired = await fetch(await past.signedGetUrl('t/r/a1', { fileName: 'x', expiresSeconds: 1 }));
    expect(expired.status).toBe(403);
    await expired.arrayBuffer();

    await store.deleteMany(['t/r/a1', 't/r/never-existed']);
    const gone = await fetch(await store.signedGetUrl('t/r/a1', { fileName: 'x', expiresSeconds: 60 }));
    expect(gone.status).toBe(404);
    await gone.arrayBuffer();
  });
});

describe.skipIf(process.env.TEST_CLAMAV !== 'container')('ClamdScanner against ClamAV (FR-1.4)', () => {
  let container: StartedTestContainer | undefined;
  let scanner: ClamdScanner;

  beforeAll(async () => {
    const { GenericContainer, Wait } = await import('testcontainers');
    // The image's own health check passes once freshclam has fetched signatures and clamd answers.
    container = await new GenericContainer(CLAMAV_IMAGE)
      .withExposedPorts(3310)
      .withWaitStrategy(Wait.forHealthCheck())
      // A 2-vCPU CI runner with a cold pull, and freshclam's first download of the signatures.
      .withStartupTimeout(300_000)
      .start();
    scanner = new ClamdScanner({ host: container.getHost(), port: container.getMappedPort(3310), timeoutMs: 30_000 });
  }, 360_000);
  afterAll(async () => {
    await container?.stop();
  });

  test('a clean buffer is clean', async () => {
    await expect(scanner.scan(Buffer.from('just some text'))).resolves.toEqual({ clean: true });
  });

  test('the EICAR test string is found', async () => {
    const r = await scanner.scan(Buffer.from(EICAR));
    expect(r.clean).toBe(false);
    expect(r.clean === false && r.signature).toMatch(/eicar/i);
  });

  test('a 20 MB buffer of zeros is clean', { timeout: 60_000 }, async () => {
    await expect(scanner.scan(Buffer.alloc(20 * 1024 * 1024))).resolves.toEqual({ clean: true });
  });
});
