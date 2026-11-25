import type { Db } from '../db/client.ts';
import type { Mailer } from '../mail/mailer.ts';
import { sendDigests } from './digest.ts';
import { writeDueSoon } from './due-soon.ts';
import { errorText } from './claims.ts';
import { sendInstant } from './instant.ts';

export interface WorkerDeps {
  db: Db;
  mailer: Mailer;
  now: () => Date;
  appOrigin: string;
  /** Signs the unsubscribe link in each email. */
  unsubscribeKey: Buffer;
  log: { info(o: object, msg: string): void; error(o: object, msg: string): void };
}

export interface PassCounts {
  sent: number;
  reminders: number;
  digests: number;
  failed: number;
}

const STEPS: Array<[string, (d: WorkerDeps) => Promise<Partial<PassCounts>>]> = [
  ['instant', sendInstant],
  ['due_soon', writeDueSoon],
  ['digest', sendDigests],
];

async function runSteps(deps: WorkerDeps): Promise<{ counts: PassCounts; stepsFailed: number }> {
  const counts: PassCounts = { sent: 0, reminders: 0, digests: 0, failed: 0 };
  let stepsFailed = 0;
  for (const [step, run] of STEPS) {
    try {
      const got = await run(deps);
      for (const k of Object.keys(got) as Array<keyof PassCounts>) counts[k] += got[k] ?? 0;
    } catch (err) {
      stepsFailed += 1;
      deps.log.error({ step, err: errorText(err) }, 'worker step failed');
    }
  }
  return { counts, stepsFailed };
}

/** One pass: instant sends, then due-soon reminders, then digests. Never throws: each step logs its own errors and the pass goes on. */
export async function runPass(deps: WorkerDeps): Promise<PassCounts> {
  return (await runSteps(deps)).counts;
}

/**
 * One pass as the process runs it: logs the counts, then calls `beat` (which touches the heartbeat file). After a pass
 * in which every step failed (MongoDB unreachable, say) there is no heartbeat, so the health check sees the worker is
 * stuck.
 */
export async function passAndBeat(deps: WorkerDeps, beat: () => Promise<void>): Promise<PassCounts> {
  const started = deps.now().getTime();
  const { counts, stepsFailed } = await runSteps(deps);
  deps.log.info({ ...counts, ms: deps.now().getTime() - started }, 'pass done');
  if (stepsFailed === STEPS.length) {
    deps.log.error({ steps: stepsFailed }, 'every step failed; no heartbeat');
    return counts;
  }
  try {
    await beat();
  } catch (err) {
    deps.log.error({ err: errorText(err) }, 'heartbeat not written');
  }
  return counts;
}
