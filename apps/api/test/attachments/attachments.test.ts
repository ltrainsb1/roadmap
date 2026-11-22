import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { cleanFileName, NOTE_LIMITS, type Attachment } from '@roadmap/shared';
import type { AttachmentDoc, AuditEventDoc, ProjectDoc, UserDoc } from '../../src/db/types.ts';
import { contentDisposition, MemoryObjectStore } from '../../src/files/object-store.ts';
import { EICAR, FakeScanner, type ScanResult, type Scanner } from '../../src/files/scanner.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

/** Shifts the clock of the main app, so a test can make a link expire. */
let clockOffsetMs = 0;
const now = () => new Date(Date.now() + clockOffsetMs);

/** Calls to the recording store and scanner, in order: "scan", "put <key>", "delete <keys>". */
const calls: string[] = [];

class RecordingScanner implements Scanner {
  readonly #inner = new FakeScanner();
  scan(body: Buffer): Promise<ScanResult> {
    calls.push('scan');
    return this.#inner.scan(body);
  }
}

class RecordingStore extends MemoryObjectStore {
  failPut = false;
  failDelete = false;
  /** Runs after a successful put, before the upload's transaction. */
  afterPut: (() => Promise<void>) | null = null;
  override async put(key: string, body: Buffer): Promise<void> {
    calls.push(`put ${key}`);
    if (this.failPut) throw new Error('store down');
    await super.put(key, body);
    await this.afterPut?.();
  }
  override async deleteMany(keys: readonly string[]): Promise<void> {
    calls.push(`delete ${keys.join(',')}`);
    if (this.failDelete) throw new Error('store down');
    await super.deleteMany(keys);
  }
}

/** A scanner that, while `gate` is set, waits on it after telling `reached`. */
class GatedScanner implements Scanner {
  readonly #inner = new FakeScanner();
  gate: Promise<void> | null = null;
  reached: (() => void) | null = null;
  async scan(body: Buffer): Promise<ScanResult> {
    calls.push('scan');
    this.reached?.();
    if (this.gate) await this.gate;
    return this.#inner.scan(body);
  }
}

let t: TestApp;
let rec: TestApp;
let limited: TestApp;
let single: TestApp;
let slow: TestApp;
let store: RecordingStore;
let singleStore: RecordingStore;
let gated: GatedScanner;
beforeAll(async () => {
  t = await makeTestApp({ now });
  store = new RecordingStore('http://localhost:5173');
  rec = await makeTestApp({ objectStore: store, scanner: new RecordingScanner() });
  limited = await makeTestApp({ maxFilesPerItem: 1, maxConcurrentUploads: 10 });
  singleStore = new RecordingStore('http://localhost:5173');
  gated = new GatedScanner();
  single = await makeTestApp({ objectStore: singleStore, scanner: gated, maxConcurrentUploads: 1 });
  slow = await makeTestApp({ maxConcurrentUploads: 1, uploadReadTimeoutMs: 100 });
}, 120_000);
afterAll(async () => {
  await t?.close();
  await rec?.close();
  await limited?.close();
  await single?.close();
  await slow?.close();
});

type Who = 'O' | 'A' | 'C' | 'D';

interface Part {
  name: string;
  /** Sent as an RFC 5987 `filename*`; absent (with no `rawFileName`) makes the part a plain field. */
  fileName?: string;
  /** Sent as written inside `filename="…"`, as a browser sends it. */
  rawFileName?: string;
  body: Buffer | string;
}

