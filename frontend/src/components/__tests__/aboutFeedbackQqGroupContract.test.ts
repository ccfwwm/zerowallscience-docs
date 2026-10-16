import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("about QQ 群反馈入口", () => {
  it("本站提供官网和文档入口并保留上游双语资源", () => {
    const settings = source("../../components/SettingsModal.tsx");
    const zh = source("../../i18n/locales/zh-CN.json");
    const en = source("../../i18n/locales/en.json");

    expect(settings).toContain('href="/"');
    expect(settings).toContain('href="/docs/"');
    expect(settings).toContain("ZeroWall Science 文档中心");
    expect(zh).toContain('"feedbackQqGroup": "加入 QQ 群反馈"');
    expect(en).toContain('"feedbackQqGroup": "Join the QQ feedback group"');
  });

  it("随前端构建携带 QQ 群二维码", () => {
    const image = readFileSync(path.join(process.cwd(), "src", "assets", "feedback", "qq-group.jpg"));
    expect(image.byteLength).toBeGreaterThan(0);
  });
});
