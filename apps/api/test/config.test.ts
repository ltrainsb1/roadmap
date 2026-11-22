import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const key = Buffer.alloc(32, 7).toString('base64');
const valid = {
  NODE_ENV: 'test',
  PORT: '4000',
  MONGO_URI: 'mongodb://localhost:27017',
  MONGO_DB: 'rm',
  APP_ORIGIN: 'https://roadmap.example.com',
  WEBAUTHN_RP_ID: 'roadmap.example.com',
  WEBAUTHN_RP_NAME: 'Roadmap',
  TOTP_ENC_KEY: key,
  MAILER: 'file',
  MAIL_FROM: 'no-reply@roadmap.example.com',
  MAIL_OUTBOX_FILE: '/tmp/outbox.jsonl',
  AWS_REGION: 'eu-west-1',
  HIBP_ENABLED: 'false',
  FILES_DIR: '/var/roadmap/files',
  FILES_SIGNING_KEY: Buffer.alloc(32, 9).toString('base64'),
};

describe('loadConfig', () => {
  test('throws a ConfigError naming every missing key', () => {
    let err: unknown;
    try {
      loadConfig({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    expect(msg).toContain('MONGO_URI');
    expect(msg).toContain('APP_ORIGIN');
    expect(msg).toContain('TOTP_ENC_KEY');
  });

  test('rejects a TOTP_ENC_KEY that is not 32 bytes', () => {
    const short = Buffer.alloc(16).toString('base64');
    expect(() => loadConfig({ ...valid, TOTP_ENC_KEY: short })).toThrow(/TOTP_ENC_KEY/);
  });

  test('returns the typed config for a full valid env', () => {
    const c = loadConfig(valid);
    expect(c).toEqual({
      nodeEnv: 'test',
      port: 4000,
      mongoUri: 'mongodb://localhost:27017',
      mongoDb: 'rm',
      appOrigin: 'https://roadmap.example.com',
      webauthnRpId: 'roadmap.example.com',
      webauthnRpName: 'Roadmap',
      totpEncKey: Buffer.alloc(32, 7),
      mailer: 'file',
      mailFrom: 'no-reply@roadmap.example.com',
      mailOutboxFile: '/tmp/outbox.jsonl',
      awsRegion: 'eu-west-1',
      hibpEnabled: false,
      authRateLimitPerMin: 10,
      files: 'local',
      filesDir: '/var/roadmap/files',
      filesSigningKey: Buffer.alloc(32, 9),
      scanner: 'fake',
      clamdPort: 3310,
      scanTimeoutMs: 30000,
    });
  });

  test('applies defaults and derives the RP id from APP_ORIGIN', () => {
    const c = loadConfig({
      MONGO_URI: 'mongodb://x',
      APP_ORIGIN: 'https://app.example.org',
      TOTP_ENC_KEY: key,
      FILES_DIR: '/data/files',
      FILES_SIGNING_KEY: key,
    });
    expect(c).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      mongoDb: 'roadmap',
      webauthnRpId: 'app.example.org',
      mailer: 'file',
      mailFrom: 'no-reply@app.example.org',
      hibpEnabled: true,
      authRateLimitPerMin: 10,
      files: 'local',
      scanner: 'fake',
      clamdPort: 3310,
      scanTimeoutMs: 30000,
    });
    expect(c.mailOutboxFile).toBeUndefined();
  });

  test('AUTH_RATE_LIMIT_PER_MIN overrides the default of 10 and must be a positive integer', () => {
    expect(loadConfig({ ...valid, AUTH_RATE_LIMIT_PER_MIN: '1000' }).authRateLimitPerMin).toBe(1000);
    expect(() => loadConfig({ ...valid, AUTH_RATE_LIMIT_PER_MIN: '0' })).toThrow(/AUTH_RATE_LIMIT_PER_MIN/);
  });

  test('APP_ORIGIN keeps only the origin: a trailing slash or a path is dropped', () => {
    expect(loadConfig({ ...valid, APP_ORIGIN: 'https://roadmap.example.com/' }).appOrigin).toBe('https://roadmap.example.com');
    expect(loadConfig({ ...valid, APP_ORIGIN: 'https://roadmap.example.com:8443/app/x?y=1' }).appOrigin).toBe(
      'https://roadmap.example.com:8443',
    );
    expect(loadConfig({ ...valid, APP_ORIGIN: 'http://localhost:5173' }).appOrigin).toBe('http://localhost:5173');
  });

  test('APP_ORIGIN must be http or https', () => {
    for (const origin of ['ftp://roadmap.example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'ws://roadmap.example.com']) {
      expect(() => loadConfig({ ...valid, APP_ORIGIN: origin }), origin).toThrow(/APP_ORIGIN/);
    }
  });

  test('rejects invalid values', () => {
    expect(() => loadConfig({ ...valid, PORT: 'abc', MAILER: 'smoke', APP_ORIGIN: 'nope' })).toThrow(
      /PORT[\s\S]*MAILER|APP_ORIGIN/,
    );
  });
});

describe('loadConfig: files and scanner (FR-1.4)', () => {
  const noFiles = { ...valid, FILES_DIR: undefined, FILES_SIGNING_KEY: undefined };
  const production = {
    ...noFiles,
    NODE_ENV: 'production',
    FILES: 's3',
    S3_BUCKET: 'roadmap-files',
    SCANNER: 'clamd',
    CLAMD_HOST: 'clamav',
  };

  test('FILES=local needs FILES_DIR and FILES_SIGNING_KEY', () => {
    expect(() => loadConfig({ ...valid, FILES: 'local', FILES_DIR: undefined })).toThrow(/FILES_DIR/);
    expect(() => loadConfig({ ...valid, FILES: 'local', FILES_SIGNING_KEY: undefined })).toThrow(/FILES_SIGNING_KEY/);
    // local is the default, so leaving FILES out needs them too
    expect(() => loadConfig(noFiles)).toThrow(/FILES_DIR[\s\S]*FILES_SIGNING_KEY/);
  });

  test('FILES_SIGNING_KEY must be base64 of exactly 32 bytes', () => {
    const short = Buffer.alloc(16).toString('base64');
    expect(() => loadConfig({ ...valid, FILES_SIGNING_KEY: short })).toThrow(/FILES_SIGNING_KEY/);
  });

  test('FILES=s3 needs S3_BUCKET; S3_ENDPOINT is optional and must be a URL', () => {
    expect(() => loadConfig({ ...noFiles, FILES: 's3' })).toThrow(/S3_BUCKET/);
    const c = loadConfig({ ...noFiles, FILES: 's3', S3_BUCKET: 'b' });
    expect(c).toMatchObject({ files: 's3', s3Bucket: 'b' });
    expect(c.s3Endpoint).toBeUndefined();
    expect(c.filesDir).toBeUndefined();
    expect(loadConfig({ ...noFiles, FILES: 's3', S3_BUCKET: 'b', S3_ENDPOINT: 'http://minio:9000' }).s3Endpoint).toBe(
      'http://minio:9000',
    );
    expect(() => loadConfig({ ...noFiles, FILES: 's3', S3_BUCKET: 'b', S3_ENDPOINT: 'nope' })).toThrow(/S3_ENDPOINT/);
  });

  test('FILES=memory needs nothing else; an unknown FILES is refused', () => {
    expect(loadConfig({ ...noFiles, FILES: 'memory' }).files).toBe('memory');
    expect(() => loadConfig({ ...valid, FILES: 'ftp' })).toThrow(/FILES/);
  });

  test('SCANNER=clamd needs CLAMD_HOST; CLAMD_PORT and SCAN_TIMEOUT_MS have defaults', () => {
    expect(() => loadConfig({ ...valid, SCANNER: 'clamd' })).toThrow(/CLAMD_HOST/);
    expect(loadConfig({ ...valid, SCANNER: 'clamd', CLAMD_HOST: 'clamav' })).toMatchObject({
      scanner: 'clamd',
      clamdHost: 'clamav',
      clamdPort: 3310,
      scanTimeoutMs: 30000,
    });
    expect(
      loadConfig({ ...valid, SCANNER: 'clamd', CLAMD_HOST: 'h', CLAMD_PORT: '3311', SCAN_TIMEOUT_MS: '500' }),
    ).toMatchObject({ clamdPort: 3311, scanTimeoutMs: 500 });
    expect(() => loadConfig({ ...valid, CLAMD_PORT: '0' })).toThrow(/CLAMD_PORT/);
    expect(() => loadConfig({ ...valid, SCAN_TIMEOUT_MS: '0' })).toThrow(/SCAN_TIMEOUT_MS/);
    expect(() => loadConfig({ ...valid, SCANNER: 'none' })).toThrow(/SCANNER/);
  });

  test('production refuses any store but s3 and any scanner but clamd', () => {
    expect(loadConfig(production)).toMatchObject({ files: 's3', scanner: 'clamd' });
    for (const over of [
      { FILES: 'local', FILES_DIR: '/d', FILES_SIGNING_KEY: key },
      { FILES: 'memory' },
      { FILES: undefined, FILES_DIR: '/d', FILES_SIGNING_KEY: key },
    ]) {
      expect(() => loadConfig({ ...production, ...over }), JSON.stringify(over)).toThrow(ConfigError);
      expect(() => loadConfig({ ...production, ...over }), JSON.stringify(over)).toThrow(/FILES/);
    }
    for (const over of [{ SCANNER: 'fake' }, { SCANNER: undefined }]) {
      expect(() => loadConfig({ ...production, ...over }), JSON.stringify(over)).toThrow(ConfigError);
      expect(() => loadConfig({ ...production, ...over }), JSON.stringify(over)).toThrow(/SCANNER/);
    }
  });
});
