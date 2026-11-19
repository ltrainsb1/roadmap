import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const API_PORT = 3100;
const WEB_PORT = 5173;

/** The environment the API and the bootstrap command run with; helpers.ts reads it back from E2E_API_ENV. */
function apiEnv(mongoUri: string, outbox: string): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PORT: String(API_PORT),
    MONGO_URI: mongoUri,
    MONGO_DB: 'roadmap_e2e',
    APP_ORIGIN: `http://localhost:${WEB_PORT}`,
    WEBAUTHN_RP_ID: 'localhost',
    TOTP_ENC_KEY: randomBytes(32).toString('base64'),
    MAILER: 'file',
    MAIL_OUTBOX_FILE: outbox,
    MAIL_FROM: 'no-reply@localhost',
    HIBP_ENABLED: 'false',
    // One IP runs the whole suite; the production limit of 10 a minute would trip it.
    AUTH_RATE_LIMIT_PER_MIN: '1000',
  };
}

/** MongoDB: Testcontainers when TEST_MONGO=container, otherwise an in-process replica set. */
async function startMongo(): Promise<{ uri: string; stop: () => Promise<void> }> {
  if (process.env.TEST_MONGO === 'container') {
    const { MongoDBContainer } = await import('@testcontainers/mongodb');
    const container = await new MongoDBContainer('mongo:8.0')
      .withUlimits({ nofile: { soft: 65536, hard: 65536 } })
      .start();
    return {
      uri: `mongodb://${container.getHost()}:${container.getMappedPort(27017)}/?directConnection=true`,
      stop: async () => void (await container.stop()),
    };
  }
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  return { uri: rs.getUri(), stop: async () => void (await rs.stop()) };
}

async function waitFor(url: string, child: ChildProcess, name: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited with code ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${name} did not become ready at ${url}`);
}

function start(name: string, cmd: string, args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(cmd, args, { cwd: repoRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[${name}] ${d.toString()}`));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[${name}] ${d.toString()}`));
  return child;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const mongo = await startMongo();
  const dir = mkdtempSync(path.join(tmpdir(), 'roadmap-e2e-'));
  const env = apiEnv(mongo.uri, path.join(dir, 'outbox.jsonl'));
  process.env.E2E_API_ENV = JSON.stringify(env);
  process.env.E2E_MAIL_OUTBOX = env.MAIL_OUTBOX_FILE;

  execFileSync('pnpm', ['--filter', '@roadmap/api', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  execFileSync('pnpm', ['--filter', '@roadmap/web', 'build'], { cwd: repoRoot, stdio: 'inherit' });

  const children: ChildProcess[] = [];
  const stopAll = async () => {
    for (const c of children) c.kill('SIGTERM');
    await mongo.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const api = start('api', 'node', ['apps/api/dist/server.js'], env);
    children.push(api);
    const web = start(
      'web',
      'pnpm',
      ['--filter', '@roadmap/web', 'exec', 'vite', 'preview', '--port', String(WEB_PORT), '--strictPort'],
      { API_ORIGIN: `http://127.0.0.1:${API_PORT}` },
    );
    children.push(web);
    await waitFor(`http://127.0.0.1:${API_PORT}/api/health`, api, 'api');
    // Through the preview server, so the /api proxy is checked too.
    await waitFor(`http://localhost:${WEB_PORT}/api/health`, web, 'web');
  } catch (err) {
    await stopAll();
    throw err;
  }
  return stopAll;
}
