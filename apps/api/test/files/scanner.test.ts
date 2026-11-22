import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import {
  CLAMD_CHUNK_BYTES,
  ClamdScanner,
  createScanner,
  EICAR,
  FakeScanner,
  ScanUnavailableError,
} from '../../src/files/scanner.ts';

/** A stand-in clamd: `onData` sees everything received so far and may answer or close the socket. */
interface FakeClamd {
  port: number;
  received: () => Buffer;
}

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function fakeClamd(onData: (all: Buffer, socket: Socket) => void): Promise<FakeClamd> {
  let all = Buffer.alloc(0);
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    socket.on('data', (d: Buffer) => {
      all = Buffer.concat([all, d]);
      onData(all, socket);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as AddressInfo).port, received: () => all };
}

/** True once the stream's terminating zero-length chunk has arrived. */
function ended(all: Buffer): boolean {
  return all.length >= 14 && all.subarray(-4).equals(Buffer.alloc(4));
}

function scanner(port: number, timeoutMs = 2000): ClamdScanner {
  return new ClamdScanner({ host: '127.0.0.1', port, timeoutMs });
}

describe('ClamdScanner (FR-1.4)', () => {
  test('stream: OK is clean', async () => {
    const clamd = await fakeClamd((all, s) => ended(all) && s.end('stream: OK\0'));
    await expect(scanner(clamd.port).scan(Buffer.from('hello'))).resolves.toEqual({ clean: true });
  });

  test('stream: <signature> FOUND is not clean and names the signature', async () => {
    const clamd = await fakeClamd((all, s) => ended(all) && s.end('stream: Win.Test.EICAR_HDB-1 FOUND\0'));
    await expect(scanner(clamd.port).scan(Buffer.from('x'))).resolves.toEqual({
      clean: false,
      signature: 'Win.Test.EICAR_HDB-1',
    });
  });

  test('sends zINSTREAM, length-prefixed chunks and four zero bytes', async () => {
    const body = Buffer.alloc(CLAMD_CHUNK_BYTES * 2 + 10);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    const clamd = await fakeClamd((all, s) => all.length >= 10 + body.length + 3 * 4 + 4 && s.end('stream: OK\0'));
    await expect(scanner(clamd.port).scan(body)).resolves.toEqual({ clean: true });

    const len = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(n);
      return b;
    };
    const expected = Buffer.concat([
      Buffer.from('zINSTREAM\0'),
      len(CLAMD_CHUNK_BYTES),
      body.subarray(0, CLAMD_CHUNK_BYTES),
      len(CLAMD_CHUNK_BYTES),
      body.subarray(CLAMD_CHUNK_BYTES, CLAMD_CHUNK_BYTES * 2),
      len(10),
      body.subarray(CLAMD_CHUNK_BYTES * 2),
      Buffer.alloc(4),
    ]);
    expect(clamd.received().equals(expected)).toBe(true);
  });

  test('an empty body is just the command and the end marker', async () => {
    const clamd = await fakeClamd((all, s) => ended(all) && s.end('stream: OK\0'));
    await scanner(clamd.port).scan(Buffer.alloc(0));
    expect(clamd.received().equals(Buffer.concat([Buffer.from('zINSTREAM\0'), Buffer.alloc(4)]))).toBe(true);
  });

  test('a reply that arrives in pieces is read up to the terminating zero', async () => {
    const clamd = await fakeClamd((all, s) => {
      if (!ended(all)) return;
      s.write('stream: ');
      setImmediate(() => s.end('OK\0'));
    });
    await expect(scanner(clamd.port).scan(Buffer.from('x'))).resolves.toEqual({ clean: true });
  });

  test('the server closing mid-stream is ScanUnavailableError', async () => {
    const clamd = await fakeClamd((_all, s) => s.destroy());
    await expect(scanner(clamd.port).scan(Buffer.alloc(CLAMD_CHUNK_BYTES * 3))).rejects.toBeInstanceOf(
      ScanUnavailableError,
    );
  });

  test('the server closing after the stream without a reply is ScanUnavailableError', async () => {
    const clamd = await fakeClamd((all, s) => ended(all) && s.end());
    await expect(scanner(clamd.port).scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScanUnavailableError);
  });

  test('an error reply is ScanUnavailableError', async () => {
    const clamd = await fakeClamd((all, s) => ended(all) && s.end('INSTREAM size limit exceeded. ERROR\0'));
    await expect(scanner(clamd.port).scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScanUnavailableError);
  });

  test('no reply within timeoutMs is ScanUnavailableError', async () => {
    const clamd = await fakeClamd(() => undefined);
    const started = Date.now();
    await expect(scanner(clamd.port, 50).scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScanUnavailableError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('nothing listening is ScanUnavailableError', async () => {
    const clamd = await fakeClamd(() => undefined);
    const port = clamd.port;
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    await expect(scanner(port).scan(Buffer.from('x'))).rejects.toBeInstanceOf(ScanUnavailableError);
  });
});

describe('FakeScanner (FR-1.4)', () => {
  test('EICAR is the 68-character standard test string', () => {
    expect(EICAR).toHaveLength(68);
    expect(EICAR.startsWith('X5O!P%@AP[4\\PZX54(P^)7CC)7}$')).toBe(true);
    expect(EICAR.endsWith('-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')).toBe(true);
  });

  test('clean bytes are clean', async () => {
    await expect(new FakeScanner().scan(Buffer.from('hello'))).resolves.toEqual({ clean: true });
  });

  test('a body containing EICAR is not clean', async () => {
    const r = await new FakeScanner().scan(Buffer.from(`before ${EICAR} after`));
    expect(r.clean).toBe(false);
    expect(r.clean === false && r.signature).toMatch(/EICAR/i);
  });

  test('a body containing SCANNER-DOWN throws ScanUnavailableError', async () => {
    await expect(new FakeScanner().scan(Buffer.from('x SCANNER-DOWN y'))).rejects.toBeInstanceOf(ScanUnavailableError);
  });
});

describe('createScanner (FR-1.4)', () => {
  const env = {
    NODE_ENV: 'test',
    MONGO_URI: 'mongodb://unused',
    APP_ORIGIN: 'https://roadmap.example.com',
    TOTP_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
    FILES: 'memory',
  };

  test('picks the scanner named in the config', () => {
    expect(createScanner(loadConfig(env))).toBeInstanceOf(FakeScanner);
    expect(createScanner(loadConfig({ ...env, SCANNER: 'clamd', CLAMD_HOST: 'clamav' }))).toBeInstanceOf(ClamdScanner);
  });
});
