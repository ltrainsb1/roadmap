import { parseArgs } from 'node:util';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { issueResetToken } from '../auth/reset-tokens.ts';
import { ConfigError, loadConfig, type Config } from '../config.ts';
import { connectDb, type Db } from '../db/client.ts';
import { ensureIndexes } from '../db/indexes.ts';
import { scoped } from '../db/scoped.ts';
import { unscoped } from '../db/unscoped.ts';

// This file and what it imports must not pull in @roadmap/shared: the built output runs where that
// workspace package is TypeScript source that Node will not load from node_modules.

export const SETUP_LINK_TTL_MS = 24 * 60 * 60_000;

export interface BootstrapInput {
  tenantName: string;
  email: string;
  name: string;
}

export interface BootstrapDeps {
  db: Db;
  config: Pick<Config, 'appOrigin'>;
  now?: () => Date;
}

const inputSchema = z.object({
  tenantName: z.string().trim().min(1).max(100),
  // Same normalisation as the shared emailSchema, which every sign-in lookup uses.
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  name: z.string().trim().min(1).max(100),
});

const isDuplicateKey = (err: unknown) => (err as { code?: number } | null)?.code === 11000;

/**
 * Creates a tenant and its first user, who has no password yet, and returns a 24 hour link that sets it.
 * There is no self-sign-up, so this is how the first Owner exists.
 */
export async function bootstrap(
  input: BootstrapInput,
  deps: BootstrapDeps,
): Promise<{ tenantId: string; userId: string; setupUrl: string }> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error('invalid_input');
  const { tenantName, email, name } = parsed.data;
  const now = deps.now ?? (() => new Date());
  const lookup = unscoped(deps.db);

  if (await lookup.findUserByEmail(email)) throw new Error('email_exists');

  const tenantId = uuidv7();
  const userId = uuidv7();
  await lookup.insertTenant({ _id: tenantId, name: tenantName, createdAt: now() });
  const s = scoped(deps.db, tenantId);
  try {
    await s.collection('users').insertOne({
      _id: userId,
      email,
      name,
      timezone: 'UTC',
      passwordHash: null,
      failedLogins: 0,
      lockedUntil: null,
      totp: null,
      pendingTotpSecretEnc: null,
      recoveryCodes: [],
      createdAt: now(),
    });
  } catch (err) {
    // Another run took the address between our check and the insert; the unique index is the real guard.
    if (isDuplicateKey(err)) throw new Error('email_exists', { cause: err });
    throw err;
  }
  const setupUrl = await issueResetToken(s, userId, SETUP_LINK_TTL_MS, { appOrigin: deps.config.appOrigin, now });
  return { tenantId, userId, setupUrl };
}

export interface Streams {
  stdout(s: string): void;
  stderr(s: string): void;
}

const USAGE = 'Usage: bootstrap --tenant <name> --email <email> --name <name>\n';

/** The command line wrapper: returns the exit code. */
export async function run(argv: string[], env: NodeJS.ProcessEnv, io: Streams): Promise<number> {
  let values: { tenant?: string; email?: string; name?: string };
  try {
    values = parseArgs({
      args: argv,
      options: { tenant: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' } },
      strict: true,
    }).values;
  } catch (err) {
    io.stderr(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (!values.tenant || !values.email || !values.name) {
    io.stderr(USAGE);
    return 2;
  }

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    io.stderr(`${err.message}\n`);
    return 2;
  }

  const { client, db } = await connectDb(config.mongoUri, config.mongoDb);
  try {
    await ensureIndexes(db);
    const { setupUrl } = await bootstrap({ tenantName: values.tenant, email: values.email, name: values.name }, { db, config });
    io.stdout(`${setupUrl}\n`);
    return 0;
  } catch (err) {
    io.stderr(`${(err as Error).message}\n`);
    return 1;
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), process.env, {
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
  });
}
