import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { openNativeDatabase } from "../nativeDatabase";

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
  expect(fixture.raw.prepare("PRAGMA user_version").get()).toEqual({user_version:7});
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
