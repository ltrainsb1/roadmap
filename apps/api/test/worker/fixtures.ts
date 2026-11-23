import type { EmailMode, NotificationDetail, NotificationPrefs, NotificationType } from '@roadmap/shared';
import { scoped } from '../../src/db/scoped.ts';
import type { NotificationDoc, ProjectDoc, UserDoc } from '../../src/db/types.ts';
import { MemoryMailer, type MailMessage, type Mailer } from '../../src/mail/mailer.ts';
import { notificationRow } from '../../src/notifications/outbox.ts';
import type { WorkerDeps } from '../../src/worker/run.ts';
import type { TestApp } from '../helpers.ts';

export const ORIGIN = 'http://localhost:5173';
export const FOOTER = `You get this email because of your notification settings. Change them: ${ORIGIN}/settings/notifications`;

/** A clock the test moves by hand. */
export function clock(iso: string): { now: () => Date; set(iso: string): void } {
  let at = new Date(iso);
  return {
    now: () => new Date(at),
    set(next: string) {
      at = new Date(next);
    },
  };
}

export interface LogLine {
  level: 'info' | 'error';
  o: object;
  msg: string;
}

/** The deps one worker pass needs, with the log kept for the test to read. */
export function workerDeps(
  t: TestApp,
  c: { now: () => Date },
  mailer: Mailer = new MemoryMailer(),
): WorkerDeps & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    db: t.db,
    mailer,
    now: c.now,
    appOrigin: ORIGIN,
    log: {
      info: (o, msg) => void lines.push({ level: 'info', o, msg }),
      error: (o, msg) => void lines.push({ level: 'error', o, msg }),
    },
    lines,
  };
}

/** Fails every send while `failing`, and counts the attempts. */
export class FlakyMailer implements Mailer {
  failing = true;
  attempts = 0;
  readonly sent: MailMessage[] = [];
  send(m: MailMessage): Promise<void> {
    this.attempts += 1;
    if (this.failing) return Promise.reject(new Error(`SES refused the message to ${m.to}`));
    this.sent.push(m);
    return Promise.resolve();
  }
}

/** A user with this name, zone and settings (only the given ones stored, as the settings route would). */
export async function person(
  t: TestApp,
  tenantId: string,
  o: { name?: string; timezone?: string; prefs?: Partial<NotificationPrefs> } = {},
): Promise<UserDoc> {
  const u = await t.seed.user(tenantId);
  const set: Partial<UserDoc> = { name: o.name ?? 'Sam Lee', timezone: o.timezone ?? 'UTC' };
  if (o.prefs) set.notificationPrefs = o.prefs;
  await scoped(t.db, tenantId).collection('users').updateOne({ _id: u._id }, { $set: set });
  return { ...u, ...set };
}

export async function setPref(t: TestApp, user: UserDoc, type: NotificationType, mode: EmailMode): Promise<void> {
  await scoped(t.db, user.tenantId)
    .collection('users')
    .updateOne({ _id: user._id }, { $set: { [`notificationPrefs.${type}`]: mode } });
}

/** One notification row, as the outbox writes it. */
export async function row(
  t: TestApp,
  tenantId: string,
  o: {
    roadmapId: string;
    userId: string;
    item: Pick<ProjectDoc, '_id' | 'title'>;
    type?: NotificationType;
    actorId?: string | null;
    detail?: NotificationDetail;
    now: Date;
  },
): Promise<NotificationDoc> {
  const doc = notificationRow({
    roadmapId: o.roadmapId,
    userId: o.userId,
    type: o.type ?? 'assigned',
    actorId: o.actorId === undefined ? null : o.actorId,
    item: o.item,
    detail: o.detail ?? { kind: 'assigned' },
    now: o.now,
  });
  return scoped(t.db, tenantId).collection('notifications').insertOne(doc);
}

export const dates: NotificationDetail = {
  kind: 'dates',
  before: { startDate: '2027-03-03', endDate: null },
  after: { startDate: '2027-03-03', endDate: '2027-04-28' },
};

export async function rowsFor(t: TestApp, user: UserDoc): Promise<NotificationDoc[]> {
  return scoped(t.db, user.tenantId).collection('notifications').find({ userId: user._id }, { sort: { _id: 1 } });
}

export const itemUrl = (roadmapId: string, projectId: string): string => `${ORIGIN}/r/${roadmapId}/projects/${projectId}`;
