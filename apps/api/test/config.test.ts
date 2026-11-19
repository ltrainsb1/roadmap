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
    });
  });

  test('applies defaults and derives the RP id from APP_ORIGIN', () => {
    const c = loadConfig({
      MONGO_URI: 'mongodb://x',
      APP_ORIGIN: 'https://app.example.org',
      TOTP_ENC_KEY: key,
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