/** A multipart/form-data body. */
function form(parts: Part[]): { payload: Buffer; contentType: string } {
  const boundary = `----roadmap${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const file =
      p.rawFileName !== undefined
        ? `; filename="${p.rawFileName}"`
        : p.fileName === undefined
          ? ''
          : `; filename*=UTF-8''${encodeURIComponent(p.fileName)}`;
    const type = file === '' ? '' : 'Content-Type: text/plain\r\n';
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${file}\r\n${type}\r\n`));
    chunks.push(Buffer.from(p.body), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** The path and query of a link, for inject. */
function pathOf(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** A roadmap with owner O, admin A and contributors C and D, none assigned to anything. */
async function world(app: TestApp = t) {
  const tenantId = (await app.seed.tenant())._id;
  const users = {
    O: await app.seed.user(tenantId),
    A: await app.seed.user(tenantId),
    C: await app.seed.user(tenantId),
    D: await app.seed.user(tenantId),
  };
  const names: Record<Who, string> = { O: 'Olive Owner', A: 'Ann', C: 'Cy', D: 'Dee' };
  for (const who of Object.keys(users) as Who[]) {
    await app.db.collection<UserDoc>('users').updateOne({ _id: users[who]._id }, { $set: { name: names[who] } });
  }
  const roadmap = await app.seed.roadmap(tenantId, users.O._id);
  await app.seed.member(tenantId, roadmap._id, users.A._id, 'admin');
  await app.seed.member(tenantId, roadmap._id, users.C._id, 'contributor');
  await app.seed.member(tenantId, roadmap._id, users.D._id, 'contributor');
  const sess = {
    O: await signInAs(app.app, app.db, users.O._id),
    A: await signInAs(app.app, app.db, users.A._id),
    C: await signInAs(app.app, app.db, users.C._id),
    D: await signInAs(app.app, app.db, users.D._id),
  };
  const ids = { O: users.O._id, A: users.A._id, C: users.C._id, D: users.D._id };
  const item = (o: { parentId?: string; archived?: boolean; assigneeIds?: string[] } = {}) =>
    app.seed.project(tenantId, roadmap._id, o);
  const base = (projectId: string, roadmapId = roadmap._id) =>
    `/api/roadmaps/${roadmapId}/projects/${projectId}/attachments`;
  const headers = (who: Who) => ({ cookie: sess[who].cookie, 'x-csrf-token': sess[who].csrf });
  const list = (who: Who, projectId: string) => app.app.inject({ method: 'GET', url: base(projectId), headers: headers(who) });
  const uploadParts = (who: Who, projectId: string, parts: Part[]) => {
    const { payload, contentType } = form(parts);
    return app.app.inject({
      method: 'POST',
      url: base(projectId),
      headers: { ...headers(who), 'content-type': contentType },
      payload,
    });
  };
  const upload = (who: Who, projectId: string, fileName = 'plan.txt', body: Buffer | string = 'hello') =>
    uploadParts(who, projectId, [{ name: 'file', fileName, body }]);
  const link = (who: Who, projectId: string, attachmentId: string) =>
    app.app.inject({ method: 'GET', url: `${base(projectId)}/${attachmentId}/download`, headers: headers(who) });
  const remove = (who: Who, projectId: string, attachmentId: string) =>
    app.app.inject({ method: 'DELETE', url: `${base(projectId)}/${attachmentId}`, headers: headers(who) });
  const deleteItem = (projectId: string) =>
    app.app.inject({ method: 'DELETE', url: `/api/roadmaps/${roadmap._id}/projects/${projectId}`, headers: headers('O') });
  const records = () => app.db.collection<AttachmentDoc>('attachments');
  const stored = (id: string) => records().findOne({ _id: id });
  const keyOf = (id: string) => `${tenantId}/${roadmap._id}/${id}`;
  const events = (action: string) =>
    app.db.collection<AuditEventDoc>('auditEvents').find({ tenantId, roadmapId: roadmap._id, action }).toArray();
  const attachment = (projectId: string, uploadedById: string, over: Parameters<TestApp['seed']['attachment']>[4] = {}) =>
    app.seed.attachment(tenantId, roadmap._id, projectId, uploadedById, over);
  return {
    tenantId,
    ids,
    roadmap,
    item,
    base,
    headers,
    list,
    uploadParts,
    upload,
    link,
    remove,
    deleteItem,
    records,
    stored,
    keyOf,
    events,
    attachment,
  };
}

describe('uploading', () => {
  test('FR-1.4: the Owner, an Admin and an assigned Contributor upload; an unassigned Contributor gets 403 for upload and delete but can list and get a link', async () => {
    const w = await world();
    const parent = await w.item({ assigneeIds: [w.ids.C] });
    const item = await w.item({ parentId: parent._id });
    for (const who of ['O', 'A', 'C'] as const) {
      const res = await w.upload(who, item._id, `${who}.txt`);
      expect(res.statusCode, who).toBe(201);
    }
    const denied = await w.upload('D', item._id);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'forbidden' });

    const listed = await w.list('D', item._id);
    expect(listed.statusCode).toBe(200);
    const files = listed.json<{ attachments: Attachment[] }>().attachments;
    expect(files.map((f) => f.name)).toEqual(['O.txt', 'A.txt', 'C.txt']);
    const link = await w.link('D', item._id, files[0]!.id);
    expect(link.statusCode).toBe(200);
    const removed = await w.remove('D', item._id, files[0]!.id);
    expect(removed.statusCode).toBe(403);
    expect(removed.json()).toEqual({ error: 'forbidden' });
    expect(await w.stored(files[0]!.id)).not.toBeNull();
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(3);
  });

  test('FR-1.4: the response has the cleaned name, the size and uploadedByName; the store holds the bytes under a key without the name', async () => {
    const w = await world();
    const item = await w.item();
    const body = Buffer.from('quarterly plan\n');
    const res = await w.upload('A', item._id, 'Q3 plan.txt', body);
    expect(res.statusCode).toBe(201);
    const file = res.json<Attachment>();
    expect(Object.keys(file).sort()).toEqual(['createdAt', 'id', 'name', 'projectId', 'size', 'uploadedById', 'uploadedByName']);
    expect(file).toMatchObject({
      projectId: item._id,
      name: 'Q3 plan.txt',
      size: body.length,
      uploadedById: w.ids.A,
      uploadedByName: 'Ann',
    });
    expect(Date.parse(file.createdAt)).not.toBeNaN();
    const doc = await w.stored(file.id);
    expect(doc!.key).toBe(w.keyOf(file.id));
    expect(doc!.key).not.toContain('plan');
    expect(t.files.objects.get(doc!.key)!.equals(body)).toBe(true);
  });

  test('FR-1.4: names are stored as cleanFileName gives them, and never reach the key', async () => {
    const w = await world();
    const item = await w.item();
    const raw = ['../../etc/passwd', 'a\\b.txt', 'tab\there.txt', `${'n'.repeat(296)}.txt`, 'plan 🚀 ✅.md'];
    for (const name of raw) {
      const res = await w.upload('O', item._id, name);
      expect(res.statusCode, name).toBe(201);
      const file = res.json<Attachment>();
      expect(file.name, name).toBe(cleanFileName(name));
      const doc = await w.stored(file.id);
      expect(doc!.name).toBe(cleanFileName(name));
      expect(doc!.key).toBe(w.keyOf(file.id));
    }
    expect((await w.list('O', item._id)).json<{ attachments: Attachment[] }>().attachments.map((f) => f.name)).toEqual([
      'passwd',
      'b.txt',
      'tabhere.txt',
      `${'n'.repeat(196)}.txt`,
      'plan 🚀 ✅.md',
    ]);
  });

  test('FR-1.4: a name with a newline is stored as a browser sends it (%0A), and a raw newline is refused', async () => {
    const w = await world();
    const item = await w.item();
    // Browsers send a newline in a file name as the three characters %0A.
    const sent = await w.uploadParts('O', item._id, [{ name: 'file', rawFileName: 'line%0Abreak.txt', body: 'x' }]);
    expect(sent.statusCode).toBe(201);
    expect(sent.json<Attachment>().name).toBe(cleanFileName('line%0Abreak.txt'));
    // A raw newline (in the header or percent-decoded from filename*) makes the parser drop the part.
    for (const part of [
      { name: 'file', rawFileName: 'line\nbreak.txt', body: 'x' },
      { name: 'file', fileName: 'line\nbreak.txt', body: 'x' },
    ]) {
      const res = await w.uploadParts('O', item._id, [part]);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('validation');
    }
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(1);
  });
});


