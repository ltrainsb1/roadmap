import { writeFile } from 'node:fs/promises';
import { loadConfig } from './config.ts';
import { connectDb } from './db/client.ts';
import { ensureIndexes } from './db/indexes.ts';
import { createMailer } from './mail/mailer.ts';
import { passAndBeat, type WorkerDeps } from './worker/run.ts';

// The worker process: one pass, then a wait of WORKER_INTERVAL_MS, then the next, so two passes never overlap. Logs
// are JSON lines of counts and ids only (no email addresses, no note text).

const write = (level: 'info' | 'error', o: object, msg: string) =>
  void process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), msg, ...o })}\n`);
const log: WorkerDeps['log'] = { info: (o, msg) => write('info', o, msg), error: (o, msg) => write('error', o, msg) };

const config = loadConfig(process.env);
const { client, db } = await connectDb(config.mongoUri, config.mongoDb);
await ensureIndexes(db);
const deps: WorkerDeps = { db, mailer: createMailer(config), now: () => new Date(), appOrigin: config.appOrigin, log };

let stopping = false;
let wake: (() => void) | null = null;
const stop = (signal: string) => {
  if (!stopping) log.info({ signal }, 'stopping after the current pass');
  stopping = true;
  wake?.();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

log.info({ intervalMs: config.workerIntervalMs }, 'worker started');
while (!stopping) {
  await passAndBeat(deps, () => writeFile(config.workerHeartbeatFile, new Date().toISOString()));
  if (stopping) break;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, config.workerIntervalMs);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  wake = null;
}
await client.close();
log.info({}, 'worker stopped');
// The mail client may hold keep-alive sockets open; nothing is left to do.
process.exit(0);
