import { test as base, expect, _electron } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve("..");
const electron = createRequire(import.meta.url)("electron") as string;
const test = base.extend<{ product: { server: string; provider: string; directory: string; setOutput: (value: unknown) => void } }>({
  product: async ({ browserName }, provide) => {
    void browserName;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-composer-browser-"));
    let backend: ChildProcess | undefined, logs = "";
    let output: unknown = { tasks: [{ title: "Review report", description: "Check the test results", priority: 3, dueDate: "2026-12-31", dueAt: "2026-12-31T09:00" }, { title: "Record sleep", priority: 2, dueDate: "2026-12-31", repeatRule: "daily", repeatEndCount: 14 }] };
    const provider = http.createServer((request, response) => {
      request.resume();
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: typeof output === "string" ? output : JSON.stringify(output) } }] }));
    });
    try {
      await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
      const providerUrl = `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}/v1`;
      const port = await new Promise<number>(resolve => { const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => { const port = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(port)); }); });
      const server = `http://127.0.0.1:${port}`;
      backend = spawn(electron, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/task-composer-browser-server.ts")], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TASK_COMPOSER_PROFILE: directory, FRONTEND_DIST: path.join(root, "frontend/dist"), PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
      backend.stdout?.on("data", chunk => { logs += chunk; }); backend.stderr?.on("data", chunk => { logs += chunk; });
      await expect.poll(() => fetch(`${server}/api/health`).then(r => r.ok).catch(() => false), { timeout: 20000, message: "Isolated backend must start" }).toBe(true);
      await provide({ server, provider: providerUrl, directory, setOutput: value => { output = value; } });
    } finally {
      if (backend && backend.exitCode === null) { const exited = new Promise<void>(resolve => backend!.once("exit", () => resolve())); backend.kill(); await exited; }
      await new Promise<void>(resolve => provider.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
      if (backend?.exitCode && backend.exitCode !== 0) console.error(logs.slice(-1000));
    }
  },
});

for (const locale of ["zh-CN", "en"] as const) {
  test(`task header stays horizontal as the content area narrows (${locale})`, async ({ page, product }) => {
    const chinese = locale === "zh-CN";
    await page.setViewportSize({ width: 1440, height: 960 });
    const registered = await page.request.post(`${product.server}/api/auth/register`, { data: { username: "header_layout", password: "header-layout-test-password" } });
    expect(registered.ok()).toBe(true);
    const account = await registered.json();
    const headers = { Authorization: `Bearer ${account.token}` };
    const created = await page.request.post(`${product.server}/api/tasks`, { headers, data: { title: "Header layout fixture" } });
    expect(created.ok()).toBe(true);
    const task = await created.json();
    await page.goto(product.server);
    await page.evaluate(language => { localStorage.setItem("i18nextLng", language); localStorage.setItem("nowen-seen-version", "1.5.1"); }, locale);
    await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("header_layout");
    await page.locator("input[type=password]").fill("header-layout-test-password");
    await page.locator("button[type=submit]").click();
    await expect(page.getByRole("textbox", { name: chinese ? "笔记标题" : "Note Title", exact: true })).toHaveValue("欢迎使用 Nowen Note");
    await page.getByRole("button", { name: chinese ? "待办事项" : "Tasks", exact: true }).click();
    const heading = page.getByRole("heading", { name: chinese ? "全部任务" : "All Tasks", exact: true });
    const checkHeader = async () => {
      await expect(heading).toBeVisible();
      const geometry = await heading.evaluate(element => {
        const title = element as HTMLElement;
        const subtitle = title.nextElementSibling as HTMLElement;
        const header = title.parentElement!.parentElement!;
        const toolbar = header.lastElementChild as HTMLElement;
        return {
          titleHeight: title.clientHeight, titleLineHeight: parseFloat(getComputedStyle(title).lineHeight),
          subtitleHeight: subtitle.clientHeight, subtitleLineHeight: parseFloat(getComputedStyle(subtitle).lineHeight),
          width: header.clientWidth, scrollWidth: header.scrollWidth,
          titleBottom: title.parentElement!.getBoundingClientRect().bottom, toolbarTop: toolbar.getBoundingClientRect().top,
        };
      });
      expect(geometry.titleHeight).toBe(Math.round(geometry.titleLineHeight));
      expect(geometry.subtitleHeight).toBe(Math.round(geometry.subtitleLineHeight));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
      return geometry;
    };
    for (const width of [1440, 1200, 1000, 900]) {
      await page.setViewportSize({ width, height: 960 });
      const geometry = await checkHeader();
      if (width <= 1200) expect(geometry.toolbarTop).toBeGreaterThanOrEqual(geometry.titleBottom);
    }
    await page.getByRole("button", { name: chinese ? "选择模式" : "Select mode", exact: true }).click();
    await checkHeader();
    await page.getByRole("button", { name: chinese ? "取消选择" : "Cancel selection", exact: true }).filter({ visible: true }).click();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.locator(`[data-task-context-id="${task.id}"]`).first().click();
    await expect(page.locator(`[data-task-id="${task.id}"]`)).toBeVisible();
    const withDetail = await checkHeader();
    expect(withDetail.toolbarTop).toBeGreaterThanOrEqual(withDetail.titleBottom);
  });
}

