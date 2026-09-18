import { getDb } from "../db/schema";
import { resolveNotebookPermission } from "../middleware/acl";

export interface OfficialDocsCandidate {
  id: string;
  name: string;
  workspaceName: string | null;
  allowComment: number;
}

/** 个人和团队目录沿用发布管理权限；仅链接、过期和已撤销发布不可绑定。 */
export function getOfficialDocsCandidates(userId: string): OfficialDocsCandidate[] {
  const rows = getDb().prepare(`
    SELECT n.id, n.name, w.name AS workspaceName, p.allowComment
    FROM notebook_publications p
    JOIN notebooks n ON n.id = p.notebookId
    LEFT JOIN workspaces w ON w.id = n.workspaceId
    WHERE n.isDeleted = 0 AND p.isActive = 1 AND p.accessMode = 'public'
      AND p.permission = 'read' AND p.allowEdit = 0
      AND (p.expiresAt IS NULL OR julianday(p.expiresAt) > julianday('now'))
    ORDER BY w.name, n.name
  `).all() as OfficialDocsCandidate[];
  return rows.filter((row) => resolveNotebookPermission(row.id, userId).permission === "manage");
}
