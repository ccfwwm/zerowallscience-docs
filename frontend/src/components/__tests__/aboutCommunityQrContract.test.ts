import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("about Nowen 开源实验室公众号入口", () => {
  it("本站提供官方下载入口并保留上游双语资源", () => {
    const settings = source("../../components/SettingsModal.tsx");
    const zh = source("../../i18n/locales/zh-CN.json");
    const en = source("../../i18n/locales/en.json");

    expect(settings).toContain('href="/#download"');
    expect(settings).toContain("ZeroWall Science 桌面产品遵循自身许可证");
    expect(zh).toContain('"communityQrTitle": "Nowen 开源实验室"');
    expect(en).toContain('"communityQrTitle": "Nowen Open Source Lab"');
  });

  it("随前端构建携带公众号二维码", () => {
    const image = readFileSync(
      path.join(process.cwd(), "src", "assets", "community", "nowen-lab-wechat.jpg"),
    );
    expect(image.byteLength).toBeGreaterThan(0);
  });
});
