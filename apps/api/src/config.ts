import { isIP } from 'node:net';
import { z } from 'zod';
import { RENDER_TOKEN_MS } from './snapshots/access.ts';

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  mongoUri: string;
  mongoDb: string;
  appOrigin: string;
  webauthnRpId: string;
  webauthnRpName: string;
  totpEncKey: Buffer;
  /** HMAC key for the unsubscribe links in notification emails; the API and the worker share it. */
  unsubscribeKey: Buffer;
  mailer: 'ses' | 'file' | 'memory';
  mailFrom: string;
  mailOutboxFile?: string;
  awsRegion: string;
  /** SES configuration set that sends bounce and complaint events to SNS; set in production. */
  sesConfigurationSet?: string;
  /** The SQS queue those events land in; the worker reads it. */
  sesEventsQueueUrl?: string;
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
  /** Snapshot PDFs: the PDF service in production, a fake that returns a small PDF elsewhere. */
  pdf: 'service' | 'fake';
  /** The PDF service's base URL, e.g. http://pdf:3000. */
  pdfUrl?: string;
  /** How long the API waits for one PDF. */
  pdfTimeoutMs: number;
  /**
   * The address ranges of the one proxy in front of the API (Caddy's network to it). In production the API takes
   * the client address from X-Forwarded-For only when the connected peer is inside one of them. Required there.
   */
  trustedProxyCidrs: string[];
  /** How long the worker waits after one pass before the next. */
  workerIntervalMs: number;
  /** The file the worker touches after each pass; its health check reads the file's age. */
  workerHeartbeatFile: string;
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

/**
 * One CIDR (IPv4 or IPv6, with its prefix length), as text. A range wider than /8 (IPv4) or /32 (IPv6) is refused:
 * the proxy's network is never that big, and 0.0.0.0/0 or ::/0 would quietly trust every peer.
 */
function isCidr(text: string): boolean {
  const match = /^([^/]+)\/(\d{1,3})$/.exec(text);
  if (!match) return false;
  const version = isIP(match[1]!);
  const prefix = Number(match[2]);
  if (version === 4) return prefix >= 8 && prefix <= 32;
  return version === 6 && prefix >= 32 && prefix <= 128;
}

const cidrList = z.string().transform((v, ctx) => {
  const cidrs = v.split(',').map((c) => c.trim());
  const bad = cidrs.filter((c) => !isCidr(c));
  if (bad.length > 0) {
    ctx.addIssue({ code: 'custom', message: `must be CIDRs separated by commas, no wider than /8 (IPv4) or /32 (IPv6), e.g. 10.254.254.0/24 (not ${JSON.stringify(bad.join(','))})` });
    return z.NEVER;
  }
  return cidrs;
});

/** The settings the worker and the API share. The worker loads only these; later tasks add to this shape or to the API's. */
const workerShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MONGO_URI: z.string().min(1),
  MONGO_DB: z.string().min(1).default('roadmap'),
  // Only the origin counts (WebAuthn and CORS-style checks compare origins): a trailing slash or path is dropped.
  APP_ORIGIN: z.url({ protocol: /^https?$/ }).transform((v) => new URL(v).origin),
  UNSUBSCRIBE_KEY: key32,
  MAILER: z.enum(['ses', 'file', 'memory']).default('file'),
  MAIL_FROM: z.string().min(1).optional(),
  MAIL_OUTBOX_FILE: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  SES_CONFIGURATION_SET: z.string().min(1).optional(),
  SES_EVENTS_QUEUE_URL: z.string().min(1).optional(),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(100).default(30000),
  WORKER_HEARTBEAT_FILE: z.string().min(1).default('/tmp/worker-heartbeat'),
};

const workerSchema = z.object(workerShape);

const envSchema = z.object({
  ...workerShape,
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  WEBAUTHN_RP_NAME: z.string().min(1).default('Roadmap'),
  TOTP_ENC_KEY: key32,
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
  PDF: z.enum(['service', 'fake']).default('fake'),
  PDF_URL: z.url({ protocol: /^https?$/ }).optional(),
  PDF_TIMEOUT_MS: z.coerce.number().int().min(1).default(60000),
  TRUSTED_PROXY_CIDR: cidrList.optional(),
});

type Env = z.infer<typeof envSchema>;

