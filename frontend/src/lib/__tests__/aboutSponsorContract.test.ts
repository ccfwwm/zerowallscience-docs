import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("about sponsor contract", () => {
  it("保留 ZeroWall 文档品牌及上游许可归属", () => {
    const settings = source("../../components/SettingsModal.tsx");
    const zh = source("../../i18n/locales/zh-CN.json");
    const en = source("../../i18n/locales/en.json");

    expect(settings).toContain('alt="ZeroWall Science"');
    expect(settings).toContain("ZeroWall Science 文档中心");
    expect(settings).toContain("GPL-3.0");
    expect(settings).toContain('href="https://github.com/cropflre/nowen-note"');
    expect(settings).not.toContain('src="/weixin.jpg"');
    expect(settings).not.toContain('src="/zhifubao.png"');
    expect(zh).toContain('"sponsorAlipay": "支付宝"');
    expect(en).toContain('"sponsorAlipay": "Alipay"');
  });

  it("ships sponsor images as Vite-managed source assets", () => {
    const wechatImage = readFileSync(path.join(process.cwd(), "src", "assets", "sponsor", "weixin.jpg"));
    const alipayImage = readFileSync(path.join(process.cwd(), "src", "assets", "sponsor", "zhifubao.png"));
    expect(wechatImage.byteLength).toBeGreaterThan(0);
    expect(alipayImage.byteLength).toBeGreaterThan(0);
  });
});
