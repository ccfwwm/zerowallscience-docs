"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const repoRoot = path.resolve(__dirname, "../..");
const configPath = path.join(repoRoot, "electron", "builder.store.config.js");
const runtime = require(path.join(repoRoot, "electron", "storeChannel.js"));
const identity = {
  NOWEN_STORE_IDENTITY_NAME: "ExampleCompany.NowenNote",
  NOWEN_STORE_PUBLISHER: "CN=00000000-0000-0000-0000-000000000001",
  NOWEN_STORE_PUBLISHER_DISPLAY_NAME: "Example Publisher",
};

function readStoreConfig(env = {}) {
  return spawnSync(process.execPath, ["-e",
    "const c=require(process.argv[1]);process.stdout.write(JSON.stringify({publish:c.publish,output:c.directories.output,win:c.win,appx:c.appx}));",
    configPath,
  ], {
    cwd: repoRoot,
    env: { ...process.env, NOWEN_STORE_IDENTITY_NAME: "", NOWEN_STORE_PUBLISHER: "",
      NOWEN_STORE_PUBLISHER_DISPLAY_NAME: "", ...env },
    encoding: "utf8",
  });
}

test("Store config fails closed without Partner Center identity", () => {
  const bad = readStoreConfig();
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /NOWEN_STORE_IDENTITY_NAME/);
  assert.equal(readStoreConfig({ ...identity, NOWEN_STORE_PUBLISHER: "CN=ms" }).status !== 0, true);
  assert.equal(readStoreConfig({ ...identity, NOWEN_STORE_IDENTITY_NAME: "../../fake" }).status !== 0, true);
});

test("Store-only target is AppX; never uploads NSIS or publishes to GitHub", () => {
  const r = readStoreConfig(identity);
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  assert.equal(c.publish, null);
  assert.equal(c.output, "dist-electron-store");
  assert.deepEqual(c.win.target, [{ target: "appx", arch: ["x64"] }]);
  assert.equal(c.win.artifactName, "Nowen-Note-Store-\x24{version}-\x24{arch}.\x24{ext}");
  assert.equal(c.appx.identityName, identity.NOWEN_STORE_IDENTITY_NAME);
  assert.equal(c.appx.publisher, identity.NOWEN_STORE_PUBLISHER);
  assert.ok(c.appx.capabilities.includes("runFullTrust"));
  assert.ok(c.appx.capabilities.includes("privateNetworkClientServer"));
  assert.equal(c.appx.applicationId, "NowenNote");
});

test("Store runtime is detected by real Electron process.windowsStore, never by env spoofing", () => {
  assert.equal(runtime.isMicrosoftStorePackage({ platform: "win32", packaged: true, windowsStore: true }), true);
  assert.equal(runtime.isMicrosoftStorePackage({ platform: "win32", packaged: true, windowsStore: false }), false);
  assert.equal(runtime.isMicrosoftStorePackage({ platform: "linux", packaged: true, windowsStore: true }), false);
  assert.equal(runtime.isMicrosoftStorePackage({ platform: "win32", packaged: false, windowsStore: true }), false);
  assert.equal(runtime.STORE_UPDATES_URI, "ms-windows-store://downloadsandupdates");
  const snapshot = runtime.storeManagedSnapshot("1.5.2", "x64");
  assert.equal(snapshot.phase, "store-managed");
  assert.equal(snapshot.installOnQuit, false);
});

test("existing NSIS Full/Lite builder targets are unchanged", () => {
  const full = require(path.join(repoRoot, "electron", "builder.config.js"));
  const lite = require(path.join(repoRoot, "electron", "builder.lite.config.js"));
  assert.ok(full.win.target.some(t => t.target === "nsis"));
  assert.ok(full.win.target.some(t => t.target === "portable"));
  assert.ok(lite.win.target.some(t => t.target === "nsis"));
  assert.equal(full.directories.output, "dist-electron");
});
