import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.ts';

export interface ObjectStore {
  put(key: string, body: Buffer): Promise<void>;
  /** A link that downloads the object as `fileName` and stops working after `expiresSeconds`. */
  signedGetUrl(key: string, opts: { fileName: string; expiresSeconds: number }): Promise<string>;
  /** Missing keys are not an error. */
  deleteMany(keys: readonly string[]): Promise<void>;
}

/** How long a download link works. */
export const DOWNLOAD_SECONDS = 60;

const OCTET_STREAM = 'application/octet-stream';

/** RFC 5987 attr-chars that encodeURIComponent leaves alone but the extended value may not contain. */
function encodeExtValue(s: string): string {
  return encodeURIComponent(s).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Always a download: a printable-ASCII fallback name (accents dropped to the base letter, anything else that is
 * not printable ASCII replaced by `_`, `"` and `\` removed) and the exact name as UTF-8 in `filename*`.
 */
export function contentDisposition(fileName: string): string {
  const fallback =
    fileName
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/["\\]/g, '')
      .replace(/[^\x20-\x7e]/gu, '_')
      .trim() || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeExtValue(fileName)}`;
}

/** Path segments a key may use: letters, digits, `.`, `_` and `-`, never `.` or `..` on its own. */
const KEY_SEGMENT = /^[A-Za-z0-9._-]+$/;

function assertSafeKey(key: string): void {
  const segments = key.split('/');
  const ok = segments.every((s) => KEY_SEGMENT.test(s) && s !== '.' && s !== '..');
  if (!ok) throw new Error('invalid_key');
}

interface LinkClaims {
  key: string;
  fileName: string;
  /** Expiry, in milliseconds since the epoch. */
  exp: number;
}

/**
 * Signed download links for the stores that serve files through the API: `payload.mac`, where the payload is the
 * key, file name and expiry as base64url JSON and the mac is an HMAC-SHA-256 of the payload.
 */
class LinkSigner {
  readonly #key: Buffer;
  readonly #origin: string;
  readonly #now: () => Date;
  constructor(key: Buffer, origin: string, now: () => Date) {
    this.#key = key;
    this.#origin = origin;
    this.#now = now;
  }

  #mac(payload: string): Buffer {
    return createHmac('sha256', this.#key).update(payload).digest();
  }

  url(key: string, fileName: string, expiresSeconds: number): string {
    const claims: LinkClaims = { key, fileName, exp: this.#now().getTime() + expiresSeconds * 1000 };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const token = `${payload}.${this.#mac(payload).toString('base64url')}`;
    return `${this.#origin}/api/files/local?token=${token}`;
  }

  /** The claims of a token this signer made and that has not expired, or null. */
  verify(token: string): LinkClaims | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, mac] = parts as [string, string];
    const sent = Buffer.from(mac, 'base64url');
    // Compare against the canonical encoding too: base64url decoding ignores stray trailing bits.
    if (sent.toString('base64url') !== mac) return null;
    const expected = this.#mac(payload);
    if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) return null;
    let claims: LinkClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LinkClaims;
    } catch {
      return null;
    }
    if (typeof claims.exp !== 'number' || this.#now().getTime() >= claims.exp) return null;
    return claims;
  }
}

/** API tests: keeps objects in a map; links are signed with a random key made here. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  readonly #signer: LinkSigner;
  constructor(origin: string, now: () => Date = () => new Date()) {
    this.#signer = new LinkSigner(randomBytes(32), origin, now);
  }
  put(key: string, body: Buffer): Promise<void> {
    assertSafeKey(key);
    this.objects.set(key, Buffer.from(body));
    return Promise.resolve();
  }
  signedGetUrl(key: string, opts: { fileName: string; expiresSeconds: number }): Promise<string> {
    return Promise.resolve(this.#signer.url(key, opts.fileName, opts.expiresSeconds));
  }
  deleteMany(keys: readonly string[]): Promise<void> {
    for (const k of keys) this.objects.delete(k);
    return Promise.resolve();
  }
  /** The object and its download name for a valid, unexpired link token, or null. */
  read(token: string): Promise<{ body: Buffer; fileName: string } | null> {
    const claims = this.#signer.verify(token);
    const body = claims ? this.objects.get(claims.key) : undefined;
    return Promise.resolve(claims && body ? { body, fileName: claims.fileName } : null);
  }
}

