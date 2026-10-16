import { test as base, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve("..");
const electron = createRequire(import.meta.url)("electron") as string;
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const test = base.extend<{ server: string }>({
  server: async ({ browserName }, provide) => {
    void browserName;
    // Reuse the production-app fixture; it requires this temp profile prefix.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-composer-browser-"));
    let backend: ChildProcess | undefined, logs = "";
    try {
      // Keep this run independent of other builds in the shared checkout.
      const frontend = path.join(directory, "frontend");
      fs.cpSync(path.join(root, "frontend/dist"), frontend, { recursive: true });
      const port = await new Promise<number>(resolve => {
        const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => {
          const port = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(port));
        });
      });
      const server = `http://127.0.0.1:${port}`;
      backend = spawn(electron, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/task-composer-browser-server.ts")], {
        cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TASK_COMPOSER_PROFILE: directory, FRONTEND_DIST: frontend, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
      });
      backend.stdout?.on("data", chunk => { logs += chunk; }); backend.stderr?.on("data", chunk => { logs += chunk; });
      await expect.poll(() => fetch(`${server}/api/health`).then(r => r.ok).catch(() => false), { timeout: 20000 }).toBe(true);
      await provide(server);
    } finally {
      if (backend && backend.exitCode === null) {
        const exited = new Promise<void>(resolve => backend!.once("exit", () => resolve())); backend.kill(); await exited;
      }
      fs.rmSync(directory, { recursive: true, force: true });
      if (backend?.exitCode && backend.exitCode !== 0) console.error(logs.slice(-1000));
    }
  },
});

for (const width of [1440, 320, 390]) {
  test(`Markdown / commands preserve content and persist at ${width}px`, async ({ page, server }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && /Reading the editor layout|CodeMirror plugin crashed/.test(message.text())) errors.push(message.text()); });
    const password = "slash-browser-test-password";
    const registration = await page.request.post(`${server}/api/auth/register`, { data: { username: "slash_user", password } });
    expect(registration.ok()).toBe(true);
    const account = await registration.json(), headers = { Authorization: `Bearer ${account.token}` };
    const notebooks = await (await page.request.get(`${server}/api/notebooks`, { headers })).json();
    const created = await page.request.post(`${server}/api/notes`, { headers, data: {
      notebookId: notebooks[0].id, title: "Slash commands", contentFormat: "markdown", content: "original text\n\n",
    } });
    expect(created.status(), await created.text()).toBe(201);
    const note = await created.json();
    await page.addInitScript(version => { localStorage.setItem("i18nextLng", "zh-CN"); localStorage.setItem("nowen-seen-version", version); }, version);
    await page.goto(server);
    await page.getByPlaceholder("admin", { exact: true }).fill("slash_user");
    await page.locator("input[type=password]").fill(password);
    await page.locator("button[type=submit]").click();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("nowen:onboarding-welcome-opened:v1:")))).toBe(true);
    await page.goto(`${server}/notes/${note.id}`);
    await page.setViewportSize({ width, height: 852 });
    const editor = page.locator(".cm-editor .cm-content").filter({ visible: true });
    await expect(editor).toBeVisible();
    await editor.click(); await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("/H1");
    const menu = page.getByRole("listbox", { name: "Markdown /" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await page.keyboard.type("heading");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/code");
    await expect(menu).toBeVisible();
    if (width < 640) await menu.getByRole("option").tap();
    else await page.keyboard.press("Tab");
    await page.keyboard.type("const answer = 42;");
    const expected = "original text\n\n# heading\n\n```\nconst answer = 42;\n```\n";
    // Existing Markdown commands separate a fenced block from preceding text.
    await expect.poll(async () => (await (await page.request.get(`${server}/api/notes/${note.id}`, { headers })).json()).content)
      .toContain("const answer = 42;");
    const saved = (await (await page.request.get(`${server}/api/notes/${note.id}`, { headers })).json()).content;
    expect(saved).toBe(expected);
    await page.reload();
    await expect(editor).toContainText("const answer = 42;");
    await editor.click(); await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("/tab");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(editor).toContainText("| 列1 | 列2 | 列3 |");
    await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(width - 8);
    expect(box.y).toBeGreaterThanOrEqual(8);
    expect(box.y + box.height).toBeLessThanOrEqual(852 - 8);
    await page.screenshot({ path: test.info().outputPath(`markdown-slash-${width}.png`) });
    await page.keyboard.press("Escape"); await expect(menu).not.toBeVisible();
    expect(errors).toEqual([]);
  });
}