test("Electron renderer confirms a draft through the same task center", async ({ product }) => {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.TASK_COMPOSER_ELECTRON_PROFILE = path.join(product.directory, "electron");
  env.TASK_COMPOSER_ELECTRON_URL = product.server;
  const app = await _electron.launch({ executablePath: electron, args: [path.join(root, "frontend/e2e/fixtures/task-composer-electron.cjs")], env });
  try {
    const page = await app.firstWindow(); await page.waitForLoadState();
    const registered = await page.request.post(`${product.server}/api/auth/register`, { data: { username: "composer_electron", password: "composer-electron-test-password" } });
    expect(registered.ok()).toBe(true); const account = await registered.json();
    const headers = { Authorization: `Bearer ${account.token}` };
    await page.request.put(`${product.server}/api/ai/settings`, { headers, data: { ai_provider: "openai", ai_api_url: product.provider, ai_api_key: "test-key", ai_model: "test-composer" } });
    await page.evaluate(() => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", "1.5.1"); }); await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("composer_electron");
    await page.locator("input[type=password]").fill("composer-electron-test-password"); await page.locator("button[type=submit]").click();
    await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("欢迎使用 Nowen Note");
    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    await page.getByRole("button", { name: "AI tasks", exact: true }).filter({ visible: true }).click();
    const dialog = page.getByRole("dialog", { name: "AI Task Composer", exact: true });
    await dialog.getByLabel("Your plan", { exact: true }).fill("Review a report and record sleep daily.");
    await dialog.getByRole("button", { name: "Generate tasks", exact: true }).click();
    await expect(dialog.getByLabel("Task title 1", { exact: true })).toHaveValue("Review report");
    expect(await (await page.request.get(`${product.server}/api/tasks`, { headers })).json()).toHaveLength(0);
    await dialog.getByRole("button", { name: "Create 2 tasks", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("Created 2 tasks.");
    expect(await (await page.request.get(`${product.server}/api/tasks`, { headers })).json()).toHaveLength(2);
  } finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())); await app.close(); }
});

