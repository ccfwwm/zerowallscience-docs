import { describe, expect, it } from "vitest";
import { buildAiContext, estimateTokens } from "../aiContextBuilder";

describe("buildAiContext 分段写作", () => {
  it("对过长选中文本返回完整分段，而不是截取首段", () => {
    const source = [
      "# 第一节",
      "这是第一段内容。".repeat(180),
      "",
      "# 第二节",
      "这是第二段内容。".repeat(180),
    ].join("\n");
    const context = buildAiContext({
      action: "polish",
      selectedText: source,
      contentText: source,
      maxInputTokens: 300,
    });

    expect(context.strategy).toBe("chunked");
    expect(context.chunks?.length).toBeGreaterThan(1);
    expect(context.chunks?.map((chunk) => chunk.text).join("\n\n")).toContain("# 第二节");
    expect(context.chunks?.reduce((total, chunk) => total + estimateTokens(chunk.text), 0)).toBeGreaterThan(estimateTokens(source) * 0.9);
  });

  it("分段边界保持 Markdown 标题和正文顺序", () => {
    const source = "# 标题一\n\n" + "甲内容。".repeat(220) + "\n\n# 标题二\n\n乙内容。".repeat(220);
    const context = buildAiContext({
      action: "rewrite",
      selectedText: source,
      contentText: source,
      maxInputTokens: 300,
    });
    const merged = context.chunks?.map((chunk) => chunk.text).join("\n\n") || "";
    expect(merged.indexOf("# 标题一")).toBeGreaterThanOrEqual(0);
    expect(merged.indexOf("# 标题二")).toBeGreaterThan(merged.indexOf("# 标题一"));
  });
});
