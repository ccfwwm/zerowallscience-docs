// Test-only entry. Included only by vite.android-sync.config.ts, never normal builds.
import { openNativeDatabase } from "../../src/lib/nativeDatabase";
import { createNativeAttachmentStore } from "../../src/lib/nativeAttachmentStore";
import { NativeLocalRepository } from "../../src/lib/nativeLocalRepository";
import { MobileSyncEngine } from "../../src/lib/mobileSyncEngine";
import { installMobileSyncRealtime } from "../../src/lib/mobileSyncRealtime";
import { setMobileSyncEnabled } from "../../src/lib/mobileSyncStatus";
import { readNativeNoteSyncReceipt } from "../../src/lib/mobileNoteSyncReceipt";
import { realtime } from "../../src/lib/realtime";

type Config = { serverUrl: string; token: string; userId: string };
async function initialize(config: Config) {
  localStorage.setItem("sync-acceptance-config", JSON.stringify(config));
  localStorage.setItem("nowen-token", config.token);
  localStorage.setItem("nowen-server-url", config.serverUrl);
  const profileId = "isolated-acceptance", deviceId = "android-acceptance";
  const accountId = `sync-acceptance:${config.userId}`;
  const db = await openNativeDatabase(accountId);
  const attachments = await createNativeAttachmentStore(accountId);
  await db.run(`INSERT OR IGNORE INTO sync_profiles (id,name,serverUrl,remoteUserId,enabled,createdAt,updatedAt)
    VALUES (?,'Acceptance',?,?,1,'now','now')`, [profileId, config.serverUrl, config.userId]);
  await db.run("INSERT OR IGNORE INTO sync_devices (profileId,deviceId,platform,createdAt) VALUES (?,?,'android','now')", [profileId, deviceId]);
  const engine = new MobileSyncEngine({ db, attachments, profileId, deviceId, ...config });
  const repository = new NativeLocalRepository({ db, attachments, accountId, userId: config.userId,
    getScopeKey: () => "personal", requestSync: () => engine.requestSync(150) });
  let dispose: (() => void) | undefined;
  const ids = async () => {
    const row = (await db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key='acceptance-note-ids'"))[0];
    return JSON.parse(row?.value || "[]") as string[];
  };
  const acceptance = {
    async createOffline() {
      const book = crypto.randomUUID(), notes = [crypto.randomUUID(), crypto.randomUUID()];
      await repository.notebooks.create({ id: book, name: "Acceptance" });
      for (const [index, id] of notes.entries()) await repository.notes.create({ id, notebookId: book,
        contentFormat: index ? "tiptap-json" : "markdown",
        content: index ? JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "offline-rich" }] }] }) : "offline-markdown",
        contentText: index ? "offline-rich" : "offline-markdown" });
      await db.run("INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES ('acceptance-note-ids',?,'now') ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(notes)]);
      return notes;
    },
    async status() {
      return Promise.all((await ids()).map(async (id) => ({ id, note: await repository.notes.get(id), receipt: await readNativeNoteSyncReceipt(db, profileId, id) })));
    },
    async edit(id: string, text: string) {
      const note = await repository.notes.get(id);
      await repository.notes.update(id, { contentText: text, content: note?.contentFormat === "markdown" ? text : JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }) });
    },
    start() { setMobileSyncEnabled(true); dispose = installMobileSyncRealtime(engine); engine.start(); },
    stop() { dispose?.(); dispose = undefined; engine.stop(); setMobileSyncEnabled(false); realtime.disconnect(); },
    async sync() { await engine.syncOnce(); },
    async errors() { return db.query("SELECT lastError FROM sync_state WHERE profileId=?", [profileId]); },
  };
  Object.assign(window, { acceptance, acceptanceRealtime: realtime });
  document.getElementById("status")!.textContent = "Native SQLite ready. Test account only.";
}
Object.assign(window, { initializeAcceptance: initialize });
const saved = localStorage.getItem("sync-acceptance-config");
if (saved) void initialize(JSON.parse(saved)).catch(() => { document.getElementById("status")!.textContent = "Native initialization failed"; });
