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
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-composer-browser-calendar-"));
    let backend: ChildProcess | undefined, logs = "";
    try {
      const port = await new Promise<number>(resolve => {
        const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => {
          const port = (socket.address() as net.AddressInfo).port;
          socket.close(() => resolve(port));
        });
      });
      const server = `http://127.0.0.1:${port}`;
      backend = spawn(electron, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/task-composer-browser-server.ts")], {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TASK_COMPOSER_PROFILE: directory, FRONTEND_DIST: path.join(root, "frontend/dist"), PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      backend.stdout?.on("data", chunk => { logs += chunk; });
      backend.stderr?.on("data", chunk => { logs += chunk; });
      await expect.poll(() => fetch(`${server}/api/health`).then(r => r.ok).catch(() => false), { timeout: 20000 }).toBe(true);
      await provide(server);
    } finally {
      if (backend && backend.exitCode === null) {
        const exited = new Promise<void>(resolve => backend!.once("exit", () => resolve()));
        backend.kill(); await exited;
      }
      fs.rmSync(directory, { recursive: true, force: true });
      if (backend?.exitCode && backend.exitCode !== 0) console.error(logs.slice(-1000));
    }
  },
});

for (const width of [320, 360, 393, 430, 1440]) {
  test(`date selection keeps the daily records content aligned at ${width}px`, async ({ page, server }) => {
    const registration = await page.request.post(`${server}/api/auth/register`, {
      data: { username: "calendar_user", password: "calendar-browser-test-password" },
    });
    expect(registration.ok()).toBe(true);
    await page.addInitScript(version => {
      localStorage.setItem("i18nextLng", "zh-CN");
      localStorage.setItem("nowen-seen-version", version);
    }, version);
    await page.goto(server);
    await page.getByPlaceholder("admin", { exact: true }).fill("calendar_user");
    await page.locator("input[type=password]").fill("calendar-browser-test-password");
    await page.locator("button[type=submit]").click();
    // Finish the new-account welcome navigation before choosing another view.
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
      .some(key => key.startsWith("nowen:onboarding-welcome-opened:v1:")))).toBe(true);
    await page.getByRole("button", { name: "每日记录", exact: true }).click();
    const hub = page.locator("[data-daily-records-hub]");
    await expect(hub).toBeVisible();
    await page.setViewportSize({ width, height: 852 });
    await hub.locator("[data-daily-records-views]").getByRole("button", { name: "日记", exact: true }).click();
    const header = hub.locator("[data-daily-records-header]");
    const originalX = (await header.boundingBox())!.x;
    const dateInput = hub.locator('input[type="date"]');
    // The date control must be usable without first scrolling the shortcut strip.
    const picker = dateInput.locator("..");
    const pickerBox = (await picker.boundingBox())!;
    const headerBox = (await header.boundingBox())!;
    expect(pickerBox.x).toBeGreaterThanOrEqual(headerBox.x + 8);
    expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width - 8);
    if (width < 640) {
      expect(pickerBox.height).toBeLessThanOrEqual(40);
      expect(headerBox.height).toBeLessThanOrEqual(180);
    }

    const shortcuts = hub.locator("[data-daily-records-shortcut-scroll]");
    await shortcuts.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await expect.poll(async () => (await picker.boundingBox())!.x).toBe(pickerBox.x);
    if (width < 640) {
      expect(await hub.getByRole("heading", { level: 2 }).first().evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeLessThanOrEqual(20);
      // Date and weekday may use two lines; the weekday itself must stay intact.
      const weekday = hub.getByRole("heading", { level: 2 }).first().locator(":scope > span").nth(1);
      expect((await weekday.boundingBox())!.height).toBeLessThanOrEqual(28);
    }

    const actions = hub.locator("[data-daily-journal-actions]");
    const actionBoxes = await actions.getByRole("button").evaluateAll(buttons => buttons.map(button => {
      const box = button.getBoundingClientRect(); return { top: box.top, right: box.right };
    }));
    expect(Math.max(...actionBoxes.map(box => box.top)) - Math.min(...actionBoxes.map(box => box.top))).toBeLessThanOrEqual(4);
    expect(Math.max(...actionBoxes.map(box => box.right))).toBeLessThanOrEqual(width);

    // Touch focus, not just shrinking a desktop viewport, triggers the regression.
    await hub.getByText("选择日期", { exact: true }).tap();
    await expect.poll(() => hub.evaluate(element => element.scrollLeft)).toBe(0);
    await dateInput.fill("2026-10-02");
    await dateInput.blur();
    await expect(dateInput).toHaveValue("2026-10-02");
    await expect.poll(async () => (await header.boundingBox())!.x).toBe(originalX);
    await expect.poll(() => hub.evaluate(element => element.scrollLeft)).toBe(0);
    await hub.getByText("选择日期", { exact: true }).tap();
    await dateInput.press("Escape");
    await expect(dateInput).toHaveValue("2026-10-02");
    await expect.poll(() => hub.evaluate(element => element.scrollLeft)).toBe(0);
    await hub.screenshot({ path: test.info().outputPath(`date-selection-${width}.png`) });
  });
}

