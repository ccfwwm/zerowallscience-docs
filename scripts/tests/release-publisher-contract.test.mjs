import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  assertCompleteMacReleaseAssets,
  findMissingMacReleaseAssets,
  isMacManualDownloadZip,
  requiredMacReleaseAssets,
} = require("../lib/release-platform-assets.cjs");

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "../..");

async function readRepoFile(relativePath) {
  return readFile(path.join(rootDir, relativePath), "utf8");
}

test("tag 构建工作流不让 electron-builder 直接发布 GitHub Release", async () => {
  const workflow = await readRepoFile(".github/workflows/release.yml");
  assert.match(workflow, /node-version:\s*["']22["']/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read\s*\n\s*actions:\s*read/);
  const jobs = require("js-yaml").load(workflow).jobs;
  const builderCommands = Object.values(jobs)
    .flatMap((job) => job.steps || [])
    .map((step) => step.run)
    .filter((command) => typeof command === "string" && command.includes("electron-builder"));
  assert.equal(builderCommands.length, 5);
  for (const command of builderCommands) assert.match(command, /--publish never\b/);
  assert.doesNotMatch(workflow, /--publish always/);
  assert.doesNotMatch(workflow, /GH_TOKEN:/);
});

test("Windows GitHub Direct EXE never requires third-party signer", async () => {
  const workflow = await readRepoFile(".github/workflows/release.yml");
  assert.doesNotMatch(workflow, /signpath|SIGNPATH/i);
  assert.doesNotMatch(workflow, /NOWEN_WINDOWS_PUBLISHER_NAME/);
  assert.doesNotMatch(workflow, /submit-signing-request/);
  assert.match(workflow, /name: nowen-note-win-direct/);
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY: 'false'/);
  assert.match(workflow, /Verify direct Windows SHA-512 metadata and assets/);
  assert.match(workflow, /scripts\/verify-release-update-assets\.mjs local/);
  assert.match(workflow, /Nowen-Note-Lite-\$version-setup\.exe/);
  assert.match(workflow, /latest-lite\.yml/);
  assert.match(workflow, /if-no-files-found: error/);
});

test("Direct Windows release is gated on same-tag CI artifacts and remote metadata", async () => {
  const guard = await readRepoFile("scripts/release.sh");
  assert.match(guard, /collect_ci_direct_windows_assets/);
  assert.match(guard, /nowen-note-win-direct/);
  assert.match(guard, /required_windows_asset_names/);
  assert.match(guard, /replacing local Windows candidates/);
  assert.match(guard, /failed to collect same-tag Windows CI assets; keeping \$\{TAG\} as draft/);
  assert.doesNotMatch(guard, /SignPath|NOWEN_WINDOWS_PUBLISHER_NAME/);
  const sameTag = guard.indexOf("if release_contains_windows_candidates");
  const remote = guard.indexOf("==== 验证 GitHub Release 更新元数据与远端资产 ====");
  assert.ok(sameTag >= 0 && remote > sameTag, "must replace local Windows EXEs before remote verification");
  assert.match(guard, /node "\$VERIFY_SCRIPT" remote/);
});

test("本地发布守卫在正式校验前汇总完整 CI macOS 产物", async () => {
  const releaseGuard = await readRepoFile("scripts/release.sh");
  assert.match(releaseGuard, /nowen-note-mac/);
  assert.match(releaseGuard, /gh run download/);
  assert.match(releaseGuard, /gh release upload/);
  assert.match(releaseGuard, /--clobber/);
  assert.match(releaseGuard, /release_has_complete_mac_assets/);
  assert.match(releaseGuard, /latest-mac\.yml/);
  assert.match(releaseGuard, /failed to collect complete CI macOS assets; keeping \$\{TAG\} as draft/);
  const macIndex = releaseGuard.indexOf('if grep -q "PC 产物" "$LOG_FILE"; then');
  const winIndex = releaseGuard.indexOf("if release_contains_windows_candidates");
  const verifyIndex = releaseGuard.indexOf("==== 验证 GitHub Release 更新元数据与远端资产 ====");
  assert.ok(macIndex >= 0 && winIndex > macIndex, "macOS 产物必须先于 Windows CI 资产校验汇总");
  assert.ok(verifyIndex > winIndex, "Windows CI 资产校验必须先于最终远端校验");
});

test("完整桌面 Release 会写明四个平台支持情况", async () => {
  const releaseGuard = await readRepoFile("scripts/release.sh");
  assert.match(releaseGuard, /ensure_desktop_platform_notes/);
  assert.match(releaseGuard, /### 桌面端支持/);
  assert.match(releaseGuard, /Windows x64（GitHub 直接下载，安装包当前未提供代码签名）/);
  assert.match(releaseGuard, /macOS Intel x64/);
  assert.match(releaseGuard, /macOS Apple Silicon arm64/);
  assert.match(releaseGuard, /Linux x64/);
});

test("完整桌面 Release 的远端校验会阻止 macOS 平台整体缺失", async () => {
  const verifier = await readRepoFile("scripts/verify-release-update-assets.mjs");
  assert.match(verifier, /assertCompleteMacReleaseAssets/);
  assert.match(verifier, /byName\.has\("latest\.yml"\) && byName\.has\("latest-linux\.yml"\)/);
  assert.match(verifier, /remote Release \$\{tag\} macOS assets/);
  assert.match(verifier, /!isMacManualDownloadZip\(name\)/);
});

test("macOS 发版资产必须同时包含 Intel、Apple Silicon 与更新元数据", () => {
  const version = "1.4.16";
  const required = requiredMacReleaseAssets(version);
  assert.deepEqual(required, [
    "Nowen-Note-1.4.16-x64.dmg",
    "Nowen-Note-1.4.16-arm64.dmg",
    "Nowen-Note-1.4.16-x64.zip",
    "Nowen-Note-1.4.16-arm64.zip",
    "latest-mac.yml",
  ]);
  assert.deepEqual(findMissingMacReleaseAssets(required, version), []);
  assert.doesNotThrow(() => assertCompleteMacReleaseAssets(required, version));
});

test("macOS 双架构 ZIP 按手动下载资产处理", () => {
  assert.equal(isMacManualDownloadZip("Nowen-Note-1.4.16-x64.zip"), true);
  assert.equal(isMacManualDownloadZip("Nowen-Note-1.4.16-arm64.zip"), true);
  assert.equal(isMacManualDownloadZip("Nowen-Note-1.4.16-setup.exe"), false);
});

test("Windows Node ZIP 使用 PowerShell Expand-Archive 解压", async () => {
  const fetchNode = await readRepoFile("scripts/fetch-node.mjs");
  assert.match(fetchNode, /process\.platform === "win32"/);
  assert.match(fetchNode, /powershell\.exe/);
  assert.match(fetchNode, /Expand-Archive/);
});