/** Rules between variables: what each driver needs, and what production allows. */
function crossChecks(e: Env): string[] {
  const issues: string[] = [];
  if (e.FILES === 's3' && !e.S3_BUCKET) issues.push('S3_BUCKET: required when FILES=s3');
  if (e.FILES === 'local' && !e.FILES_DIR) issues.push('FILES_DIR: required when FILES=local');
  if (e.FILES === 'local' && !e.FILES_SIGNING_KEY) issues.push('FILES_SIGNING_KEY: required when FILES=local');
  if (e.SCANNER === 'clamd' && !e.CLAMD_HOST) issues.push('CLAMD_HOST: required when SCANNER=clamd');
  if (e.PDF === 'service' && !e.PDF_URL) issues.push('PDF_URL: required when PDF=service');
  // The render token the PDF service's browser carries must outlive the API's wait for that render.
  if (e.PDF_TIMEOUT_MS >= RENDER_TOKEN_MS) {
    issues.push(`PDF_TIMEOUT_MS: must be less than ${RENDER_TOKEN_MS}, the render token's lifetime (is ${e.PDF_TIMEOUT_MS})`);
  }
  if (e.NODE_ENV === 'production') {
    if (e.FILES !== 's3') issues.push(`FILES: must be s3 in production (is ${e.FILES})`);
    if (e.SCANNER !== 'clamd') issues.push(`SCANNER: must be clamd in production (is ${e.SCANNER})`);
    if (e.PDF !== 'service') issues.push(`PDF: must be service in production (is ${e.PDF})`);
    if (!e.TRUSTED_PROXY_CIDR) issues.push('TRUSTED_PROXY_CIDR: required in production');
  }
  return issues;
}

/** What the worker process needs: MongoDB, the mailer, the unsubscribe key and its own timing. No other API secrets, no file, scanner or PDF settings. */
export type WorkerConfig = Pick<
  Config,
  | 'nodeEnv'
  | 'mongoUri'
  | 'mongoDb'
  | 'appOrigin'
  | 'unsubscribeKey'
  | 'mailer'
  | 'mailFrom'
  | 'mailOutboxFile'
  | 'awsRegion'
  | 'sesConfigurationSet'
  | 'sesEventsQueueUrl'
  | 'workerIntervalMs'
  | 'workerHeartbeatFile'
>;

function parseOrThrow<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`),
    );
  }
  return parsed.data;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const e = parseOrThrow(workerSchema, env);
  return {
    nodeEnv: e.NODE_ENV,
    mongoUri: e.MONGO_URI,
    mongoDb: e.MONGO_DB,
    appOrigin: e.APP_ORIGIN,
    unsubscribeKey: e.UNSUBSCRIBE_KEY,
    mailer: e.MAILER,
    // Without WEBAUTHN_RP_ID (an API setting) the sender is on the app's own host, as the API's default is.
    mailFrom: e.MAIL_FROM ?? `no-reply@${new URL(e.APP_ORIGIN).hostname}`,
    ...(e.MAIL_OUTBOX_FILE ? { mailOutboxFile: e.MAIL_OUTBOX_FILE } : {}),
    awsRegion: e.AWS_REGION,
    ...(e.SES_CONFIGURATION_SET ? { sesConfigurationSet: e.SES_CONFIGURATION_SET } : {}),
    ...(e.SES_EVENTS_QUEUE_URL ? { sesEventsQueueUrl: e.SES_EVENTS_QUEUE_URL } : {}),
    workerIntervalMs: e.WORKER_INTERVAL_MS,
    workerHeartbeatFile: e.WORKER_HEARTBEAT_FILE,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const e = parseOrThrow(envSchema, env);
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
    unsubscribeKey: e.UNSUBSCRIBE_KEY,
    mailer: e.MAILER,
    mailFrom: e.MAIL_FROM ?? `no-reply@${rpId}`,
    ...(e.MAIL_OUTBOX_FILE ? { mailOutboxFile: e.MAIL_OUTBOX_FILE } : {}),
    awsRegion: e.AWS_REGION,
    ...(e.SES_CONFIGURATION_SET ? { sesConfigurationSet: e.SES_CONFIGURATION_SET } : {}),
    hibpEnabled: e.HIBP_ENABLED,
    authRateLimitPerMin: e.AUTH_RATE_LIMIT_PER_MIN,
    files: e.FILES,
    ...(e.FILES === 's3' && { s3Bucket: e.S3_BUCKET!, ...(e.S3_ENDPOINT && { s3Endpoint: e.S3_ENDPOINT }) }),
    ...(e.FILES === 'local' && { filesDir: e.FILES_DIR!, filesSigningKey: e.FILES_SIGNING_KEY! }),
    scanner: e.SCANNER,
    ...(e.SCANNER === 'clamd' && { clamdHost: e.CLAMD_HOST! }),
    clamdPort: e.CLAMD_PORT,
    scanTimeoutMs: e.SCAN_TIMEOUT_MS,
    pdf: e.PDF,
    ...(e.PDF === 'service' && { pdfUrl: e.PDF_URL! }),
    pdfTimeoutMs: e.PDF_TIMEOUT_MS,
    trustedProxyCidrs: e.TRUSTED_PROXY_CIDR ?? [],
    workerIntervalMs: e.WORKER_INTERVAL_MS,
    workerHeartbeatFile: e.WORKER_HEARTBEAT_FILE,
  };
}
