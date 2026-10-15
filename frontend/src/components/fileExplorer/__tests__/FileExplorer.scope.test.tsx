import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FileExplorer from "../FileExplorer";

const state = vi.hoisted(() => ({
  workspace: "personal", confirm: vi.fn(), removeFiles: vi.fn(), removeFolder: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/api", () => ({
  getCurrentWorkspace: () => state.workspace, getServerUrl: () => "http://qa.local", getBaseUrl: () => "/api",
  resolveAttachmentUrl: (url: string) => url,
  api: {
    files: { organization: { list: async () => ({supported:false,canManageTags:false,tags:[],smartFolders:[]}) }, list: async () => ({ items: [{ id: "file-a", filename: "file.txt", mimeType: "text/plain", size: 1, createdAt: "2026-10-15", folderId: null }], total: 1 }), batchRemove: state.removeFiles },
    attachmentFolders: { list: async () => ({ folders: [{ id: "folder-a", name: "Folder A", parentId: null, fileCount: 0 }] }), remove: state.removeFolder },
  },
}));
vi.mock("@/lib/offlineScope", () => ({ getOfflineQueueStorageKey: () => "qa-account" }));
vi.mock("@/store/AppContext", () => ({ useAppActions: () => ({}) }));
vi.mock("@/components/ui/confirm", () => ({ confirm: state.confirm }));
vi.mock("@/hooks/useFileUploadQueue", () => ({ useFileUploadQueue: () => ({ tasks: [] }) }));
vi.mock("@/components/attachmentDetail/AttachmentDetailDrawer", () => ({ default: () => null }));
vi.mock("@/components/FileMoveDialog", () => ({ default: () => null }));
vi.mock("@/lib/downloadFile", () => ({ downloadAttachment: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); state.workspace = "personal";
  state.removeFiles.mockResolvedValue({ deleted: 1, failed: [] });
  state.removeFolder.mockResolvedValue({ success: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); });

it.each([
  { kind: "file", changeWorkspace: true }, { kind: "folder", changeWorkspace: true },
  { kind: "file", changeWorkspace: false }, { kind: "folder", changeWorkspace: false },
])("confirms $kind deletion only in its original workspace (changed: $changeWorkspace)", async ({ kind, changeWorkspace }) => {
  let resolve!: (confirmed: boolean) => void;
  state.confirm.mockImplementation(() => new Promise<boolean>((done) => { resolve = done; }));
  await act(async () => root.render(<FileExplorer />));
  await act(async () => {
    if (kind === "file") (host.querySelector('[aria-label="fileExplorer.actions"]') as HTMLButtonElement).click();
    else [...host.querySelectorAll("button")].find((button) => button.textContent === "Folder A")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
  await act(async () => {
    [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === (kind === "file" ? "attachmentDetail.delete" : "fileExplorer.deleteFolder"))!.click();
  });
  expect(state.confirm).toHaveBeenCalledTimes(1);
  if (changeWorkspace) await act(async () => {
    state.workspace = "workspace-b";
    window.dispatchEvent(new Event("nowen:workspace-changed"));
  });
  await act(async () => resolve(true));
  expect(state.removeFiles).toHaveBeenCalledTimes(!changeWorkspace && kind === "file" ? 1 : 0);
  expect(state.removeFolder).toHaveBeenCalledTimes(!changeWorkspace && kind === "folder" ? 1 : 0);
});
