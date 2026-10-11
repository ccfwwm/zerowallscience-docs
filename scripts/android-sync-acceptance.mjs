// Runs only against the separate com.nowen.note.syncacceptance debug APK.
// Requires backend/tests/sync-v2-android-server.ts on loopback port 47831.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { _android } = require("@playwright/test");
const serial = process.argv[2];
if (!serial) throw new Error("Pass the isolated test device serial");
const adbPath = process.env.ADB || path.join(process.env.LOCALAPPDATA, "Android/Sdk/platform-tools/adb.exe");
const adb = (...args) => execFileSync(adbPath, ["-s", serial, ...args], { encoding: "utf8", timeout: 30_000 });
const base = "http://127.0.0.1:47831";
const config = await (await fetch(`${base}/acceptance/config`)).json();
let browser, page;
async function attach() {
  const devices = await _android.devices();
  browser = devices.find((device) => device.serial() === serial);
  assert.ok(browser, "isolated acceptance device is available");
  page = await (await browser.webView({ pkg: "com.nowen.note.syncacceptance" })).page();
  await page.goto("https://localhost/tests/android-sync/index.html");
  await page.waitForFunction(() => typeof window.initializeAcceptance === "function");
  await page.evaluate(async (config) => {
    await window.initializeAcceptance(config);
  }, config);
  await page.waitForFunction(() => !!window.acceptance, { timeout: 20_000 });
}
async function wait(work, message, timeout = 12_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await work()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}
const native = (method, ...args) => page.evaluate(({ method, args }) => window.acceptance[method](...args), { method, args });
const serverNote = async (id) => (await fetch(`${base}/acceptance/note/${id}`)).json();
const remoteEdit = async (id, text) => {
  const response = await fetch(`${base}/acceptance/edit/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  assert.ok(response.ok);
  const body = await response.json();
  assert.equal(body.results[0].status, "applied");
};
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1];
const stats = (values) => ({ samples: values.length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), p99Ms: percentile(values, .99) });
try {
  await attach();
  adb("reverse", "--remove", "tcp:47831");
  const unreachable = await page.evaluate(async () => {
    try { await fetch("http://127.0.0.1:47831/acceptance/config"); return false; }
    catch { return true; }
  });
  assert.ok(unreachable, "Android cannot reach the test server during offline edits");
  await native("start");
  const ids = await native("createOffline");
  let rows = await native("status");
  assert.deepEqual(rows.map((r) => r.note.contentText), ["offline-markdown", "offline-rich"]);
  assert.ok(rows.every((r) => r.receipt.phase === "pending"));
  await browser.close();
  adb("shell", "am", "force-stop", "com.nowen.note.syncacceptance");
  adb("shell", "am", "start", "-n", "com.nowen.note.syncacceptance/com.nowen.note.MainActivity");
  await attach();
  rows = await native("status");
  assert.deepEqual(rows.map((r) => r.note.id), ids);
  assert.deepEqual(rows.map((r) => r.note.contentText), ["offline-markdown", "offline-rich"]);
  assert.ok(rows.every((r) => r.receipt.phase === "pending"));
  adb("reverse", "tcp:47831", "tcp:47831");
  await native("start");
  await wait(async () => (await native("status")).every((r) => r.receipt.phase === "confirmed"), "offline edits not acknowledged");
  const download = [], upload = [];
  for (let i = 0; i < 30; i++) {
    const id = ids[i % 2], remoteText = `remote-${i}`, localText = `native-${i}`;
    let started = performance.now();
    await remoteEdit(id, remoteText);
    await wait(async () => (await native("status")).find((r) => r.id === id).note.contentText === remoteText, "remote update not pulled");
    download.push(Math.round(performance.now() - started));
    started = performance.now();
    await native("edit", id, localText);
    await wait(async () => (await serverNote(id))?.contentText === localText, "native update not pushed");
    await wait(async () => (await native("status")).find((r) => r.id === id).receipt.phase === "confirmed", "edit ACK not persisted");
    upload.push(Math.round(performance.now() - started));
  }
  // Remove the notification transport while leaving the same engine's poll active.
  await page.evaluate(async () => { const realtime = window.acceptanceRealtime; realtime.disconnect(); });
  await remoteEdit(ids[0], "lost-notice");
  await wait(async () => (await native("status"))[0].note.contentText === "lost-notice", "poll did not compensate for missing notification", 40_000);
  await native("stop");
  await remoteEdit(ids[0], "reconnected");
  await native("start");
  await wait(async () => (await native("status"))[0].note.contentText === "reconnected", "reconnect did not catch up");
  const report = { device: serial, package: "com.nowen.note.syncacceptance", offlineImmediateRead: true, forceStopRecovery: true,
    knowledgeTreeRootCreate: true, readWriteThroughProductionApiBridge: true,
    offlineNetworkIsolation: "adb reverse removed; HTTP server unreachable from Android",
    markdownAndRichText: true, missingNoticePoll: true, reconnect: true,
    httpPushToNativePull: stats(download), nativeCommitToServerAndAck: stats(upload), errors: await native("errors"),
    boundary: "Loopback adb reverse; real Android Native SQLite, signed-in personal knowledgeTreeApi create, api get/update and MobileSyncEngine. Does not test full EditorPane, protected/shared/cross-type tree mutations, attachment bytes, or production JWT middleware." };
  fs.mkdirSync(new URL("../docs/test-results/", import.meta.url), { recursive: true });
  fs.writeFileSync(new URL("../docs/test-results/sync-v2-native-tree-2026-10-11.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (page) await native("stop").catch(() => undefined);
  await browser?.close().catch(() => undefined);
  adb("reverse", "--remove", "tcp:47831");
}
process.exit(0);
