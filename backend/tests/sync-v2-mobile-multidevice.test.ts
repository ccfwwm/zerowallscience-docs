import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { NativeLocalRepository } from "../../frontend/src/lib/nativeLocalRepository";
import { MobileSyncEngine } from "../../frontend/src/lib/mobileSyncEngine";
import type { NativeDatabase } from "../../frontend/src/lib/nativeDatabase";
import { nativeReceiptKey, readNativeNoteSyncReceipt } from "../../frontend/src/lib/mobileNoteSyncReceipt";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sync-multidevice-"));
process.env.DB_PATH = path.join(tmpDir, "server.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";
const browser = new EventTarget();
Object.assign(globalThis, { window: browser });
const scope = { scopeKey: "personal", workspaceId: null, workspaceName: null, role: "owner", canWrite: true, accessFingerprint: "personal:owner" };
const USER = "multidevice-user";
let serverDb: Database.Database;
let closeServerDb: () => void;
let httpServer: ReturnType<typeof serve>;
let serverUrl: string;
const clients: Client[] = [];
let afterPush: ((response: Response) => Promise<Response>) | undefined;

// The real native schema, with independent on-disk SQLite databases. The adapter
// serializes transactions just like NativeDatabaseImpl; no shared client state.
function openClientDb(file: string): NativeDatabase {
  const raw = new Database(file);
  raw.pragma("foreign_keys = ON");
  const source = fs.readFileSync(path.resolve(__dirname, "../../frontend/src/lib/nativeDatabase.ts"), "utf8");
  const scopeCheck = source.match(/const SCOPE_CHECK = `([\s\S]*?)`;/)![1];
  const entityTypes = source.match(/const ENTITY_TYPE_CHECK = `([\s\S]*?)`;/)![1];
  for (const [, sql] of source.matchAll(/`(CREATE TABLE IF NOT EXISTS [\s\S]*?)`/g)) {
    raw.exec(sql.replaceAll("${SCOPE_CHECK}", scopeCheck).replaceAll("${ENTITY_TYPE_CHECK}", entityTypes));
  }
  let queue = Promise.resolve();
  const schedule = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  const tx: NativeDatabase = {
    async run(sql, values = []) { const result = raw.prepare(sql).run(...values); return { changes: result.changes }; },
    async query<T>(sql: string, values: unknown[] = []) { return raw.prepare(sql).all(...values) as T[]; },
    async transaction(work) { return work(tx); },
    async close() { raw.close(); },
  };
  return {
    run: (sql, values) => schedule(() => tx.run(sql, values)),
    query: <T>(sql: string, values?: unknown[]) => schedule(() => tx.query<T>(sql, values)),
    transaction: (work) => schedule(async () => {
      raw.exec("BEGIN IMMEDIATE");
      try { const result = await work(tx); raw.exec("COMMIT"); return result; }
      catch (error) { raw.exec("ROLLBACK"); throw error; }
    }),
    close: () => schedule(() => tx.close()),
  };
}

interface Client {
  db: NativeDatabase;
  file: string;
  repository: NativeLocalRepository;
  engine: MobileSyncEngine;
  profileId: string;
  removedFiles: string[];
  sync(): Promise<void>;
}
async function client(name: string): Promise<Client> {
  const file = path.join(tmpDir, `${name}.db`);
  const db = openClientDb(file);
  const profileId = `profile-${name}`;
  await db.run(`INSERT OR IGNORE INTO sync_profiles (id,name,serverUrl,remoteUserId,enabled,createdAt,updatedAt)
    VALUES (?,?,?, ?,1,'now','now')`, [profileId, name, serverUrl, USER]);
  await db.run("INSERT OR IGNORE INTO sync_devices (profileId,deviceId,platform,createdAt) VALUES (?,?,'android','now')", [profileId, name]);
  const repository = new NativeLocalRepository({ db, attachments: {} as never, accountId: name, userId: USER, getScopeKey: () => "personal" });
  const removedFiles: string[] = [];
  const engine = new MobileSyncEngine({ db, attachments: { remove: async (id: string) => { removedFiles.push(id); } } as never, profileId, deviceId: name, serverUrl, token: USER, userId: USER });
  const result = { db, file, repository, engine, profileId, removedFiles, async sync() {
    engine.start();
    try { await engine.syncOnce(); } finally { engine.stop(); }
  } };
  clients.push(result);
  return result;
}
async function pending(c: Client) { return c.db.query<{ mutationId: string; baseVersion: number; payload: string }>("SELECT mutationId,baseVersion,payload FROM sync_outbox WHERE profileId=? ORDER BY createdAt,rowid", [c.profileId]); }
async function conflicts(c: Client) { return c.db.query<{ localPayload: string; remotePayload: string }>("SELECT localPayload,remotePayload FROM sync_conflicts WHERE profileId=? AND status='unresolved'", [c.profileId]); }

test.before(async () => {
  const schema = await import("../src/db/schema");
  const routes = await import("../src/routes/sync-v2");
  serverDb = schema.getDb(); closeServerDb = schema.closeDb;
  for (const user of [USER, "other-user"]) serverDb.prepare("INSERT INTO users (id,username,passwordHash,createdAt,updatedAt) VALUES (?,?,'x','now','now')").run(user, user);
  const app = new Hono();
  // Route tests use fixture identities; production auth remains in index.ts.
  app.use("*", async (c, next) => {
    c.req.raw.headers.set("X-User-Id", c.req.header("Authorization")?.replace("Bearer ", "") || "");
    await next();
    if (c.req.path.endsWith("/push") && afterPush) c.res = await afterPush(c.res);
  });
  app.route("/api/sync/v2", routes.default);
  httpServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const address = httpServer.address(); assert.ok(address && typeof address !== "string");
  serverUrl = `http://127.0.0.1:${address.port}`;
});
test.after(async () => {
  for (const c of clients) { c.engine.stop(); await c.db.close().catch(() => undefined); }
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  closeServerDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("workspace Snapshot pruning preserves pending descendants, unresolved conflicts and local attachment bytes", async () => {
  const c = await client("prune-native");
  const key = "workspace:prune", book = randomUUID(), pendingNote = randomUUID(), conflictedNote = randomUUID(), attachment = randomUUID();
  await c.db.run("INSERT INTO notebooks (id,scopeKey,workspaceId,userId,name,createdAt,updatedAt) VALUES (?,?,'prune',?,'Book','now','now')", [book,key,USER]);
  for (const id of [pendingNote, conflictedNote]) await c.db.run("INSERT INTO notes (id,scopeKey,workspaceId,userId,notebookId,title,content,createdAt,updatedAt) VALUES (?,?,'prune',?,?,'Title','retained','now','now')", [id,key,USER,book]);
  await c.db.run("INSERT INTO sync_outbox (id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,payload,createdAt) VALUES (?,?,?,?,?,'note',?,'upsert','{}','now')", [randomUUID(),randomUUID(),c.profileId,"prune-native",key,pendingNote]);
  await c.db.run("INSERT INTO sync_conflicts (id,profileId,scopeKey,entityType,entityId,localPayload,remotePayload,createdAt) VALUES (?,?,?,'note',?,'{}','{}','now')", [randomUUID(),c.profileId,key,conflictedNote]);
  await c.db.run("INSERT INTO attachments (id,scopeKey,workspaceId,userId,noteId,filename,mimeType,size,localPath,available,transferStatus,createdAt,updatedAt) VALUES (?,?,'prune',?,?,'a.png','image/png',4,'fixture',1,'pending_upload','now','now')", [attachment,key,USER,pendingNote]);
  await (c.engine as unknown as { pruneWorkspaceSnapshot(s: unknown, seen: Map<string,Set<string>>): Promise<void> }).pruneWorkspaceSnapshot({ ...scope, scopeKey: key, workspaceId: "prune" }, new Map());
  assert.equal((await c.db.query("SELECT id FROM notes WHERE scopeKey=?", [key])).length, 2);
  assert.equal((await c.db.query("SELECT id FROM notebooks WHERE scopeKey=?", [key])).length, 1);
  assert.equal((await c.db.query("SELECT id FROM attachments WHERE scopeKey=?", [key])).length, 1);
  assert.deepEqual(c.removedFiles, []);
});

test("create then permanent delete between Pulls advances the cursor without a missing Snapshot error", async () => {
  const a = await client("fold-a"), b = await client("fold-b");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.sync(); await b.sync();
  await a.repository.notes.create({ id, notebookId: book, content: "temporary" });
  await a.sync();
  await a.repository.notes.remove(id);
  await a.sync();
  await b.sync();
  assert.equal((await b.repository.notes.get(id)), null);
  const state = (await b.db.query<{lastError:string|null;lastSequence:number}>("SELECT lastError,lastSequence FROM sync_state WHERE profileId=?", [b.profileId]))[0];
  assert.equal(state.lastError, null);
  assert.equal(state.lastSequence, serverDb.prepare("SELECT MAX(sequence) AS seq FROM sync_changes_v2 WHERE userId=?").get(USER).seq);
});

test("three independent SQLite clients converge bidirectionally after consecutive Markdown and rich-text edits", async () => {
  for (const format of ["markdown", "tiptap-json"]) {
    const a = await client(`a-${format}`), b = await client(`b-${format}`), c = await client(`c-${format}`);
    const book = randomUUID(), id = randomUUID();
    await a.repository.notebooks.create({ id: book, name: "Book" });
    const content = format === "markdown" ? "first" : JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] });
    await a.repository.notes.create({ id, notebookId: book, content, contentFormat: format });
    await a.sync(); await b.sync(); await c.sync();
    assert.equal((await b.repository.notes.get(id))?.content, content);
    const base = (await a.repository.notes.get(id))!.version;
    await a.repository.notes.update(id, { title: "edit 1" });
    await a.repository.notes.update(id, { title: "edit 2" });
    await a.sync();
    assert.equal((await conflicts(a)).length, 0, "sequential local writes are descendants, not concurrent conflicts");
    assert.equal((await pending(a)).length, 0);
    await b.sync(); await c.sync();
    assert.equal((await b.repository.notes.get(id))?.title, "edit 2");
    assert.ok((await a.repository.notes.get(id))!.version > base);
    await b.repository.notes.update(id, { title: "from B" });
    await b.sync(); await a.sync(); await c.sync();
    assert.equal((await a.repository.notes.get(id))?.title, "from B");
    assert.equal((await c.repository.notes.get(id))?.version, (await a.repository.notes.get(id))?.version);
  }
});

