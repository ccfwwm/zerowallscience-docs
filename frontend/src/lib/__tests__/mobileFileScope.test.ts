import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api";
import { installMobileLocalModuleBridge } from "../mobileLocalModuleBridge";
import type { NativeDatabase } from "../nativeDatabase";
import type { NativeLocalRepository } from "../nativeLocalRepository";

afterEach(() => localStorage.removeItem("nowen-current-workspace"));
it("rejects Native workspace file operations before using personal rows or writes", async () => {
  const query = vi.fn(); const run = vi.fn(); const notebooks = vi.fn();
  const restore = installMobileLocalModuleBridge({ notebooks: { list: notebooks } } as unknown as NativeLocalRepository,
    { query, run } as unknown as NativeDatabase, "scope-test-user");
  try {
    localStorage.setItem("nowen-current-workspace", "workspace-a");
    for (const operation of [() => api.files.list(), () => api.files.stats(), () => api.files.get("file-a"),
      () => api.files.upload(new File(["test"], "workspace.txt")), () => api.files.rename("file-a", "new-name"), () => api.files.remove("file-a")]) {
      await expect(operation()).rejects.toMatchObject({ code: "MOBILE_WORKSPACE_FILES_UNSUPPORTED" });
    }
    expect(query).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(notebooks).not.toHaveBeenCalled();
  } finally { restore(); }
});
