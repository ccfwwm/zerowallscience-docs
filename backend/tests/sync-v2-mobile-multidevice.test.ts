import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { NativeLocalRepository } from "../../frontend/src/lib/nativeLocalRepository";
import { MobileSyncEngine } from "../../frontend/src/lib/mobileSyncEngine";
import type { NativeDatabase } from "../../frontend/src/lib/nativeDatabase";
import { nativeReceiptKey, readNativeNoteSyncReceipt } from "../../frontend/src/lib/mobileNoteSyncReceipt";
import { applyNativePersonalTree } from "../../frontend/src/lib/nativeKnowledgeTreeSync";

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
let afterSnapshot: ((response: Response) => Promise<Response>) | undefined;
let afterAck: ((response: Response) => Promise<Response>) | undefined;

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

async function cachePersonalTree(c: Client): Promise<void> {
  const response = await fetch(`${serverUrl}/api/knowledge-tree/?workspaceId=personal`, { headers: { Authorization: `Bearer ${USER}` } });
  assert.equal(response.status, 200);
  const { nodes } = await response.json() as { nodes: unknown[] };
  await c.db.run(`INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES ('knowledgeTreeSnapshot:v1:personal:0',?,'now')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [JSON.stringify(nodes)]);
}

async function movableTree(name: string) {
  const c = await client(name), ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids) await c.repository.notebooks.create({ id, name: "Move fixture" });
  const document = randomUUID();
  await c.repository.createPersonalTreeNote({ id: document, contentFormat: "markdown", content: "Preserved body" }, null);
  await c.sync(); await cachePersonalTree(c);
  return { c, node: `notebook:${ids[0]}`, left: `notebook:${ids[1]}`, right: `notebook:${ids[2]}`, document: `note:${document}` };
}

test("native personal moves and sorting are atomic, survive reopen and push only structural fields", async () => {
  const { c, node, left, document } = await movableTree("active-offline");
  await c.repository.movePersonalTreeNodes([{ id: node, parentId: document, sortOrder: 23 }, { id: left, sortOrder: 24 }]);
  const outbox = await pending(c); assert.equal(outbox.length, 2);
  const mutation = JSON.parse(outbox[0].payload);
  assert.equal(mutation.parentId, document); assert.equal(mutation.baseParentId, null);
  assert.equal(mutation.content, undefined); assert.equal(mutation.title, undefined);
  await c.db.close();
  const reopened = await client("active-offline");
  assert.deepEqual((await reopened.db.query("SELECT parentId,sortOrder FROM native_knowledge_tree_nodes WHERE id=?", [node]))[0], { parentId: document, sortOrder: 23 });
  await reopened.sync();
  assert.equal((await pending(reopened)).length, 0);
  assert.deepEqual(serverDb.prepare("SELECT parentId,sortOrder FROM knowledge_tree_nodes WHERE id=?").get(node), { parentId: document, sortOrder: 23 });
  assert.equal(serverDb.prepare("SELECT sortOrder FROM knowledge_tree_nodes WHERE id=?").get(left).sortOrder, 24);
  assert.equal((await reopened.repository.notes.get(document.slice(5)))?.content, "Preserved body");
  await reopened.repository.notebooks.update(node.slice(9),{name:"Rename after move"}); await reopened.sync();
  assert.equal(serverDb.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id=?").get(node).parentId,document);
  assert.equal(serverDb.prepare("SELECT sortOrder FROM knowledge_tree_nodes WHERE id=?").get(node).sortOrder,23);
  assert.equal(serverDb.prepare("SELECT parentId FROM notebooks WHERE id=?").get(node.slice(9)).parentId,
    (await reopened.repository.notebooks.get(node.slice(9)))?.parentId);
});

for (const resolution of ["keep-local", "keep-remote"] as const) test(`concurrent native tree moves recover with ${resolution} and preserve latest local position`, async () => {
  const { c: a, node, left, right } = await movableTree(`active-${resolution}`), b = await client(`active-peer-${resolution}`);
  await b.sync(); await cachePersonalTree(b);
  await a.repository.movePersonalTreeNodes([{ id: node, parentId: left, sortOrder: 11 }]);
  await b.repository.movePersonalTreeNodes([{ id: node, parentId: right, sortOrder: 12 }]);
  await a.sync(); await b.sync();
  const rows = await b.db.query<{id:string;remotePayload:string}>("SELECT id,remotePayload FROM sync_conflicts WHERE profileId=? AND entityId=? AND status='unresolved'", [b.profileId,node]);
  assert.equal(rows.length, 1); assert.equal(JSON.parse(rows[0].remotePayload).parentId, left);
  assert.equal((await b.db.query<{parentId:string}>("SELECT parentId FROM native_knowledge_tree_nodes WHERE id=?", [node]))[0].parentId, right);
  await b.repository.movePersonalTreeNodes([{ id: node, parentId: right, sortOrder: 33 }]);
  await b.engine.resolveLocalConflict(rows[0].id, resolution); await b.sync(); await a.sync();
  assert.equal((await conflicts(b)).length, 0); assert.equal((await pending(b)).length, 0);
  const expected = { parentId: resolution === "keep-local" ? right : left, sortOrder: resolution === "keep-local" ? 33 : 11 };
  assert.deepEqual(serverDb.prepare("SELECT parentId,sortOrder FROM knowledge_tree_nodes WHERE id=?").get(node), expected);
  assert.deepEqual((await a.db.query("SELECT parentId,sortOrder FROM native_knowledge_tree_nodes WHERE id=?", [node]))[0], expected);
});

test("lost tree Push ACK and a newer move during Push retain stable mutation identities", async () => {
  const { c, node, left, right } = await movableTree("active-lost-ack");
  await c.repository.movePersonalTreeNodes([{ id: node, parentId: left, sortOrder: 3 }]);
  const first = (await pending(c))[0].mutationId;
  afterPush = async () => {
    await c.repository.movePersonalTreeNodes([{ id: node, parentId: right, sortOrder: 4 }]);
    return Response.json({code:"SERVER_ERROR"}, {status:503});
  };
  try { await c.sync(); } finally { afterPush = undefined; }
  assert.equal((await pending(c))[0].mutationId, first);
  await c.db.close(); const reopened = await client("active-lost-ack"); await reopened.sync();
  assert.equal((await pending(reopened)).length, 0); assert.equal((await conflicts(reopened)).length, 0);
  assert.deepEqual(serverDb.prepare("SELECT parentId,sortOrder FROM knowledge_tree_nodes WHERE id=?").get(node), { parentId: right, sortOrder: 4 });
});

test("native tree writes reject missing subscription, protected ancestry and cycles without partial commits", async () => {
  const { c, node, left } = await movableTree("active-guards");
  await assert.rejects(c.repository.movePersonalTreeNodes([{ id: node, parentId: left }, { id: left, parentId: node }]), /循环/);
  assert.equal((await pending(c)).length, 0);
  const cached = (await c.db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key='knowledgeTreeSnapshot:v1:personal:0'"))[0];
  const nodes = JSON.parse(cached.value) as Array<{id:string;isPasswordProtected?:number}>;
  nodes.find((n) => n.id === left)!.isPasswordProtected = 1;
  await c.db.run("UPDATE native_runtime_meta SET value=? WHERE key='knowledgeTreeSnapshot:v1:personal:0'", [JSON.stringify(nodes)]);
  await assert.rejects(c.repository.movePersonalTreeNodes([{ id: node, parentId: left }]), /权限|密码/);
  await c.db.run("DELETE FROM native_runtime_meta WHERE key=?", [`nativeTreeSubscription:${c.profileId}:personal`]);
  await assert.rejects(c.repository.movePersonalTreeNodes([{ id: node, parentId: null }]), /订阅/);
  assert.equal((await pending(c)).length, 0);
  assert.equal((await c.db.query<{parentId:string|null}>("SELECT parentId FROM native_knowledge_tree_nodes WHERE id=?", [node]))[0].parentId, null);
});

test("a structural Outbox insert failure rolls back every move in the local batch", async () => {
  const { c,node,left,right } = await movableTree("active-write-failure");
  await c.db.run(`CREATE TRIGGER reject_fixture_tree BEFORE INSERT ON sync_outbox
    WHEN NEW.entityType='knowledge_tree_node' AND NEW.entityId='${left}' BEGIN SELECT RAISE(ABORT,'Outbox fixture failure'); END`);
  await assert.rejects(c.repository.movePersonalTreeNodes([{id:node,parentId:right},{id:left,parentId:right}]), /Outbox fixture failure/);
  assert.equal((await pending(c)).length,0);
  assert.equal((await c.db.query<{parentId:string|null}>("SELECT parentId FROM native_knowledge_tree_nodes WHERE id=?",[node]))[0].parentId,null);
});

test("full tree rebuild preserves newer pending moves and recognizes an intermediate lost ACK echo", async () => {
  const { c,node,left,right } = await movableTree("active-snapshot-pending");
  await c.repository.movePersonalTreeNodes([{id:node,parentId:left,sortOrder:1}]);
  await c.db.run("UPDATE sync_state SET lastSequence=0 WHERE profileId=?",[c.profileId]);
  afterPush = async (response) => {
    const body = await response.json() as {serverSequence:number;results:Array<{mutationId:string}>};
    await c.repository.movePersonalTreeNodes([{id:node,parentId:right,sortOrder:2}]);
    return Response.json({...body,results:body.results.map((r)=>({...r,status:"failed",code:"NETWORK_UNAVAILABLE"}))});
  };
  try { await c.sync(); } finally { afterPush=undefined; }
  assert.equal((await conflicts(c)).length,0);
  assert.equal((await c.db.query<{parentId:string}>("SELECT parentId FROM native_knowledge_tree_nodes WHERE id=?",[node]))[0].parentId,right);
  await c.sync(); assert.equal((await pending(c)).length,0); assert.equal((await conflicts(c)).length,0);
  assert.deepEqual(serverDb.prepare("SELECT parentId,sortOrder FROM knowledge_tree_nodes WHERE id=?").get(node),{parentId:right,sortOrder:2});
});

test.before(async () => {
  const schema = await import("../src/db/schema");
  const routes = await import("../src/routes/sync-v2");
  const treeRoutes = await import("../src/routes/knowledge-tree");
  serverDb = schema.getDb(); closeServerDb = schema.closeDb;
  for (const user of [USER, "other-user"]) serverDb.prepare("INSERT INTO users (id,username,passwordHash,createdAt,updatedAt) VALUES (?,?,'x','now','now')").run(user, user);
  const app = new Hono();
  // Route tests use fixture identities; production auth remains in index.ts.
  app.use("*", async (c, next) => {
    c.req.raw.headers.set("X-User-Id", c.req.header("Authorization")?.replace("Bearer ", "") || "");
    await next();
    if (c.req.path.endsWith("/push") && afterPush) c.res = await afterPush(c.res);
    if (c.req.path.endsWith("/snapshot") && afterSnapshot) c.res = await afterSnapshot(c.res);
    if (c.req.path.endsWith("/ack") && afterAck) c.res = await afterAck(c.res);
  });
  app.route("/api/sync/v2", routes.default);
  app.route("/api/knowledge-tree/", treeRoutes.default);
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

test("personal tree creates are readable offline, survive reopen and converge with stable root identities", async () => {
  const name = "tree-offline", a = await client(name);
  const ids: string[] = [];
  for (const contentFormat of ["markdown", "tiptap-json"] as const) {
    const id = randomUUID(); ids.push(id);
    await a.repository.createPersonalTreeNote({ id, title: "Offline root", contentFormat, content: "offline body" }, null);
    assert.equal((await a.repository.notes.get(id))?.content, "offline body");
  }
  assert.equal((await a.repository.listLocalTreeDrafts()).length, 2);
  assert.equal((await a.repository.notebooks.list()).length, 0, "internal root container stays hidden");
  await a.db.close();
  const reopened = await client(name), b = await client("tree-reader");
  assert.equal((await reopened.repository.listLocalTreeDrafts()).length, 2);
  for (const id of ids) assert.equal((await reopened.repository.notes.get(id))?.content, "offline body");
  await reopened.sync(); await b.sync();
  assert.equal((await pending(reopened)).length, 0);
  for (const id of ids) {
    assert.equal((await b.repository.notes.get(id))?.content, "offline body");
    assert.equal(serverDb.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id=?").get(`note:${id}`).parentId, null);
  }
});

test("negotiated native tree preserves folder-under-document links and remote moves across reopen", async () => {
  const a = await client("structure-writer"), b = await client("structure-reader");
  const book = randomUUID(), note = randomUUID();
  await a.repository.notebooks.create({ id: book, name: "Tree folder" });
  await a.repository.createPersonalTreeNote({ id: note, contentFormat: "markdown", content: "Tree body" }, null);
  await a.sync();
  serverDb.prepare("UPDATE knowledge_tree_nodes SET parentId=?,sortOrder=17 WHERE id=?")
    .run(`note:${note}`, `notebook:${book}`);
  await b.sync();
  const row = (await b.db.query<{ parentId: string; sortOrder: number }>("SELECT parentId,sortOrder FROM native_knowledge_tree_nodes WHERE scopeKey='personal' AND id=?", [`notebook:${book}`]))[0];
  assert.deepEqual(row, { parentId: `note:${note}`, sortOrder: 17 });
  assert.equal((await b.repository.notebooks.get(book))?.parentId, null, "legacy resource parent does not flatten the tree");
  assert.equal((await b.repository.notes.get(note))?.content, "Tree body");
  const binding = serverDb.prepare("SELECT entitySet FROM sync_v2_clients WHERE deviceId=? AND userId=? AND scopeKey='personal'").get("structure-reader", USER) as { entitySet: string };
  assert.ok(binding.entitySet.includes("knowledge_tree_node"));
  await b.db.close();
  const reopened = await client("structure-reader");
  assert.equal((await reopened.db.query<{parentId:string}>("SELECT parentId FROM native_knowledge_tree_nodes WHERE id=?", [`notebook:${book}`]))[0].parentId, `note:${note}`);
  serverDb.prepare("UPDATE knowledge_tree_nodes SET parentId=NULL,sortOrder=18 WHERE id=?").run(`notebook:${book}`);
  await reopened.sync();
  assert.deepEqual((await reopened.db.query("SELECT parentId,sortOrder FROM native_knowledge_tree_nodes WHERE id=?", [`notebook:${book}`]))[0], { parentId: null, sortOrder: 18 });
});

test("a new native tree subscription rebuilds an existing legacy cursor without discarding local edits", async () => {
  const c = await client("structure-upgrade"), book = randomUUID(), note = randomUUID();
  await c.repository.notebooks.create({ id: book, name: "Upgrade folder" });
  await c.repository.createPersonalTreeNote({ id: note, contentFormat: "markdown", content: "Pending body" }, null);
  await c.db.run("INSERT INTO sync_state (profileId,scopeKey,lastSequence,accessStatus,accessFingerprint) VALUES (?,'personal',999999,'active','personal:owner')", [c.profileId]);
  await c.sync();
  assert.equal((await pending(c)).length, 0);
  assert.equal((await c.repository.notes.get(note))?.content, "Pending body");
  assert.ok((await c.db.query("SELECT id FROM native_knowledge_tree_nodes WHERE id=?", [`notebook:${book}`])).length);
  const state = (await c.db.query<{lastSequence:number;lastError:string|null}>("SELECT lastSequence,lastError FROM sync_state WHERE profileId=?", [c.profileId]))[0];
  assert.equal(state.lastError, null);
  assert.ok(state.lastSequence < 999999, "the new entity set must not inherit the legacy high-water mark");
});

test("lost initial tree ACK retains subscription intent and replays the complete baseline after reopen", async () => {
  const c = await client("structure-lost-ack"), id = randomUUID();
  await c.repository.notebooks.create({ id,name:"Lost tree ACK" });
  afterAck = async () => Response.json({code:"SERVER_ERROR"},{status:503});
  try { await c.sync(); } finally { afterAck = undefined; }
  const marker = (await c.db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key=?", [`nativeTreeSubscription:${c.profileId}:personal`]))[0];
  assert.ok(marker.value.startsWith("pending:"));
  assert.ok((await c.db.query("SELECT id FROM native_knowledge_tree_nodes WHERE id=?", [`notebook:${id}`])).length);
  assert.equal((await c.db.query<{lastSequence:number}>("SELECT lastSequence FROM sync_state WHERE profileId=?", [c.profileId]))[0].lastSequence, 0);
  await c.db.close();
  const reopened = await client("structure-lost-ack"); await reopened.sync();
  assert.equal((await reopened.db.query<{lastError:string|null}>("SELECT lastError FROM sync_state WHERE profileId=?", [c.profileId]))[0].lastError, null);
  assert.ok(!(await reopened.db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key=?", [`nativeTreeSubscription:${c.profileId}:personal`]))[0].value.startsWith("pending:"));
});

test("REST tree movement emits a committed metadata-only Sync V2 notice and wakes the negotiated receiver", async () => {
  const c = await client("structure-rest-notice"), id = randomUUID();
  await c.repository.notebooks.create({id,name:"Private folder title must not enter notice"}); await c.sync();
  // Match routes' CommonJS loader; a late native import creates a separate tsx
  // module instance and cannot register their broadcaster in this test process.
  const {setSyncBroadcaster} = createRequire(path.resolve(__dirname,"../package.json"))("./src/sync/notify.ts") as typeof import("../src/sync/notify");
  const notices: Array<{recipient:string;notice:Record<string,unknown>;committed:boolean;sortOrder:number}> = [];
  setSyncBroadcaster((recipient,notice) => {
    notices.push({recipient,notice:notice as Record<string,unknown>,committed:!serverDb.inTransaction,
      sortOrder:(serverDb.prepare("SELECT sortOrder FROM knowledge_tree_nodes WHERE id=?").get(`notebook:${id}`) as {sortOrder:number}).sortOrder});
  });
  try {
    const before = (serverDb.prepare("SELECT MAX(sequence) AS sequence FROM sync_changes_v2").get() as {sequence:number}).sequence;
    const response = await fetch(`${serverUrl}/api/knowledge-tree/nodes/${encodeURIComponent(`notebook:${id}`)}/move`, {method:"PUT",headers:{Authorization:`Bearer ${USER}`,"Content-Type":"application/json"},body:JSON.stringify({parentId:null,sortOrder:17})});
    assert.equal(response.status,200);
    assert.equal(notices.length,1,JSON.stringify(serverDb.prepare("SELECT entityType,userId,workspaceId FROM sync_changes_v2 WHERE sequence>?").all(before))); assert.equal(notices[0].recipient,USER);
    assert.equal(notices[0].committed,true); assert.equal(notices[0].sortOrder,17);
    assert.deepEqual(Object.keys(notices[0].notice).sort(),["accessFingerprint","scopeKey","sequence","type"]);
    assert.equal(notices[0].notice.type,"sync.changed"); assert.equal(notices[0].notice.scopeKey,"personal");
    const rejected = await fetch(`${serverUrl}/api/knowledge-tree/nodes/${encodeURIComponent(`notebook:${id}`)}/move`, {method:"PUT",headers:{Authorization:"Bearer other-user","Content-Type":"application/json"},body:JSON.stringify({parentId:null,sortOrder:18})});
    assert.equal(rejected.status,403); assert.equal(notices.length,1);
  } finally {setSyncBroadcaster(null);}
  await c.sync();
  assert.equal((await c.db.query<{sortOrder:number}>("SELECT sortOrder FROM native_knowledge_tree_nodes WHERE id=?", [`notebook:${id}`]))[0].sortOrder,17);
});

test("invalid remote tree rolls back incremental bodies and structure without acknowledging the cursor", async () => {
  const c = await client("structure-invalid"), note = randomUUID();
  await c.repository.createPersonalTreeNote({ id: note, contentFormat: "markdown", content: "Before invalid tree" }, null);
  await c.sync();
  const checkpoint = (await c.db.query<{lastSequence:number}>("SELECT lastSequence FROM sync_state WHERE profileId=?", [c.profileId]))[0].lastSequence;
  const original = (await c.db.query("SELECT * FROM native_knowledge_tree_nodes WHERE id=?", [`note:${note}`]))[0];
  serverDb.prepare("UPDATE notes SET content='After remote edit',version=version+1 WHERE id=?").run(note);
  serverDb.prepare("UPDATE knowledge_tree_nodes SET sortOrder=sortOrder+1 WHERE id=?").run(`note:${note}`);
  afterSnapshot = async (response) => {
    const body = await response.json() as {items:Array<{entityId:string;entityType:string;payload:Record<string,unknown>}>};
    for (const item of body.items || []) if (item.entityType === "knowledge_tree_node" && item.entityId === `note:${note}`) item.payload.parentId = item.entityId;
    return Response.json(body, {status:response.status});
  };
  try { await c.sync(); } finally { afterSnapshot = undefined; }
  assert.equal((await c.repository.notes.get(note))?.content, "Before invalid tree");
  assert.deepEqual((await c.db.query("SELECT * FROM native_knowledge_tree_nodes WHERE id=?", [`note:${note}`]))[0], original);
  const state = (await c.db.query<{lastSequence:number;lastError:string}>("SELECT lastSequence,lastError FROM sync_state WHERE profileId=?", [c.profileId]))[0];
  assert.equal(state.lastSequence, checkpoint); assert.equal(state.lastError, "INVALID_TREE_STRUCTURE");
  assert.equal((serverDb.prepare("SELECT lastSequence FROM sync_v2_clients WHERE deviceId=? AND userId=? AND scopeKey='personal'").get("structure-invalid", USER) as {lastSequence:number}).lastSequence, checkpoint);
  await c.sync();
  assert.equal((await c.repository.notes.get(note))?.content, "After remote edit");
});

test("native structural Apply rejects foreign scopes, identities and missing dependencies without altering Outbox", async () => {
  const c = await client("structure-validation"), id = randomUUID();
  await c.repository.notebooks.create({ id, name: "Validation" });
  const entry = { entityId:`notebook:${id}`, payload: { id:`notebook:${id}`, userId:USER, workspaceId:null,
    parentId:null, nodeType:"folder", resourceType:"notebook", resourceId:id, sortOrder:0, isDeleted:0, deletedAt:null, createdAt:"now", updatedAt:"now" } };
  await c.db.transaction((tx) => applyNativePersonalTree(tx,[entry],USER,true));
  const queued = await pending(c);
  for (const patch of [{userId:"other-user"}, {workspaceId:"foreign"}, {scopeKey:"workspace:foreign"}, {resourceId:"missing"}, {parentId:"notebook:missing"}, {sortOrder:-1}, {sortOrder:1.5}, {nodeType:"file"}, {parentId:entry.entityId}]) {
    await assert.rejects(c.db.transaction((tx) => applyNativePersonalTree(tx,[{...entry,payload:{...entry.payload,...patch}}],USER,true)), {code:"INVALID_TREE_STRUCTURE"});
    assert.deepEqual((await c.db.query("SELECT parentId,sortOrder FROM native_knowledge_tree_nodes WHERE id=?", [entry.entityId]))[0], {parentId:null,sortOrder:0});
    assert.deepEqual(await pending(c), queued);
  }
});

test("native file tree metadata requires its scoped attachment without claiming bytes or authorization", async () => {
  const c = await client("structure-file"), note = randomUUID(), file = randomUUID();
  await c.repository.createPersonalTreeNote({ id:note, contentFormat:"markdown", content:"Attachment owner" },null);
  const root = {entityId:`note:${note}`,payload:{id:`note:${note}`,userId:USER,workspaceId:null,parentId:null,nodeType:"markdown",resourceType:"note",resourceId:note,sortOrder:0,isDeleted:0,deletedAt:null,createdAt:"now",updatedAt:"now"}};
  const entry = {entityId:`file:${file}`,payload:{...root.payload,id:`file:${file}`,parentId:root.entityId,nodeType:"file",resourceType:"file",resourceId:file}};
  await assert.rejects(c.db.transaction((tx) => applyNativePersonalTree(tx,[root,entry],USER,true)), {code:"INVALID_TREE_STRUCTURE"});
  await c.db.run(`INSERT INTO attachments (id,scopeKey,workspaceId,noteId,userId,filename,mimeType,size,available,transferStatus,createdAt,updatedAt)
    VALUES (?,'personal',NULL,?,?,'fixture.txt','text/plain',1,0,'remote','now','now')`, [file,note,USER]);
  const queued = await pending(c);
  await c.db.transaction((tx) => applyNativePersonalTree(tx,[root,entry],USER,true));
  assert.equal((await c.db.query<{parentId:string}>("SELECT parentId FROM native_knowledge_tree_nodes WHERE id=?", [entry.entityId]))[0].parentId, root.entityId);
  assert.equal((await c.db.query<{available:number}>("SELECT available FROM attachments WHERE id=?", [file]))[0].available, 0);
  assert.deepEqual(await pending(c), queued);
  assert.equal((await c.db.query("SELECT key FROM native_runtime_meta WHERE key LIKE 'knowledgeTreeSnapshot:%'")).length, 0);
});

test("native structural Apply validates final ancestry and deletes parent/child in either order", async () => {
  const c = await client("structure-reversal"), a = randomUUID(), b = randomUUID();
  for (const id of [a,b]) await c.repository.notebooks.create({ id, name:"Reversal" });
  const entry = (id:string,parentId:string|null) => ({entityId:`notebook:${id}`,payload:{id:`notebook:${id}`,userId:USER,workspaceId:null,parentId,
    nodeType:"folder",resourceType:"notebook",resourceId:id,sortOrder:0,isDeleted:0,deletedAt:null,createdAt:"now",updatedAt:"now"}});
  await c.db.transaction((tx) => applyNativePersonalTree(tx,[entry(a,`notebook:${b}`),entry(b,null)],USER,true));
  await c.db.transaction((tx) => applyNativePersonalTree(tx,[entry(b,`notebook:${a}`),entry(a,null)],USER,false));
  await assert.rejects(c.db.transaction((tx) => applyNativePersonalTree(tx,[{entityId:`notebook:${a}`,payload:{__delete:true}}],USER,false)), {code:"INVALID_TREE_STRUCTURE"});
  assert.equal((await c.db.query("SELECT id FROM native_knowledge_tree_nodes")).length, 2);
  await c.db.transaction((tx) => applyNativePersonalTree(tx,[a,b].map((id) => ({entityId:`notebook:${id}`,payload:{__delete:true}})),USER,false));
  assert.equal((await c.db.query("SELECT id FROM native_knowledge_tree_nodes")).length, 0);
  assert.equal((await pending(c)).length, 2, "structural deletes do not delete business rows or queued changes");
});

test("native tree Snapshot reconciles stale metadata after remote permanent deletion", async () => {
  const c = await client("structure-prune"), note = randomUUID();
  await c.repository.createPersonalTreeNote({ id:note, contentFormat:"markdown", content:"Deleted remote root" },null);
  await c.sync();
  serverDb.prepare("DELETE FROM notes WHERE id=?").run(note);
  await c.db.run("UPDATE sync_state SET accessStatus='replan_required' WHERE profileId=?", [c.profileId]);
  await c.sync();
  assert.equal((await c.db.query("SELECT id FROM native_knowledge_tree_nodes WHERE id=?", [`note:${note}`])).length, 0);
});

test("tree create rolls back body, root container and provenance when Outbox insertion fails", async () => {
  const c = await client("tree-rollback"), id = randomUUID();
  await c.db.run("CREATE TRIGGER reject_tree_outbox BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT,'fixture outbox failure'); END");
  await assert.rejects(c.repository.createPersonalTreeNote({ id, contentFormat: "markdown" }, null), /outbox failure/);
  assert.equal(await c.repository.notes.get(id), null);
  assert.equal((await c.db.query("SELECT id FROM notebooks")).length, 0);
  assert.equal((await c.repository.listLocalTreeDrafts()).length, 0);
});

test("authorized hydration persists a remote body without creation mutations and preserves newer local writes", async () => {
  const c = await client("hydrate"), id = randomUUID(), book = randomUUID();
  const notebook = { id: book, userId: USER, workspaceId: null, name: "Remote folder", parentId: null } as never;
  const remote = { id, userId: USER, workspaceId: null, notebookId: book, title: "Remote", content: "remote body", contentFormat: "markdown", version: 4 } as never;
  await c.repository.hydrateAuthorizedNote(remote, notebook);
  assert.equal((await c.repository.notes.get(id))?.content, "remote body");
  assert.equal((await pending(c)).length, 0);
  await c.repository.notes.update(id, { content: "new local body" });
  await c.repository.hydrateAuthorizedNote(remote, notebook);
  assert.equal((await c.repository.notes.get(id))?.content, "new local body");
  assert.equal((await pending(c))[0].baseVersion, 4);
  await c.repository.notes.remove(id);
  await assert.rejects(c.repository.hydrateAuthorizedNote(remote, notebook), /本机.*删除/);
  assert.equal(await c.repository.notes.get(id), null);
  await assert.rejects(c.repository.hydrateAuthorizedNote({ ...remote, id: randomUUID(), userId: "other-user" }, notebook), /身份|空间/);
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

test("native tree subscription completes multiple Snapshot pages before binding and survives incremental deletion", async () => {
  const c = await client("structure-pagination"), ids = Array.from({length:230},() => randomUUID());
  const insert = serverDb.prepare("INSERT INTO notebooks (id,userId,workspaceId,parentId,name,createdAt,updatedAt) VALUES (?,?,NULL,NULL,'Paged tree','now','now')");
  serverDb.transaction(() => { for (const id of ids) insert.run(id,USER); })();
  await c.sync();
  const rows = await c.db.query<{id:string}>("SELECT id FROM native_knowledge_tree_nodes");
  for (const id of ids) assert.ok(rows.some((row) => row.id === `notebook:${id}`));
  assert.equal((await c.db.query<{lastError:string|null}>("SELECT lastError FROM sync_state WHERE profileId=?", [c.profileId]))[0].lastError, null);
  serverDb.prepare("DELETE FROM notebooks WHERE id=?").run(ids[0]);
  await c.sync();
  assert.equal((await c.db.query("SELECT id FROM native_knowledge_tree_nodes WHERE id=?", [`notebook:${ids[0]}`])).length, 0);
});
