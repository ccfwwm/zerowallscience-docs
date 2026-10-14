const KIND_CONDITIONS: Record<string, string> = {
  video: "a.mimeType LIKE 'video/%'",
  audio: "a.mimeType LIKE 'audio/%'",
  archive: "a.mimeType IN ('application/zip', 'application/x-zip-compressed', 'application/x-rar-compressed', 'application/vnd.rar', 'application/x-7z-compressed', 'application/gzip', 'application/x-tar')",
  document: "(a.mimeType LIKE 'text/%' OR a.mimeType IN ('application/pdf', 'application/json', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint') OR a.mimeType LIKE 'application/vnd.openxmlformats-officedocument.%')",
};

/** Shared by the legacy query and both permission/retention projections. */
export function fileExplorerFilters(kind?: string, createdAfter?: string) {
  const conditions: string[] = [];
  const params: string[] = [];
  if (kind) {
    if (!Object.hasOwn(KIND_CONDITIONS, kind)) return { conditions, params, error: "无效的文件分类", code: "INVALID_FILE_KIND" };
    conditions.push(KIND_CONDITIONS[kind]);
  }
  if (createdAfter) {
    const timestamp = Date.parse(createdAfter);
    if (!Number.isFinite(timestamp)) return { conditions, params, error: "无效的日期", code: "INVALID_FILE_DATE" };
    conditions.push("datetime(a.createdAt) >= datetime(?)");
    params.push(new Date(timestamp).toISOString().slice(0, 19).replace("T", " "));
  }
  return { conditions, params };
}