test("actual task center confirms edited drafts, persists fields, refreshes and handles offline/failures", async ({ page, product }) => {
  const { server, provider } = product;
  expect((await page.request.post(`${server}/api/ai/task-plan/preview`, { data: { text: "Plan", timezone: "UTC" } })).status()).toBe(401);
  const registered = await page.request.post(`${server}/api/auth/register`, { data: { username: "composer_browser", password: "composer-browser-test-password" } });
  expect(registered.ok()).toBe(true); const account = await registered.json();
  const headers = { Authorization: `Bearer ${account.token}` };
  expect((await page.request.put(`${server}/api/ai/settings`, { headers, data: { ai_provider: "openai", ai_api_url: provider, ai_api_key: "test-only-key", ai_model: "test-composer-model" } })).ok()).toBe(true);
  const projectResponse = await page.request.post(`${server}/api/task-projects`, { headers, data: { name: "Release review" } });
  expect(projectResponse.ok()).toBe(true); const project = await projectResponse.json();
  await page.goto(server);
  await page.evaluate(() => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", "1.5.1"); });
  await page.reload();
  await page.getByPlaceholder("admin", { exact: true }).fill("composer_browser");
  await page.locator("input[type=password]").fill("composer-browser-test-password");
  await page.locator("button[type=submit]").click();
  await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("欢迎使用 Nowen Note");
  // Main sidebar navigation is the normal product entry.
  await page.getByRole("button", { name: "Tasks", exact: true }).filter({ visible: true }).click();
  await page.getByRole("button", { name: "AI tasks", exact: true }).filter({ visible: true }).click();
  const dialog = page.getByRole("dialog", { name: "AI Task Composer", exact: true });
  await dialog.getByLabel("Your plan", { exact: true }).fill("Review the report tomorrow at 9, record sleep daily for 14 days.");
  await dialog.getByRole("button", { name: "Generate tasks", exact: true }).click();
  await expect(dialog.getByLabel("Task title 1", { exact: true })).toHaveValue("Review report");
  expect(await (await page.request.get(`${server}/api/tasks`, { headers })).json()).toHaveLength(0);
  await dialog.getByLabel("Task title 1", { exact: true }).fill("Edited report review");
  await dialog.getByLabel("Project 1", { exact: true }).selectOption(project.id);
  await dialog.getByLabel("Select task 2", { exact: true }).uncheck();
  await dialog.screenshot({ path: path.join(root, "docs/qa/artifacts/task-composer/desktop-light-en.png") });
  await dialog.getByRole("button", { name: "Create 1 tasks", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Created 1 tasks.");
  const tasks = await (await page.request.get(`${server}/api/tasks`, { headers })).json();
  expect(tasks).toHaveLength(1); expect(tasks[0]).toMatchObject({ title: "Edited report review", dueDate: "2026-12-31", dueAt: "2026-12-31T09:00", projectId: project.id });
  await dialog.getByRole("button", { name: "View all tasks", exact: true }).click();
  await expect(page.getByText("Edited report review", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  // Narrow screens and dark mode exercise the same shared component.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { localStorage.setItem("i18nextLng", "zh-CN"); localStorage.setItem("nowen-note-theme", "dark"); });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "笔记标题", exact: true })).toHaveValue("欢迎使用 Nowen Note");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.locator("header button").filter({ has: page.locator("svg.lucide-menu") }).click();
  await page.getByRole("button", { name: "待办事项", exact: true }).filter({ visible: true }).click();
  await page.getByRole("button", { name: "AI 生成待办", exact: true }).filter({ visible: true }).click();
  const mobile = page.getByRole("dialog", { name: "AI 智能生成待办", exact: true });
  await mobile.getByLabel("你的计划", { exact: true }).fill("每天记录睡眠，持续14天");
  await mobile.getByRole("button", { name: "生成待办", exact: true }).click();
  await expect(mobile.getByLabel("任务标题 2", { exact: true })).toHaveValue("Record sleep");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await mobile.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await mobile.screenshot({ path: path.join(root, "docs/qa/artifacts/task-composer/mobile-dark-zh.png") });
  await mobile.getByLabel("选择任务 1", { exact: true }).uncheck();
  await mobile.getByRole("button", { name: "确认创建 1 项任务", exact: true }).click();
  await expect(mobile.getByRole("status")).toHaveText("成功创建 1 项待办。");
  const after = await (await page.request.get(`${server}/api/tasks`, { headers })).json();
  expect(after.find((task: { title: string }) => task.title === "Record sleep")).toMatchObject({ repeatRule: "daily", repeatEndCount: 14 });
  await mobile.getByRole("button", { name: "继续生成", exact: true }).click();
  await mobile.getByLabel("你的计划", { exact: true }).fill("保留这个输入");
  await page.context().setOffline(true);
  await mobile.getByRole("button", { name: "生成待办", exact: true }).click();
  await expect(mobile.getByRole("alert")).toContainText("当前离线");
  await expect(mobile.getByLabel("你的计划", { exact: true })).toHaveValue("保留这个输入");
  await page.context().setOffline(false); product.setOutput("not JSON");
  await mobile.getByRole("button", { name: "生成待办", exact: true }).click();
  await expect(mobile.getByRole("alert")).toContainText("不是有效 JSON");
  await mobile.getByRole("button", { name: "关闭", exact: true }).click();
  expect(await (await page.request.get(`${server}/api/tasks`, { headers })).json()).toHaveLength(2);
});