describe('upload checks, in order', () => {
  test('FR-1.4: the scanner runs before the store; an infected file is 422 file_infected, never stored, and audited', async () => {
    const w = await world(rec);
    const item = await w.item();
    calls.length = 0;
    const ok = await w.upload('O', item._id, 'clean.txt');
    expect(ok.statusCode).toBe(201);
    expect(calls).toEqual(['scan', `put ${w.keyOf(ok.json<Attachment>().id)}`]);

    calls.length = 0;
    const res = await w.upload('C', item._id, '../bad\t.com', `prefix ${EICAR}`);
    // An unassigned Contributor is refused before anything is read.
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual([]);

    const infected = await w.upload('O', item._id, '../bad\t.com', `prefix ${EICAR}`);
    expect(infected.statusCode).toBe(422);
    expect(infected.json()).toEqual({ error: 'file_infected' });
    expect(calls).toEqual(['scan']);
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(1);
    const rejected = await w.events('attachment.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.actor).toEqual({ type: 'user', userId: w.ids.O });
    expect(rejected[0]!.after).toMatchObject({ name: cleanFileName('../bad\t.com'), signature: 'Eicar-Test-Signature' });
    expect(await w.events('attachment.create')).toHaveLength(1);
  });

  test('FR-1.4: when the scanner is unavailable the upload is 503 scan_unavailable and nothing is stored', async () => {
    const w = await world(rec);
    const item = await w.item();
    calls.length = 0;
    const res = await w.upload('O', item._id, 'x.txt', 'SCANNER-DOWN');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'scan_unavailable' });
    expect(calls).toEqual(['scan']);
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(0);
  });

  test('FR-1.4: when the store fails the upload is 500 and no record is written', async () => {
    const w = await world(rec);
    const item = await w.item();
    store.failPut = true;
    try {
      const res = await w.upload('O', item._id);
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal' });
    } finally {
      store.failPut = false;
    }
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(0);
    expect(await w.events('attachment.create')).toHaveLength(0);
  });

  test('FR-1.4: when the transaction fails after the put (item deleted in between) the object is deleted again', async () => {
    const w = await world(rec);
    const item = await w.item();
    store.afterPut = async () => {
      await rec.db.collection<ProjectDoc>('projects').deleteOne({ _id: item._id });
    };
    calls.length = 0;
    try {
      const res = await w.upload('O', item._id);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    } finally {
      store.afterPut = null;
    }
    expect(calls).toHaveLength(3);
    const key = calls[1]!.slice('put '.length);
    expect(key.startsWith(`${w.tenantId}/${w.roadmap._id}/`)).toBe(true);
    expect(calls[2]).toBe(`delete ${key}`);
    expect(store.objects.has(key)).toBe(false);
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(0);
  });

  test('FR-1.4: exactly 25 MB is accepted; one byte more is 413 file_too_large with nothing scanned or stored; zero bytes is 422 empty_file', async () => {
    const w = await world(rec);
    const item = await w.item();
    calls.length = 0;
    const max = await w.upload('O', item._id, 'max.bin', Buffer.alloc(NOTE_LIMITS.fileBytes, 1));
    expect(max.statusCode).toBe(201);
    expect(max.json<Attachment>().size).toBe(25 * 1024 * 1024);
    expect(calls).toHaveLength(2);

    calls.length = 0;
    const over = await w.upload('O', item._id, 'over.bin', Buffer.alloc(NOTE_LIMITS.fileBytes + 1, 1));
    expect(over.statusCode).toBe(413);
    expect(over.json()).toEqual({ error: 'file_too_large' });

    const empty = await w.upload('O', item._id, 'empty.txt', Buffer.alloc(0));
    expect(empty.statusCode).toBe(422);
    expect(empty.json()).toEqual({ error: 'empty_file' });
    expect(calls).toEqual([]);
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(1);
  });

  test('FR-1.4: the 21st file on an item is 422 too_many_files; the limit is per item', async () => {
    const w = await world();
    const item = await w.item();
    for (let i = 0; i < NOTE_LIMITS.filesPerItem; i += 1) await w.attachment(item._id, w.ids.O);
    const res = await w.upload('O', item._id);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'too_many_files' });
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(20);
    expect([...t.files.objects.keys()].filter((k) => k.startsWith(`${w.tenantId}/`))).toHaveLength(20);

    const small = await world(limited);
    const one = await small.item();
    expect((await small.upload('O', one._id)).statusCode).toBe(201);
    const second = await small.upload('O', one._id);
    expect(second.statusCode).toBe(422);
    expect(second.json()).toEqual({ error: 'too_many_files' });
    expect((await small.upload('O', (await small.item())._id)).statusCode).toBe(201);
  });

  test('FR-1.4: no file part, a part with another name, a second file or an extra field is 400 validation', async () => {
    const w = await world(rec);
    const item = await w.item();
    calls.length = 0;
    const file = { name: 'file', fileName: 'a.txt', body: 'a' };
    for (const parts of [
      [],
      [{ name: 'other', fileName: 'a.txt', body: 'a' }],
      [file, { name: 'file', fileName: 'b.txt', body: 'b' }],
      [file, { name: 'note', body: 'hi' }],
      [{ name: 'note', body: 'hi' }, file],
    ]) {
      const res = await w.uploadParts('O', item._id, parts);
      expect(res.statusCode, JSON.stringify(parts)).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('validation');
    }
    const json = await rec.app.inject({
      method: 'POST',
      url: w.base(item._id),
      headers: w.headers('O'),
      payload: { file: 'a' },
    });
    expect(json.statusCode).toBe(400);
    expect(json.json<{ error: string }>().error).toBe('validation');
    expect(calls).toEqual([]);
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(0);
  });
});

