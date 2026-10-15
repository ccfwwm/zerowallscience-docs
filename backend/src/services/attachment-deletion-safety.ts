import { getDb } from "../db/schema";

/** Recheck inside the deletion transaction, including trashed and inaccessible notes. */
export function attachmentDeletionRisk(id: string): {
  code: "FILE_IN_USE" | "FILE_SHARED";
  error: string;
  referenceCount?: number;
} | null {
  const db = getDb();
  const references = db.prepare(`SELECT COUNT(*) AS count FROM (
    SELECT noteId FROM attachment_references WHERE attachmentId = ?
    UNION
    SELECT id FROM notes WHERE content LIKE ?
  )`).get(id, `%/api/attachments/${id}%`) as { count: number };
  if (references.count) {
    return { code: "FILE_IN_USE", error: "文件仍被笔记使用，请先移除引用（包括回收站中的笔记）", referenceCount: references.count };
  }
  const hasShares = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_shares'").get();
  if (hasShares && db.prepare(`SELECT 1 FROM file_shares WHERE attachmentId = ? AND isActive = 1
    AND (expiresAt IS NULL OR datetime(expiresAt) > datetime('now')) LIMIT 1`).get(id)) {
    return { code: "FILE_SHARED", error: "文件仍有有效分享链接，请先关闭外部访问" };
  }
  return null;
}
