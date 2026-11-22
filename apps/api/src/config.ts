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
  /** Where attachments are kept: S3 in production, a folder for local and E2E runs, memory for API tests. */
  files: 's3' | 'local' | 'memory';
  s3Bucket?: string;
  /** An S3-compatible endpoint (MinIO); when set, requests use path-style addressing. */
  s3Endpoint?: string;
  filesDir?: string;
  /** HMAC key for the local store's download links. */
  filesSigningKey?: Buffer;
  /** Virus scanner: clamd in production, a fake that knows the EICAR test string elsewhere. */
  scanner: 'clamd' | 'fake';
  clamdHost?: string;
  clamdPort: number;
  scanTimeoutMs: number;
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

const key32 = z.string().transform((v, ctx) => {
  const key = Buffer.from(v, 'base64');
  if (key.length !== 32) {
    ctx.addIssue({ code: 'custom', message: 'must be base64 that decodes to exactly 32 bytes' });
    return z.NEVER;
  }
  return key;
});

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGO_URI: z.string().min(1),
  MONGO_DB: z.string().min(1).default('roadmap'),
  // Only the origin counts (WebAuthn and CORS-style checks compare origins): a trailing slash or path is dropped.
  APP_ORIGIN: z.url({ protocol: /^https?$/ }).transform((v) => new URL(v).origin),
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  WEBAUTHN_RP_NAME: z.string().min(1).default('Roadmap'),
  TOTP_ENC_KEY: key32,
  MAILER: z.enum(['ses', 'file', 'memory']).default('file'),
  MAIL_FROM: z.string().min(1).optional(),
  MAIL_OUTBOX_FILE: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  HIBP_ENABLED: boolString.default(true),
  AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(10),
  FILES: z.enum(['s3', 'local', 'memory']).default('local'),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  FILES_DIR: z.string().min(1).optional(),
  FILES_SIGNING_KEY: key32.optional(),
  SCANNER: z.enum(['clamd', 'fake']).default('fake'),
  CLAMD_HOST: z.string().min(1).optional(),
  CLAMD_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  SCAN_TIMEOUT_MS: z.coerce.number().int().min(1).default(30000),
});

type Env = z.infer<typeof envSchema>;

/** Rules between variables: what each driver needs, and what production allows. */
function crossChecks(e: Env): string[] {
  const issues: string[] = [];
  if (e.FILES === 's3' && !e.S3_BUCKET) issues.push('S3_BUCKET: required when FILES=s3');
  if (e.FILES === 'local' && !e.FILES_DIR) issues.push('FILES_DIR: required when FILES=local');
  if (e.FILES === 'local' && !e.FILES_SIGNING_KEY) issues.push('FILES_SIGNING_KEY: required when FILES=local');
  if (e.SCANNER === 'clamd' && !e.CLAMD_HOST) issues.push('CLAMD_HOST: required when SCANNER=clamd');
  if (e.NODE_ENV === 'production') {
    if (e.FILES !== 's3') issues.push(`FILES: must be s3 in production (is ${e.FILES})`);
    if (e.SCANNER !== 'clamd') issues.push(`SCANNER: must be clamd in production (is ${e.SCANNER})`);
  }
  return issues;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const issues = crossChecks(e);
  if (issues.length > 0) throw new ConfigError(issues);
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
    files: e.FILES,
    ...(e.FILES === 's3' && { s3Bucket: e.S3_BUCKET!, ...(e.S3_ENDPOINT && { s3Endpoint: e.S3_ENDPOINT }) }),
    ...(e.FILES === 'local' && { filesDir: e.FILES_DIR!, filesSigningKey: e.FILES_SIGNING_KEY! }),
    scanner: e.SCANNER,
    ...(e.SCANNER === 'clamd' && { clamdHost: e.CLAMD_HOST! }),
    clamdPort: e.CLAMD_PORT,
    scanTimeoutMs: e.SCAN_TIMEOUT_MS,
  };
}
