import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const API_PORT = 3100;
const WEB_PORT = 5173;
const PDF_PORT = 3200;

/** The environment the API and the bootstrap command run with; helpers.ts reads it back from E2E_API_ENV. */
function apiEnv(mongoUri: string, outbox: string, filesDir: string): Record<string, string> {
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
    FILES: 'local',
    FILES_DIR: filesDir,
    FILES_SIGNING_KEY: randomBytes(32).toString('base64'),
    SCANNER: 'fake',
    // The real PDF service, which prints the preview server's print pages with Chromium.
    PDF: 'service',
    PDF_URL: `http://127.0.0.1:${PDF_PORT}`,
    // One IP runs the whole suite; the production limit of 10 a minute would trip it, and so would 1000 once many specs create accounts.
    AUTH_RATE_LIMIT_PER_MIN: '10000',
  };
}

/** MongoDB: Testcontainers when TEST_MONGO=container, otherwise an in-process replica set. */
async function startMongo(): Promise<{ uri: string; stop: () => Promise<void> }> {
  if (process.env.TEST_MONGO === 'container') {
    const { MongoDBContainer } = await import('@testcontainers/mongodb');
    const container = await new MongoDBContainer('mongo:8.0')
      .withUlimits({ nofile: { soft: 65536, hard: 65536 } })
      .start();
    // Tests may run on a fixed clock in the past, so every expiresAt they write is already due in real time and
    // MongoDB's TTL monitor would delete sessions, reset tokens and challenges at an arbitrary moment mid-test.
    // Expiry is checked by the application code the tests exercise, so the monitor is switched off here only.
    const off = await container.exec([
      'mongosh',
      '--quiet',
      '--eval',
      'db.adminCommand({ setParameter: 1, ttlMonitorEnabled: false })',
    ]);
    if (off.exitCode !== 0) throw new Error(`could not disable the TTL monitor: ${off.output}`);
    return {
      uri: `mongodb://${container.getHost()}:${container.getMappedPort(27017)}/?directConnection=true`,
      stop: async () => void (await container.stop()),
    };
  }
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  // Same reason as the container above: no TTL sweeps of expiresAt values written under a fake clock.
  const rs = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--setParameter', 'ttlMonitorEnabled=false'] }],
  });
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

function start(name: string, cmd: string, args: string[], env: Record<string, string>, cwd = repoRoot): ChildProcess {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[${name}] ${d.toString()}`));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[${name}] ${d.toString()}`));
  return child;
}

/** SIGTERM, then SIGKILL if the process has not exited after `graceMs`; resolves once it is gone. */
async function stopChild(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  await exited;
  clearTimeout(timer);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // Builds first: a broken build then starts nothing that needs cleaning up.
  execFileSync('pnpm', ['--filter', '@roadmap/api', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  execFileSync('pnpm', ['--filter', '@roadmap/web', 'build'], { cwd: repoRoot, stdio: 'inherit' });

  const children: ChildProcess[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  // Every step runs even when an earlier one throws; the first failure is rethrown afterwards.
  const stopAll = async () => {
    const failures: unknown[] = [];
    for (const step of [...children.map((c) => () => stopChild(c)), ...cleanups]) {
      try {
        await step();
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length > 0) throw failures[0];
  };

  try {
    const mongo = await startMongo();
    cleanups.push(mongo.stop);
    const dir = mkdtempSync(path.join(tmpdir(), 'roadmap-e2e-'));
    cleanups.push(() => Promise.resolve(rmSync(dir, { recursive: true, force: true })));
    const env = apiEnv(mongo.uri, path.join(dir, 'outbox.jsonl'), path.join(dir, 'files'));
    process.env.E2E_API_ENV = JSON.stringify(env);
    process.env.E2E_MAIL_OUTBOX = env.MAIL_OUTBOX_FILE;

    const api = start('api', 'node', ['apps/api/dist/server.js'], env);
    children.push(api);
    // The vite binary directly: killing a pnpm wrapper can leave the server it started holding the port.
    const web = start(
      'web',
      path.join(repoRoot, 'apps/web/node_modules/.bin/vite'),
      ['preview', '--port', String(WEB_PORT), '--strictPort'],
      { API_ORIGIN: `http://127.0.0.1:${API_PORT}` },
      path.join(repoRoot, 'apps/web'),
    );
    children.push(web);
    // Node directly, for the same reason as vite. It launches the Chromium Playwright installed (the same pinned
    // version), with its sandbox on, and opens only the preview server's origin.
    const pdf = start(
      'pdf',
      'node',
      ['--experimental-strip-types', 'src/server.ts'],
      { PORT: String(PDF_PORT), RENDER_ORIGIN: `http://localhost:${WEB_PORT}` },
      path.join(repoRoot, 'apps/pdf'),
    );
    children.push(pdf);
    await waitFor(`http://127.0.0.1:${API_PORT}/api/health`, api, 'api');
    // Through the preview server, so the /api proxy is checked too.
    await waitFor(`http://localhost:${WEB_PORT}/api/health`, web, 'web');
    await waitFor(`http://127.0.0.1:${PDF_PORT}/health`, pdf, 'pdf');
  } catch (err) {
    await stopAll().catch(() => undefined);
    throw err;
  }
  return stopAll;
}