describe('downloading', () => {
  test('FR-1.4: the link returns the bytes as a download under the cleaned name, and is refused after 61 seconds', async () => {
    const w = await world();
    const item = await w.item();
    const body = Buffer.from('<script>alert(1)</script>');
    const file = (await w.upload('C', (await w.item({ assigneeIds: [w.ids.C] }))._id, '../x/ré sumé".html', body)).json<Attachment>();
    expect(file.name).toBe('ré sumé".html');
    // The link route checks the item the file is on.
    expect((await w.link('C', item._id, file.id)).statusCode).toBe(404);

    const res = await w.link('D', file.projectId, file.id);
    expect(res.statusCode).toBe(200);
    const { url } = res.json<{ url: string }>();
    expect(url).not.toContain(w.tenantId);
    const got = await t.app.inject({ url: pathOf(url) });
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(body)).toBe(true);
    expect(got.headers['content-type']).toBe('application/octet-stream');
    const disposition = String(got.headers['content-disposition']);
    expect(disposition.startsWith('attachment')).toBe(true);
    expect(disposition).toBe(contentDisposition('ré sumé".html'));

    clockOffsetMs = 61_000;
    try {
      expect((await t.app.inject({ url: pathOf(url) })).statusCode).toBe(404);
    } finally {
      clockOffsetMs = 0;
    }
  });

  test('FR-1.4: the download route for an attachment of another item in the same roadmap is 404', async () => {
    const w = await world();
    const item = await w.item();
    const other = await w.item();
    const file = await w.attachment(other._id, w.ids.O);
    const res = await w.link('O', item._id, file._id);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect((await w.link('O', item._id, 'no-such-file')).statusCode).toBe(404);
  });
});