test("moment calendar includes local month boundaries and excludes adjacent days", async ({ page, server }) => {
  const registration = await page.request.post(`${server}/api/auth/register`, {
    data: { username: "calendar_user", password: "calendar-browser-test-password" },
  });
  expect(registration.ok()).toBe(true);
  const account = await registration.json();
  const headers = { Authorization: `Bearer ${account.token}` };
  for (const [createdAt, contentText] of [
    ["2026-09-30T16:30:00Z", "Local month start"],
    ["2026-10-31T15:30:00Z", "Local month end"],
    ["2026-09-30T15:59:00Z", "Previous month"],
    ["2026-10-31T16:00:00Z", "Next month"],
  ]) {
    const response = await page.request.post(`${server}/api/diary`, { headers, data: { createdAt, contentText } });
    expect(response.ok()).toBe(true);
  }
  await page.addInitScript(version => {
    localStorage.setItem("i18nextLng", "zh-CN");
    localStorage.setItem("nowen-seen-version", version);
  }, version);
  await page.clock.setFixedTime(new Date("2026-10-15T04:00:00Z"));
  await page.goto(server);
  await page.getByPlaceholder("admin", { exact: true }).fill("calendar_user");
  await page.locator("input[type=password]").fill("calendar-browser-test-password");
  await page.locator("button[type=submit]").click();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
    .some(key => key.startsWith("nowen:onboarding-welcome-opened:v1:")))).toBe(true);
  await page.getByRole("button", { name: "每日记录", exact: true }).click();
  const hub = page.locator("[data-daily-records-hub]");
  const monthRequest = page.waitForRequest(request => request.url().includes("/diary/timeline?") && request.url().includes("from="));
  await hub.locator("[data-daily-records-views]").getByRole("button", { name: "瞬间日历", exact: true }).click();
  const params = new URL((await monthRequest).url()).searchParams;
  expect(params.get("from")).toBe("2026-09-30 16:00:00");
  expect(params.get("to")).toBe("2026-10-31 15:59:59");
  await expect(hub.getByText("按发布时间浏览瞬间", { exact: true })).toBeVisible();
  await hub.getByRole("button", { name: "2026-10-01", exact: true }).click();
  await expect(hub.getByText("Local month start", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(hub.getByText("00:30", { exact: true }).filter({ visible: true })).toBeVisible();
  await hub.getByRole("button", { name: "2026-10-31", exact: true }).click();
  await expect(hub.getByText("Local month end", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(hub.getByText("Next month", { exact: true })).toHaveCount(0);
  await expect(hub.getByText("Previous month", { exact: true })).toHaveCount(0);
});

for (const locale of ["zh-CN", "en"]) {
  test(`note calendar identifies its modified-date scope and preserves imported history (${locale})`, async ({ page, server }) => {
    const registration = await page.request.post(`${server}/api/auth/register`, {
      data: { username: "calendar_user", password: "calendar-browser-test-password" },
    });
    expect(registration.ok()).toBe(true);
    const account = await registration.json();
    const headers = { Authorization: `Bearer ${account.token}` };
    const imported = await page.request.post(`${server}/api/export/import`, {
      headers, data: { notebookName: "Calendar import", notes: [
        { title: "Modified later", content: "changed", contentFormat: "markdown", createdAt: "2026-10-02 04:00:00", updatedAt: "2026-10-15 04:00:00" },
        { title: "Preserved history", content: "old", contentFormat: "markdown", createdAt: "2026-10-03 04:00:00", updatedAt: "2026-10-03 04:00:00" },
        { title: "Local midnight history", content: "midnight", contentFormat: "markdown", createdAt: "2026-10-02 16:30:00", updatedAt: "2026-10-02 16:30:00" },
      ] },
    });
    expect(imported.ok()).toBe(true);
    await page.addInitScript(({ version, locale }) => {
      localStorage.setItem("i18nextLng", locale);
      localStorage.setItem("nowen-seen-version", version);
      localStorage.setItem("nowen-note-workspace-layout", "three-column");
    }, { version, locale });
    await page.clock.setFixedTime(new Date("2026-10-15T04:00:00Z"));
    await page.goto(server);
    await page.getByPlaceholder("admin", { exact: true }).fill("calendar_user");
    await page.locator("input[type=password]").fill("calendar-browser-test-password");
    await page.locator("button[type=submit]").click();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
      .some(key => key.startsWith("nowen:onboarding-welcome-opened:v1:")))).toBe(true);
    await page.getByTitle("Calendar import", { exact: true }).click();
    await expect(page.locator("[data-note-list-card]")).toHaveCount(3);
    await page.getByRole("button", { name: locale === "zh-CN" ? "列表选项" : "List options", exact: true }).click();
    await page.getByRole("menuitem", { name: locale === "zh-CN" ? "按修改日期筛选" : "Filter by modified date", exact: true }).click();
    await expect(page.getByText(locale === "zh-CN" ? "笔记日历" : "Note calendar", { exact: true })).toBeVisible();
    const historicalDay = page.getByRole("button", { name: "2026-10-03", exact: true });
    await expect(historicalDay).toHaveText(/3\s*2/);
    await expect(page.getByRole("button", { name: "2026-10-15", exact: true })).toHaveText(/15\s*1/);
    await historicalDay.click();
    await expect(page.locator("[data-note-list-card]")).toHaveCount(2);
    await expect(page.locator("[data-note-list-card]").filter({ hasText: "Preserved history" })).toBeVisible();
    await expect(page.locator("[data-note-list-card]").filter({ hasText: "Local midnight history" })).toBeVisible();
  });
}
