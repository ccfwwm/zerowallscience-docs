import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { openNativeDatabase } from "../nativeDatabase";
import { cacheConfirmedNativeTasks } from "../nativeTaskComposerCache";
import type { Task } from "@/types";
import { installMobileLocalModuleBridge } from "../mobileLocalModuleBridge";
import { updateRepeatingTaskOnline } from "../taskComposerApi";
vi.mock("../taskComposerApi", () => ({ registerTaskComposerCache: () => () => undefined, updateRepeatingTaskOnline: vi.fn(), getTaskComposerContext: () => ({}), isTaskComposerContextCurrent: () => true, TaskComposerApiError: class extends Error {} }));
vi.mock("../mobileLocalMode", () => ({ isMobileLocalMode: () => false }));

const fixture = vi.hoisted(() => ({ raw: undefined as unknown as DatabaseSync, fail: false }));
const { DatabaseSync: SQLiteDatabase } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@capacitor-community/sqlite", () => ({
  CapacitorSQLite: {}, SQLiteConnection: class {
    async checkConnectionsConsistency() { return {result:true}; }
    async isConnection() { return {result:false}; }
    async closeConnection() {}
    async createConnection() { return {
      isDBOpen: async () => ({result:true}), close: async () => {},
      execute: async (sql:string) => {
        if (fixture.fail && sql === "ALTER TABLE sync_conflicts_v2 RENAME TO sync_conflicts") throw new Error("Migration interruption");
        fixture.raw.exec(sql); return {};
      },
      run: async (sql:string, values: never[] = []) => ({changes:fixture.raw.prepare(sql).run(...values)}),
      query: async (sql:string, values: never[] = []) => ({values:fixture.raw.prepare(sql).all(...values)}),
    }; }
  },
}));

beforeEach(() => {
  Reflect.deleteProperty(globalThis,"__nowenNoteNativeDatabaseState");
  fixture.fail = false; fixture.raw = new SQLiteDatabase(":memory:");
  fixture.raw.exec("PRAGMA foreign_keys=ON");
  const source = readFileSync(new NodeURL("../nativeDatabase.ts",import.meta.url),"utf8");
  const scope = source.match(/const SCOPE_CHECK = `([\s\S]*?)`;/)![1];
  const types = source.match(/const ENTITY_TYPE_CHECK = `([\s\S]*?)`;/)![1].replace(", 'knowledge_tree_node'","");
  for (const [,sql] of source.matchAll(/`(CREATE TABLE IF NOT EXISTS [\s\S]*?)`/g)) {
    fixture.raw.exec(sql.replaceAll("${SCOPE_CHECK}",scope).replaceAll("${ENTITY_TYPE_CHECK}",types));
  }
  fixture.raw.exec(`PRAGMA user_version=6;
    INSERT INTO sync_profiles(id,name,serverUrl,remoteUserId,createdAt,updatedAt) VALUES ('p','fixture','http://localhost','u','now','now');
    INSERT INTO sync_devices(profileId,deviceId,platform,createdAt) VALUES ('p','d','android','now');
    INSERT INTO sync_outbox(id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,baseVersion,payload,status,retryCount,lastAttemptAt,lastError,createdAt)
      VALUES ('o','stable-mutation','p','d','personal','note','n','upsert',17,'{"content":"fixture"}','inflight',4,'attempt','NETWORK_UNAVAILABLE','created');
    INSERT INTO sync_conflicts(id,profileId,scopeKey,entityType,entityId,localVersion,remoteVersion,basePayload,localPayload,remotePayload,status,createdAt,resolvedAt)
      VALUES ('c','p','personal','note','n',18,19,'{}','{"side":"local"}','{"side":"remote"}','resolved','created','resolved');`);
});
afterEach(() => { fixture.raw.close(); Reflect.deleteProperty(globalThis,"__nowenNoteNativeDatabaseState"); });