describe('deleting', () => {
  test('FR-1.4: delete removes the record and the object; deleting again is 404', async () => {
    const w = await world();
    const item = await w.item();
    const file = (await w.upload('A', item._id)).json<Attachment>();
    const key = w.keyOf(file.id);
    expect(t.files.objects.has(key)).toBe(true);
    const res = await w.remove('A', item._id, file.id);
    expect(res.statusCode).toBe(204);
    expect(await w.stored(file.id)).toBeNull();
    expect(t.files.objects.has(key)).toBe(false);
    const again = await w.remove('A', item._id, file.id);
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: 'not_found' });
  });
});

describe('archived items', () => {
  test('FR-1.4: files on an archived item can be listed and downloaded; upload and delete are 409 item_archived', async () => {
    const w = await world();
    const item = await w.item({ archived: true });
    const file = await w.attachment(item._id, w.ids.C, { name: 'old.txt' });
    const listed = await w.list('C', item._id);
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ attachments: Attachment[] }>().attachments.map((f) => f.name)).toEqual(['old.txt']);
    expect((await w.link('C', item._id, file._id)).statusCode).toBe(200);
    const before = new Set(t.files.objects.keys());
    for (const res of [await w.upload('O', item._id), await w.remove('O', item._id, file._id)]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'item_archived' });
    }
    expect(new Set(t.files.objects.keys())).toEqual(before);
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(1);
  });

  test('FR-1.4: a missing item is 404 for list and upload', async () => {
    const w = await world();
    expect((await w.list('O', 'no-such-item')).statusCode).toBe(404);
    expect((await w.upload('O', 'no-such-item')).statusCode).toBe(404);
  });
});