test("remote permanent deletion preserves offline body, pending mutation and recoverable conflict", async () => {
  const a = await client("delete-a"), b = await client("delete-b");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "base", contentFormat: "markdown" });
  await a.sync(); await b.sync();
  await b.repository.notes.update(id, { content: "offline recovery body" });
  await a.repository.notes.remove(id); await a.sync();
  const pull = b.engine as unknown as { pull(scope: typeof scope): Promise<void> };
  await pull.pull(scope);
  assert.equal((await b.repository.notes.get(id))?.content, "offline recovery body");
  assert.equal((await pending(b)).length, 1);
  const saved = await conflicts(b);
  assert.equal(saved.length, 1);
  assert.equal(JSON.parse(saved[0].localPayload).content, "offline recovery body");
  assert.equal(JSON.parse(saved[0].remotePayload).__delete, true);
});

test("offline create survives database close/reopen and immediate local read before uploading", async () => {
  const a = await client("restart-a");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Offline book" });
  await a.repository.notes.create({ id, notebookId: book, content: "durable", contentFormat: "markdown" });
  const mutations = (await pending(a)).map((row) => row.mutationId);
  assert.equal((await a.repository.notes.get(id))?.content, "durable");
  await a.db.close();
  const restarted = await client("restart-a");
  assert.equal((await restarted.repository.notes.get(id))?.content, "durable");
  assert.deepEqual((await pending(restarted)).map((row) => row.mutationId), mutations);
  await restarted.sync();
  const b = await client("restart-b"); await b.sync();
  assert.equal((await b.repository.notes.get(id))?.content, "durable");
});

