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
    });
    expect(c.mailOutboxFile).toBeUndefined();
  });

  test('rejects invalid values', () => {
    expect(() => loadConfig({ ...valid, PORT: 'abc', MAILER: 'smoke', APP_ORIGIN: 'nope' })).toThrow(
      /PORT[\s\S]*MAILER|APP_ORIGIN/,
    );
  });
});