describe('cascades', () => {
  test('FR-1.4: deleting an item deletes its and its descendants\' records and objects', async () => {
    const w = await world();
    const top = await w.item();
    const child = await w.item({ parentId: top._id });
    const grandchild = await w.item({ parentId: child._id });
    const other = await w.item();
    const files = new Map<string, AttachmentDoc>();
    for (const item of [top, child, grandchild, other]) files.set(item._id, await w.attachment(item._id, w.ids.C));
    expect((await w.deleteItem(child._id)).statusCode).toBe(200);
    expect((await w.records().find({ roadmapId: w.roadmap._id }).toArray()).map((f) => f.projectId).sort()).toEqual(
      [top._id, other._id].sort(),
    );
    for (const [projectId, file] of files) {
      expect(t.files.objects.has(file.key)).toBe(projectId === top._id || projectId === other._id);
    }
  });

  test('FR-1.4: deleting the roadmap deletes all its records and objects and no other roadmap\'s', async () => {
    const w = await world();
    const a = await w.attachment((await w.item())._id, w.ids.C);
    const b = await w.attachment((await w.item())._id, w.ids.A);
    const kept = await world();
    const k = await kept.attachment((await kept.item())._id, kept.ids.C);
    const res = await t.app.inject({
      method: 'DELETE',
      url: `/api/roadmaps/${w.roadmap._id}`,
      headers: w.headers('O'),
      payload: { confirmName: w.roadmap.name },
    });
    expect(res.statusCode).toBe(204);
    expect(await w.records().countDocuments({ roadmapId: w.roadmap._id })).toBe(0);
    expect(t.files.objects.has(a.key)).toBe(false);
    expect(t.files.objects.has(b.key)).toBe(false);
    expect(await kept.stored(k._id)).not.toBeNull();
    expect(t.files.objects.has(k.key)).toBe(true);
  });

  test('FR-1.4: when the store fails to delete after a cascade, the delete still succeeds', async () => {
    const w = await world(rec);
    const item = await w.item();
    const roadmapItem = await w.item();
    await rec.seed.attachment(w.tenantId, w.roadmap._id, item._id, w.ids.O);
    await rec.seed.attachment(w.tenantId, w.roadmap._id, roadmapItem._id, w.ids.O);
    store.failDelete = true;
    try {
      expect((await w.deleteItem(item._id)).statusCode).toBe(200);
      const res = await rec.app.inject({
        method: 'DELETE',
        url: `/api/roadmaps/${w.roadmap._id}`,
        headers: w.headers('O'),
        payload: { confirmName: w.roadmap.name },
      });
      expect(res.statusCode).toBe(204);
    } finally {
      store.failDelete = false;
    }
    expect(await w.records().countDocuments({ roadmapId: w.roadmap._id })).toBe(0);
  });

  test('FR-1.4: an item deleted while a file is uploaded to it leaves no record and no object behind', async () => {
    const w = await world();
    for (let i = 0; i < 20; i += 1) {
      const item = await w.item();
      const [deleted, uploaded] = await Promise.all([w.deleteItem(item._id), w.upload('O', item._id, `race ${i}.txt`)]);
      expect(deleted.statusCode).toBe(200);
      expect([201, 404]).toContain(uploaded.statusCode);
    }
    expect(await t.db.collection<ProjectDoc>('projects').countDocuments({ roadmapId: w.roadmap._id })).toBe(0);
    expect(await w.records().countDocuments({ roadmapId: w.roadmap._id })).toBe(0);
    expect([...t.files.objects.keys()].filter((k) => k.startsWith(`${w.tenantId}/`))).toEqual([]);
  });
});