it("migrates schema 6 queues without losing mutation identity, retries, versions or resolved history", async () => {
  const before = fixture.raw.prepare("SELECT * FROM sync_outbox").all(), history = fixture.raw.prepare("SELECT * FROM sync_conflicts").all();
  const db = await openNativeDatabase("tree-migration-fixture");
  expect(fixture.raw.prepare("SELECT * FROM sync_outbox").all()).toEqual(before);
  expect(fixture.raw.prepare("SELECT * FROM sync_conflicts").all()).toEqual(history);
  expect(fixture.raw.prepare("PRAGMA user_version").get()).toEqual({user_version:8});
  await db.run(`INSERT INTO sync_outbox(id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,createdAt)
    VALUES ('tree','tree-mutation','p','d','personal','knowledge_tree_node','note:n','upsert','now')`);
  expect(fixture.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  await db.close();
});

it("rolls back both queue rebuilds and schema version when the second rebuild fails", async () => {
  const before = fixture.raw.prepare("SELECT * FROM sync_outbox").all(), history = fixture.raw.prepare("SELECT * FROM sync_conflicts").all();
  fixture.fail = true;
  await expect(openNativeDatabase("tree-migration-fixture")).rejects.toThrow("Migration interruption");
  expect(fixture.raw.prepare("PRAGMA user_version").get()).toEqual({user_version:6});
  expect(fixture.raw.prepare("SELECT * FROM sync_outbox").all()).toEqual(before);
  expect(fixture.raw.prepare("SELECT * FROM sync_conflicts").all()).toEqual(history);
  expect(fixture.raw.prepare("SELECT sql FROM sqlite_master WHERE name='sync_outbox'").get()?.sql).not.toContain("knowledge_tree_node");
});

it("upgrades schema 7 task rows without inventing archives or losing pending mutations",async () => {
  fixture.raw.exec("ALTER TABLE tasks DROP COLUMN archivedAt; PRAGMA user_version=7");
  fixture.raw.exec(`INSERT INTO tasks (id,userId,title,isCompleted,completedAt,status,createdAt,updatedAt)
    VALUES ('task','u','Historical task',1,'2026-10-12T10:00:00Z','done','created','updated')`);
  const task=fixture.raw.prepare("SELECT * FROM tasks").get();
  const outbox=fixture.raw.prepare("SELECT * FROM sync_outbox").all();
  const db=await openNativeDatabase("task-migration-fixture");
  expect(fixture.raw.prepare("SELECT * FROM tasks").get()).toEqual({...task,archivedAt:null});
  expect(fixture.raw.prepare("SELECT * FROM sync_outbox").all()).toEqual(outbox);
  expect(fixture.raw.prepare("PRAGMA user_version").get()).toEqual({user_version:8});
  await db.close();
});

it("upgrades schema 7 task recurrence and caches confirmed batches without overwriting edits or Outbox", async () => {
  fixture.raw.exec("PRAGMA user_version=7; INSERT INTO tasks(id,userId,title,createdAt,updatedAt) VALUES ('old','local','Preserved','now','now')");
  const before = fixture.raw.prepare("SELECT * FROM sync_outbox").all();
  const db = await openNativeDatabase("task-composer-fixture");
  expect(fixture.raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 });
  expect(fixture.raw.prepare("SELECT title,repeatRule FROM tasks WHERE id='old'").get()).toEqual({ title: "Preserved", repeatRule: "none" });
  const task = { id: "confirmed", workspaceId: null, userId: "remote", title: "Daily study", description: "Practice", priority: 2, isCompleted: 0, dueDate: "2026-12-31", dueAt: "2026-12-31T09:00", repeatRule: "daily", repeatInterval: 1, repeatEndCount: 7, createdAt: "now", updatedAt: "now" } as Task;
  await cacheConfirmedNativeTasks(db, "local", [task], [{ id: "remote-project", userId: "remote", workspaceId: null, name: "Server project", icon: "", color: "#123456", sortOrder: 0, createdAt: "now", updatedAt: "now" }]);
  expect(await db.query("SELECT name,userId FROM mobile_local_task_projects WHERE id='remote-project'")).toEqual([{ name: "Server project", userId: "local" }]);
  const row = fixture.raw.prepare("SELECT title,dueAt,repeatRule,repeatEndCount,userId FROM tasks WHERE id='confirmed'").get();
  expect(row).toEqual({ title: "Daily study", dueAt: "2026-12-31T09:00", repeatRule: "daily", repeatEndCount: 7, userId: "local" });
  await db.run("UPDATE tasks SET title='Local edit' WHERE id='confirmed'");
  await cacheConfirmedNativeTasks(db, "local", [task]);
  expect(fixture.raw.prepare("SELECT title FROM tasks WHERE id='confirmed'").get()).toEqual({ title: "Local edit" });
  expect(fixture.raw.prepare("SELECT * FROM sync_outbox").all()).toEqual(before);
  await db.close();
});