test("missing or invalid successful ACK version cannot claim cloud confirmation", async () => {
  const a = await client("receipt-a");
  for (const version of [null, 0, -1, "4"]) {
    await a.db.run("INSERT OR REPLACE INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,'now')", [nativeReceiptKey(a.profileId, "test-note"), JSON.stringify({ mutationId: "m", serverVersion: version })]);
    assert.equal((await readNativeNoteSyncReceipt(a.db, a.profileId, "test-note")).phase, "unverified");
  }
});

test("an old offline update cannot resurrect a permanently deleted server note", async () => {
  const a = await client("resurrect-a"), b = await client("resurrect-b");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "base", contentFormat: "markdown" });
  await a.sync(); await b.sync();
  await b.repository.notes.update(id, { content: "offline retained" });
  await a.repository.notes.remove(id); await a.sync();
  await b.sync();
  assert.equal(serverDb.prepare("SELECT id FROM notes WHERE id=?").get(id), undefined);
  assert.equal((await b.repository.notes.get(id))?.content, "offline retained");
  assert.equal((await conflicts(b)).length, 1);
});

test("apply failure rolls back the entire batch and leaves cursor and ACK unchanged", async () => {
  const a = await client("apply-a"), b = await client("apply-b");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "base", contentFormat: "markdown" });
  await a.sync(); await b.sync();
  const state = await b.db.query("SELECT * FROM sync_state");
  await a.repository.notes.update(id, { content: "after failure" }); await a.sync();
  const run = b.db.transaction;
  b.db.transaction = (work) => run(async (tx) => work({ ...tx, run: async (sql, values) => {
    if (sql.includes("INSERT INTO notes")) throw new Error("SQLITE_FULL fixture");
    return tx.run(sql, values);
  } }));
  await assert.rejects((b.engine as unknown as { pull(s: typeof scope): Promise<void> }).pull(scope), /SQLITE_FULL/);
  assert.equal((await b.repository.notes.get(id))?.content, "base");
  assert.deepEqual(await b.db.query("SELECT * FROM sync_state"), state);
  b.db.transaction = run;
  await b.sync();
  assert.equal((await b.repository.notes.get(id))?.content, "after failure");
});