describe('audit', () => {
  test('FR-1.4: create and delete each record one event with the attachment as target and its name and size', async () => {
    const w = await world();
    const item = await w.item();
    const file = (await w.upload('O', item._id, 'notes.txt', 'twelve bytes')).json<Attachment>();
    await w.remove('A', item._id, file.id);
    const [created, deleted] = [await w.events('attachment.create'), await w.events('attachment.delete')];
    for (const list of [created, deleted]) {
      expect(list).toHaveLength(1);
      expect(list[0]!.target).toEqual({ type: 'attachment', id: file.id });
      expect(JSON.stringify(list[0])).not.toContain(w.keyOf(file.id));
    }
    expect(created[0]!.actor).toEqual({ type: 'user', userId: w.ids.O });
    expect(created[0]!.after).toEqual({ projectId: item._id, name: 'notes.txt', size: 12 });
    expect(deleted[0]!.actor).toEqual({ type: 'user', userId: w.ids.A });
    expect(deleted[0]!.before).toEqual({ projectId: item._id, name: 'notes.txt', size: 12 });
  });
});

describe('uploaders', () => {
  test('FR-1.4: a file whose uploader\'s user record is gone lists with uploadedByName "Former member"', async () => {
    const w = await world();
    const item = await w.item();
    await w.attachment(item._id, 'gone-user', { name: 'left.txt' });
    await w.attachment(item._id, w.ids.D, { name: 'here.txt' });
    const listed = (await w.list('C', item._id)).json<{ attachments: Attachment[] }>().attachments;
    expect(listed.map((f) => [f.name, f.uploadedByName])).toEqual([
      ['left.txt', 'Former member'],
      ['here.txt', 'Dee'],
    ]);
    expect(listed[0]).not.toHaveProperty('key');
  });
});

describe('Tenant isolation', () => {
  test('Tenant isolation: attachments', async () => {
    const w = await world();
    const item = await w.item();
    const file = await w.attachment(item._id, w.ids.O);
    const them = await world();
    const theirItem = await them.item();

    const url = w.base(item._id);
    const asThem = them.headers('O');
    const { payload, contentType } = form([{ name: 'file', fileName: 'x.txt', body: 'x' }]);
    for (const res of [
      await t.app.inject({ method: 'GET', url, headers: asThem }),
      await t.app.inject({ method: 'POST', url, headers: { ...asThem, 'content-type': contentType }, payload }),
      await t.app.inject({ method: 'GET', url: `${url}/${file._id}/download`, headers: asThem }),
      await t.app.inject({ method: 'DELETE', url: `${url}/${file._id}`, headers: asThem }),
      // Our attachment id under their own roadmap and item.
      await them.link('O', theirItem._id, file._id),
      await them.remove('O', theirItem._id, file._id),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
    expect(await w.stored(file._id)).not.toBeNull();
    expect(t.files.objects.has(file.key)).toBe(true);
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(1);
  });
});


describe('sessions', () => {
  test('FR-1.4: signed out is 401; upload and delete without the CSRF token are 403 csrf', async () => {
    const w = await world();
    const item = await w.item();
    const file = await w.attachment(item._id, w.ids.O);
    const url = w.base(item._id);
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: `${url}/${file._id}/download` })).statusCode).toBe(401);
    const { payload, contentType } = form([{ name: 'file', fileName: 'x.txt', body: 'x' }]);
    const cookie = w.headers('O').cookie;
    for (const res of [
      await t.app.inject({ method: 'POST', url, headers: { cookie, 'content-type': contentType }, payload }),
      await t.app.inject({ method: 'DELETE', url: `${url}/${file._id}`, headers: { cookie } }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'csrf' });
    }
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(1);
    for (const res of [
      await t.app.inject({ method: 'POST', url, headers: { 'content-type': contentType }, payload }),
      await t.app.inject({ method: 'DELETE', url: `${url}/${file._id}` }),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthenticated' });
    }
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(1);
  });
});

