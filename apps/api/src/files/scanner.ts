import { connect } from 'node:net';
import type { Config } from '../config.ts';

export type ScanResult = { clean: true } | { clean: false; signature: string };

/** The scanner could not give an answer: unreachable, too slow, cut off, or an error reply. Fail closed. */
export class ScanUnavailableError extends Error {
  constructor(message = 'scan_unavailable', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ScanUnavailableError';
  }
}

export interface Scanner {
  scan(body: Buffer): Promise<ScanResult>;
}

/** The standard antivirus test string, in two halves so no scanner flags this source file. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Local, test and E2E runs: knows only the test string, and can be told to act as if clamd were down. */
export class FakeScanner implements Scanner {
  scan(body: Buffer): Promise<ScanResult> {
    if (body.includes('SCANNER-DOWN')) return Promise.reject(new ScanUnavailableError('scanner_down'));
    if (body.includes(EICAR)) return Promise.resolve({ clean: false, signature: 'Eicar-Test-Signature' });
    return Promise.resolve({ clean: true });
  }
}

/** Bytes per INSTREAM chunk. */
export const CLAMD_CHUNK_BYTES = 64 * 1024;

function lengthPrefix(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** Reads the verdict from clamd's reply to a z-prefixed (zero-terminated) INSTREAM. */
function verdict(reply: string): ScanResult {
  if (reply === 'stream: OK') return { clean: true };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found) return { clean: false, signature: found[1]! };
  throw new ScanUnavailableError(`clamd_reply: ${reply.slice(0, 200)}`);
}

/** Production: clamd's INSTREAM command over TCP. Any answer but a clean or infected verdict throws. */
export class ClamdScanner implements Scanner {
  readonly #opts: { host: string; port: number; timeoutMs: number };
  constructor(opts: { host: string; port: number; timeoutMs: number }) {
    this.#opts = { ...opts };
  }

  scan(body: Buffer): Promise<ScanResult> {
    const { host, port, timeoutMs } = this.#opts;
    return new Promise<ScanResult>((resolvePromise, rejectPromise) => {
      const socket = connect({ host, port });
      let reply = Buffer.alloc(0);
      let settled = false;
      const finish = (outcome: () => ScanResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        try {
          resolvePromise(outcome());
        } catch (err) {
          rejectPromise(err instanceof ScanUnavailableError ? err : new ScanUnavailableError('scan_failed', { cause: err }));
        }
      };
      const fail = (message: string, cause?: unknown) =>
        finish(() => {
          throw new ScanUnavailableError(message, { cause });
        });

      const timer = setTimeout(() => fail('scan_timeout'), timeoutMs);

      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < body.length; i += CLAMD_CHUNK_BYTES) {
          const chunk = body.subarray(i, i + CLAMD_CHUNK_BYTES);
          socket.write(lengthPrefix(chunk.length));
          socket.write(chunk);
        }
        socket.write(lengthPrefix(0));
      });
      socket.on('data', (d: Buffer) => {
        reply = Buffer.concat([reply, d]);
        const end = reply.indexOf(0);
        if (end !== -1) finish(() => verdict(reply.subarray(0, end).toString('utf8').trim()));
      });
      socket.on('error', (err) => fail('scan_connection_error', err));
      socket.on('close', () => fail('scan_connection_closed'));
    });
  }
}

export function createScanner(config: Pick<Config, 'scanner' | 'clamdHost' | 'clamdPort' | 'scanTimeoutMs'>): Scanner {
  switch (config.scanner) {
    case 'fake':
      return new FakeScanner();
    case 'clamd':
      if (!config.clamdHost) throw new Error('SCANNER=clamd needs CLAMD_HOST');
      return new ClamdScanner({ host: config.clamdHost, port: config.clamdPort, timeoutMs: config.scanTimeoutMs });
  }
}