/** Local and E2E runs: one file per object under `dir`; the API serves the links itself. */
export class LocalObjectStore implements ObjectStore {
  readonly #dir: string;
  readonly #signer: LinkSigner;
  constructor(dir: string, signingKey: Buffer, origin: string, now: () => Date = () => new Date()) {
    this.#dir = resolve(dir);
    this.#signer = new LinkSigner(signingKey, origin, now);
  }

  /** The file for a key, which must stay inside the folder. */
  #path(key: string): string {
    assertSafeKey(key);
    const path = join(this.#dir, ...key.split('/'));
    if (!path.startsWith(this.#dir + sep)) throw new Error('invalid_key');
    return path;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  signedGetUrl(key: string, opts: { fileName: string; expiresSeconds: number }): Promise<string> {
    return Promise.resolve(this.#signer.url(key, opts.fileName, opts.expiresSeconds));
  }
  async deleteMany(keys: readonly string[]): Promise<void> {
    for (const k of keys) await rm(this.#path(k), { force: true });
  }
  /** The object and its download name for a valid, unexpired link token, or null. */
  async read(token: string): Promise<{ body: Buffer; fileName: string } | null> {
    const claims = this.#signer.verify(token);
    if (!claims || typeof claims.key !== 'string') return null;
    try {
      return { body: await readFile(this.#path(claims.key)), fileName: claims.fileName };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}

/** S3 allows at most this many keys in one DeleteObjects call. */
const DELETE_BATCH = 1000;

/** Production: S3 with KMS encryption; downloads are pre-signed links straight to S3. */
export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #sse: boolean;
  readonly #now: () => Date;
  /**
   * `serverSideEncryption: false` is for MinIO in tests, which has no KMS key. `now` is the time links are signed
   * at, so a test can make a link that has already expired.
   */
  constructor(client: S3Client, bucket: string, opts: { serverSideEncryption?: boolean; now?: () => Date } = {}) {
    this.#client = client;
    this.#bucket = bucket;
    this.#sse = opts.serverSideEncryption ?? true;
    this.#now = opts.now ?? (() => new Date());
  }
  async put(key: string, body: Buffer): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentType: OCTET_STREAM,
        ...(this.#sse && { ServerSideEncryption: 'aws:kms' as const }),
      }),
    );
  }
  signedGetUrl(key: string, opts: { fileName: string; expiresSeconds: number }): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.#bucket,
      Key: key,
      ResponseContentDisposition: contentDisposition(opts.fileName),
      ResponseContentType: OCTET_STREAM,
    });
    return getSignedUrl(this.#client, command, { expiresIn: opts.expiresSeconds, signingDate: this.#now() });
  }
  async deleteMany(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      const out = await this.#client.send(
        new DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      const failed = out.Errors ?? [];
      if (failed.length > 0) {
        throw new Error(`delete_failed: ${failed.map((e) => `${e.Key ?? '?'} ${e.Code ?? '?'}`).join(', ')}`);
      }
    }
  }
}

export function createObjectStore(
  config: Pick<Config, 'files' | 'appOrigin' | 'awsRegion' | 's3Bucket' | 's3Endpoint' | 'filesDir' | 'filesSigningKey'>,
): ObjectStore {
  switch (config.files) {
    case 'memory':
      return new MemoryObjectStore(config.appOrigin);
    case 'local':
      if (!config.filesDir || !config.filesSigningKey) throw new Error('FILES=local needs FILES_DIR and FILES_SIGNING_KEY');
      return new LocalObjectStore(config.filesDir, config.filesSigningKey, config.appOrigin);
    case 's3': {
      if (!config.s3Bucket) throw new Error('FILES=s3 needs S3_BUCKET');
      const client = new S3Client({
        region: config.awsRegion,
        ...(config.s3Endpoint && { endpoint: config.s3Endpoint, forcePathStyle: true }),
      });
      return new S3ObjectStore(client, config.s3Bucket);
    }
  }
}
