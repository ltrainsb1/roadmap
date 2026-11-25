import { appendFile } from 'node:fs/promises';
import { DeleteSuppressedDestinationCommand, SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { Config } from '../config.ts';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Extra message headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
}

export interface Mailer {
  send(m: MailMessage): Promise<void>;
}

/** API tests: keeps what was sent. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  send(m: MailMessage): Promise<void> {
    this.sent.push(m);
    return Promise.resolve();
  }
}

/** End-to-end runs: one JSON object per line, so a test can read the mail a flow produced. */
export class FileMailer implements Mailer {
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
  }
  async send(m: MailMessage): Promise<void> {
    await appendFile(this.#path, `${JSON.stringify(m)}\n`, 'utf8');
  }
}

/** The part of the SESv2 client we use, so tests can stand in for it. */
export interface SesLikeClient {
  send(command: SendEmailCommand | DeleteSuppressedDestinationCommand): Promise<unknown>;
}

export class SesMailer implements Mailer {
  readonly #client: SesLikeClient;
  readonly #from: string;
  readonly #configurationSet: string | undefined;
  /** With a configuration set, SES reports bounces and complaints for what is sent (to SNS, then the worker's queue). */
  constructor(client: SesLikeClient, from: string, configurationSet?: string) {
    this.#client = client;
    this.#from = from;
    this.#configurationSet = configurationSet;
  }
  async send(m: MailMessage): Promise<void> {
    await this.#client.send(
      new SendEmailCommand({
        FromEmailAddress: this.#from,
        ...(this.#configurationSet && { ConfigurationSetName: this.#configurationSet }),
        Destination: { ToAddresses: [m.to] },
        Content: {
          Simple: {
            Subject: { Data: m.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: m.text, Charset: 'UTF-8' }, Html: { Data: m.html, Charset: 'UTF-8' } },
            ...(m.headers && { Headers: Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })) }),
          },
        },
      }),
    );
  }
}

/**
 * How long one SES call may take. Well under the worker's 5 minute claim on a row, so a hung send fails (and the row is
 * retried) before another worker could take the row over and send it too.
 */
export const SES_TIMEOUTS = { connectionTimeout: 5_000, requestTimeout: 30_000 } as const;

/** The real SESv2 client, with the timeouts above. */
export function createSesClient(config: Pick<Config, 'awsRegion'>): SesLikeClient {
  return new SESv2Client({ region: config.awsRegion, requestHandler: SES_TIMEOUTS });
}

export function createMailer(config: Pick<Config, 'mailer' | 'mailFrom' | 'mailOutboxFile' | 'awsRegion' | 'sesConfigurationSet'>): Mailer {
  switch (config.mailer) {
    case 'memory':
      return new MemoryMailer();
    case 'file':
      if (!config.mailOutboxFile) throw new Error('MAILER=file needs MAIL_OUTBOX_FILE');
      return new FileMailer(config.mailOutboxFile);
    case 'ses':
      return new SesMailer(createSesClient(config), config.mailFrom, config.sesConfigurationSet);
  }
}
