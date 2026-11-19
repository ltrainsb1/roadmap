import { z } from 'zod';

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  mongoUri: string;
  mongoDb: string;
  appOrigin: string;
  webauthnRpId: string;
  webauthnRpName: string;
  totpEncKey: Buffer;
  mailer: 'ses' | 'file' | 'memory';
  mailFrom: string;
  mailOutboxFile?: string;
  awsRegion: string;
  hibpEnabled: boolean;
  /** Requests per minute per IP on /api/auth/*. */
  authRateLimitPerMin: number;
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const boolString = z.enum(['true', 'false']).transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGO_URI: z.string().min(1),
  MONGO_DB: z.string().min(1).default('roadmap'),
  APP_ORIGIN: z.url(),
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  WEBAUTHN_RP_NAME: z.string().min(1).default('Roadmap'),
  TOTP_ENC_KEY: z.string().transform((v, ctx) => {
    const key = Buffer.from(v, 'base64');
    if (key.length !== 32) {
      ctx.addIssue({ code: 'custom', message: 'must be base64 that decodes to exactly 32 bytes' });
      return z.NEVER;
    }
    return key;
  }),
  MAILER: z.enum(['ses', 'file', 'memory']).default('file'),
  MAIL_FROM: z.string().min(1).optional(),
  MAIL_OUTBOX_FILE: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  HIBP_ENABLED: boolString.default(true),
  AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(10),
});

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const rpId = e.WEBAUTHN_RP_ID ?? new URL(e.APP_ORIGIN).hostname;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    mongoUri: e.MONGO_URI,
    mongoDb: e.MONGO_DB,
    appOrigin: e.APP_ORIGIN,
    webauthnRpId: rpId,
    webauthnRpName: e.WEBAUTHN_RP_NAME,
    totpEncKey: e.TOTP_ENC_KEY,
    mailer: e.MAILER,
    mailFrom: e.MAIL_FROM ?? `no-reply@${rpId}`,
    ...(e.MAIL_OUTBOX_FILE ? { mailOutboxFile: e.MAIL_OUTBOX_FILE } : {}),
    awsRegion: e.AWS_REGION,
    hibpEnabled: e.HIBP_ENABLED,
    authRateLimitPerMin: e.AUTH_RATE_LIMIT_PER_MIN,
  };
}