it("native recurring completion uses the canonical online route, caches its successor and preserves pending edits", async () => {
  vi.mocked(updateRepeatingTaskOnline).mockReset();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  const db = await openNativeDatabase("task-repeat-fixture");
  const task = { id: "repeat", workspaceId: null, userId: "local", title: "Study", priority: 2, isCompleted: 0, dueDate: "2026-12-31", repeatRule: "daily", repeatInterval: 1, repeatEndCount: 7, createdAt: "now", updatedAt: "now" } as Task;
  await cacheConfirmedNativeTasks(db, "local", [task]);
  const successor = { ...task, id: "next", dueDate: "2027-01-01", repeatSequenceIndex: 2 };
  vi.mocked(updateRepeatingTaskOnline).mockResolvedValue({ task: { ...task, isCompleted: 1, status: "done", repeatNextGeneratedId: "next" }, generatedTask: successor });
  const restore = installMobileLocalModuleBridge({} as never, db, "local");
  try {
    const result = await api.toggleTask("repeat");
    expect(result.generatedTask?.id).toBe("next");
    expect(await db.query("SELECT dueDate,repeatEndCount FROM tasks WHERE id='next'")).toEqual([{ dueDate: "2027-01-01", repeatEndCount: 7 }]);
    expect(await db.query("SELECT id FROM sync_outbox WHERE entityType='task'")).toEqual([]);
    Object.defineProperty(navigator, "onLine", { value: false });
    await expect(api.toggleTask("next")).rejects.toThrow();
    expect((await db.query<Task>("SELECT * FROM tasks WHERE id='next'"))[0].isCompleted).toBe(0);
    Object.defineProperty(navigator, "onLine", { value: true });
    await db.run("INSERT INTO sync_outbox(id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,createdAt) VALUES ('task-pending','task-pending','p','d','personal','task','next','upsert','now')");
    await expect(api.toggleTask("next")).rejects.toThrow();
    expect(updateRepeatingTaskOnline).toHaveBeenCalledOnce();
    expect(await db.query("SELECT id FROM sync_outbox WHERE id='task-pending'")).toHaveLength(1);
    vi.mocked(updateRepeatingTaskOnline).mockImplementationOnce(async () => {
      await db.run("UPDATE tasks SET title='Concurrent edit' WHERE id='repeat'");
      await db.run("INSERT INTO sync_outbox(id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,createdAt) VALUES ('concurrent','concurrent','p','d','personal','task','repeat','upsert','now')");
      return { task: { ...task, isCompleted: 0 }, generatedTask: null };
    });
    expect((await api.toggleTask("repeat")).task?.title).toBe("Concurrent edit");
    expect(await db.query("SELECT id FROM sync_outbox WHERE id='concurrent'")).toHaveLength(1);
  } finally { restore(); await db.close(); }
});