test("successful push replay after client ACK crash uses the same mutationId exactly once", async () => {
  const a = await client("ack-crash-a");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "durable ACK", contentFormat: "markdown" });
  const before = await pending(a);
  const run = a.db.transaction;
  a.db.transaction = (work) => run(async (tx) => work({ ...tx, run: async (sql, values) => {
    if (sql.includes("DELETE FROM sync_outbox WHERE mutationId")) throw new Error("ACK crash fixture");
    return tx.run(sql, values);
  } }));
  await assert.rejects((a.engine as unknown as { push(s: typeof scope): Promise<void> }).push(scope), /ACK crash/);
  assert.equal(serverDb.prepare("SELECT content FROM notes WHERE id=?").get(id)?.content, "durable ACK");
  assert.deepEqual((await pending(a)).map((row) => row.mutationId), before.map((row) => row.mutationId));
  a.db.transaction = run;
  await (a.engine as unknown as { push(s: typeof scope): Promise<void> }).push(scope);
  assert.equal((await pending(a)).length, 0);
  for (const row of before) assert.equal((serverDb.prepare("SELECT COUNT(*) AS count FROM sync_v2_applied_mutations WHERE mutationId=?").get(row.mutationId) as {count:number}).count, 1);
});

test("overlapping native writes read the latest revision inside the write transaction", async () => {
  const a = await client("overlap-a");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "base", contentFormat: "markdown" });
  await a.sync();
  await Promise.all([
    a.repository.notes.update(id, { title: "new title" }),
    a.repository.notes.update(id, { content: "new body" }),
  ]);
  const note = await a.repository.notes.get(id);
  assert.equal(note?.title, "new title"); assert.equal(note?.content, "new body");
  const rows = await pending(a);
  assert.equal(rows[1].baseVersion, JSON.parse(rows[0].payload).version);
  await a.sync();
  assert.equal((await conflicts(a)).length, 0);
});

