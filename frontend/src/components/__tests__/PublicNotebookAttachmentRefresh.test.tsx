// @vitest-environment jsdom
import React, { act, useContext } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AttachmentAccessRefreshContext } from "@/hooks/useAttachmentImageRenderSource";

const api = vi.hoisted(() => ({ getOfficialInfo: vi.fn(), getOfficialTree: vi.fn(), getOfficialNote: vi.fn() }));
vi.mock("@/lib/notebookPublicationApi", () => ({ notebookPublicationApi: api }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/PublicKnowledgeResourceRenderer", () => ({ default: () => {
  const refresh = useContext(AttachmentAccessRefreshContext)!;
  return <button onClick={() => { void Promise.all([refresh(), refresh()]).catch(() => undefined); }}>续签</button>;
} }));
import PublicNotebookView from "../PublicNotebookView";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.clearAllMocks(); });

it("匿名公开页通过原文章接口合并并发续签请求", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const summary = { id: "public-note", notebookId: "public-root", title: "公开文章", updatedAt: "2026-10-16T00:00:00Z", contentFormat: "md" };
  api.getOfficialInfo.mockResolvedValue({ title: "公开目录", permission: "read", allowComment: false, allowDownload: true });
  api.getOfficialTree.mockResolvedValue({ notebooks: [], notes: [summary] });
  api.getOfficialNote.mockResolvedValue({ ...summary, content: "正文", attachmentUrls: { image: "signed" }, permission: "read" });
  try {
    await act(async () => root.render(<PublicNotebookView official noteId="public-note" />));
    expect(api.getOfficialNote).toHaveBeenCalledTimes(1);
    let finish!: (value: unknown) => void;
    api.getOfficialNote.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "续签")!.click());
    expect(api.getOfficialNote).toHaveBeenCalledTimes(2);
    expect(api.getOfficialNote).toHaveBeenLastCalledWith("public-note");
    await act(async () => finish({ ...summary, content: "正文", attachmentUrls: { image: "renewed" }, permission: "read" }));
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
