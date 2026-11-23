import type { Db } from '../db/client.ts';
import type { Mailer } from '../mail/mailer.ts';
import { sendDigests } from './digest.ts';
import { writeDueSoon } from './due-soon.ts';
import { errorText, sendInstant } from './instant.ts';

export interface WorkerDeps {
  db: Db;
  mailer: Mailer;
  now: () => Date;
  appOrigin: string;
  log: { info(o: object, msg: string): void; error(o: object, msg: string): void };
}

export interface PassCounts {
  sent: number;
  reminders: number;
  digests: number;
  failed: number;
}

/** One pass: instant sends, then due-soon reminders, then digests. Never throws: each step logs its own errors and the pass goes on. */
export async function runPass(deps: WorkerDeps): Promise<PassCounts> {
  const counts: PassCounts = { sent: 0, reminders: 0, digests: 0, failed: 0 };
  const steps: Array<[string, (d: WorkerDeps) => Promise<Partial<PassCounts>>]> = [
    ['instant', sendInstant],
    ['due_soon', writeDueSoon],
    ['digest', sendDigests],
  ];
  for (const [step, run] of steps) {
    try {
      const got = await run(deps);
      for (const k of Object.keys(got) as Array<keyof PassCounts>) counts[k] += got[k] ?? 0;
    } catch (err) {
      deps.log.error({ step, err: errorText(err) }, 'worker step failed');
    }
  }
  return counts;
}