test("concurrent devices preserve both versions, and keep-local resolution establishes the remote base", async () => {
  const a = await client("conflict-a"), b = await client("conflict-b");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "base", contentFormat: "markdown" });
  await a.sync(); await b.sync();
  await b.repository.notes.update(id, { content: "B version" });
  for (let index = 0; index < 4; index++) { await a.repository.notes.update(id, { content: "A version" }); await a.sync(); }
  await b.sync();
  const rows = await b.db.query<{id:string;localPayload:string;remotePayload:string}>("SELECT * FROM sync_conflicts WHERE profileId=? AND status='unresolved'", [b.profileId]);
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].localPayload).content, "B version");
  assert.equal(JSON.parse(rows[0].remotePayload).content, "A version");
  await b.repository.notes.update(id, { content: "B edited after conflict" });
  await b.sync();
  const fork = await b.engine.forkLocalConflict(rows[0].id, "local");
  assert.equal((await b.repository.notes.get(fork))?.content, "B edited after conflict");
  await b.engine.resolveLocalConflict(rows[0].id, "keep-local");
  await b.sync();
  assert.equal((await b.repository.notes.get(id))?.version, (serverDb.prepare("SELECT version FROM notes WHERE id=?").get(id) as {version:number}).version);
  await b.repository.notes.update(id, { title: "after resolution" }); await b.sync(); await a.sync();
  assert.equal((await conflicts(b)).length, 0);
  assert.equal((await a.repository.notes.get(id))?.content, "B edited after conflict");
});

test("two edits committed during a delayed ACK survive own echo and subsequent push", async () => {
  const a = await client("delayed-a"), b = await client("delayed-b");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "base", contentFormat: "markdown" });
  await a.sync(); await b.sync();
  await a.repository.notes.update(id, { content: "sent version" });
  let release!: () => void, received!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const committed = new Promise<void>((resolve) => { received = resolve; });
  afterPush = async (response) => { received(); await gate; return response; };
  const internal = a.engine as unknown as { push(s: typeof scope): Promise<void>; pull(s: typeof scope): Promise<void> };
  try {
    const pushing = internal.push(scope);
    await committed;
    await a.repository.notes.update(id, { content: "newer local 1" });
    await a.repository.notes.update(id, { content: "newer local 2" });
    release(); await pushing;
    afterPush = undefined;
    await internal.pull(scope);
    assert.equal((await conflicts(a)).length, 0, "multiple later edits must not turn own ACK into a conflict");
    assert.equal((await a.repository.notes.get(id))?.content, "newer local 2");
    assert.equal((await pending(a)).length, 2);
    await a.sync(); await b.sync();
    assert.equal((await conflicts(a)).length, 0);
    assert.equal((await b.repository.notes.get(id))?.content, "newer local 2");
  } finally { release(); afterPush = undefined; }
});

test("invalid note ACK leaves the durable mutation available for an idempotent retry", async () => {
  const a = await client("invalid-ack-a");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  await a.repository.notes.create({ id, notebookId: book, content: "retained", contentFormat: "markdown" });
  const before = await pending(a);
  afterPush = async (response) => {
    const json = await response.json();
    for (const result of json.results) delete result.version;
    return Response.json(json);
  };
  try {
    await assert.rejects((a.engine as unknown as {push(s:typeof scope):Promise<void>}).push(scope), /ACK/);
    assert.deepEqual((await pending(a)).map((row) => row.mutationId), before.map((row) => row.mutationId));
    assert.equal((await readNativeNoteSyncReceipt(a.db, a.profileId, id)).phase, "pending");
  } finally { afterPush = undefined; }
  await a.sync();
  assert.equal((await pending(a)).length, 0);
  assert.equal((await a.repository.notes.get(id))?.content, "retained");
});

test("a failed Outbox insertion rolls back note creation in the same SQLite transaction", async () => {
  const a = await client("outbox-failure-a");
  const book = randomUUID(), id = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Book" });
  const transaction = a.db.transaction;
  a.db.transaction = (work) => transaction(async (tx) => work({ ...tx, run: async (sql, values) => {
    if (sql.includes("INSERT INTO sync_outbox")) throw new Error("Outbox full fixture");
    return tx.run(sql, values);
  } }));
  await assert.rejects(a.repository.notes.create({ id, notebookId: book, content: "must not falsely save", contentFormat: "markdown" }), /Outbox full/);
  assert.equal(await a.repository.notes.get(id), null);
  a.db.transaction = transaction;
  await a.repository.notes.create({ id, notebookId: book, content: "saved after retry", contentFormat: "markdown" });
  assert.equal((await a.repository.notes.get(id))?.content, "saved after retry");
});