describe('uploads in flight', () => {
  test('FR-1.4: while the only upload slot is taken another upload is 503 uploads_busy and is not read; after it, uploads work again', async () => {
    const w = await world(single);
    const item = await w.item();
    let open!: () => void;
    gated.gate = new Promise((r) => (open = r));
    const reached = new Promise<void>((r) => (gated.reached = r));
    calls.length = 0;
    const first = w.upload('O', item._id, 'first.txt');
    try {
      await reached;
      const second = await w.upload('O', item._id, 'second.txt');
      expect(second.statusCode).toBe(503);
      expect(second.json()).toEqual({ error: 'uploads_busy' });
      expect(calls).toEqual(['scan']);
    } finally {
      gated.gate = null;
      gated.reached = null;
      open();
    }
    expect((await first).statusCode).toBe(201);
    expect((await w.upload('O', item._id, 'third.txt')).statusCode).toBe(201);
    expect(calls.filter((c) => c.startsWith('put '))).toHaveLength(2);
    expect((await w.list('O', item._id)).json<{ attachments: Attachment[] }>().attachments.map((f) => f.name)).toEqual([
      'first.txt',
      'third.txt',
    ]);
  });

  test('FR-1.4: the upload slot is released after every failure', async () => {
    const w = await world(single);
    const item = await w.item();
    const archived = await w.item({ archived: true });
    const cases: Array<{ name: string; run: () => ReturnType<typeof w.upload>; status: number; error: string }> = [
      { name: 'infected', run: () => w.upload('O', item._id, 'v.com', EICAR), status: 422, error: 'file_infected' },
      { name: 'scanner down', run: () => w.upload('O', item._id, 'd.txt', 'SCANNER-DOWN'), status: 503, error: 'scan_unavailable' },
      {
        name: 'too large',
        run: () => w.upload('O', item._id, 'big.bin', Buffer.alloc(NOTE_LIMITS.fileBytes + 1)),
        status: 413,
        error: 'file_too_large',
      },
      { name: 'empty', run: () => w.upload('O', item._id, 'e.txt', ''), status: 422, error: 'empty_file' },
      {
        name: 'store failure',
        run: async () => {
          singleStore.failPut = true;
          try {
            return await w.upload('O', item._id);
          } finally {
            singleStore.failPut = false;
          }
        },
        status: 500,
        error: 'internal',
      },
      { name: 'transaction failure', run: () => w.upload('O', archived._id), status: 409, error: 'item_archived' },
    ];
    for (const c of cases) {
      const failed = await c.run();
      expect(failed.statusCode, c.name).toBe(c.status);
      expect(failed.json(), c.name).toEqual({ error: c.error });
      const next = await w.upload('O', item._id, `after ${c.name}.txt`);
      expect(next.statusCode, `upload after ${c.name}`).toBe(201);
    }
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(cases.length);
  });

  test('FR-1.4: a body that stalls past the time limit is 408 upload_timeout, nothing is stored, and the slot is released', async () => {
    const w = await world(slow);
    const item = await w.item();
    const { payload, contentType } = form([{ name: 'file', fileName: 'stall.txt', body: Buffer.alloc(64 * 1024, 1) }]);
    const body = new PassThrough();
    body.write(payload.subarray(0, payload.length - 1000));
    try {
      const res = await slow.app.inject({
        method: 'POST',
        url: w.base(item._id),
        headers: { ...w.headers('O'), 'content-type': contentType },
        payload: body,
      });
      expect(res.statusCode).toBe(408);
      expect(res.json()).toEqual({ error: 'upload_timeout' });
    } finally {
      body.end();
    }
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(0);
    expect([...slow.files.objects.keys()].filter((k) => k.startsWith(`${w.tenantId}/`))).toEqual([]);
    expect((await w.upload('O', item._id)).statusCode).toBe(201);
  });

  test('FR-1.4: five uploads at once to an item with room for one end with one file', async () => {
    const w = await world(limited);
    const item = await w.item();
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => w.upload('O', item._id, `${i}.txt`)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422, 422, 422, 422]);
    for (const r of results.filter((x) => x.statusCode === 422)) expect(r.json()).toEqual({ error: 'too_many_files' });
    expect(await w.records().countDocuments({ projectId: item._id })).toBe(1);
    expect([...limited.files.objects.keys()].filter((k) => k.startsWith(`${w.tenantId}/`))).toHaveLength(1);
  });
});

