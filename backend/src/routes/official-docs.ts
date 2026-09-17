import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import { sharedRouter } from "./shares.js";

/** 只转发绑定目录的只读接口；复用发布撤销、锁定和附件签名校验。 */
export const officialDocs = new Hono();
officialDocs.get("*", async (c) => {
  c.header("Cache-Control", "no-store");
  const suffix = c.req.path.replace(/^\/api\/docs/, "").replace(/\/$/, "");
  if (suffix !== "" && suffix !== "/tree" && !/^\/notes\/[A-Za-z0-9_-]+$/.test(suffix)) {
    return c.json({ error: "文档不存在" }, 404);
  }
  const db = getDb();
  const binding = db.prepare("SELECT value FROM system_settings WHERE key = 'site_docs_notebook_id'").get() as { value: string } | undefined;
  const publication = db.prepare("SELECT token FROM notebook_publications WHERE notebookId = ? AND accessMode = 'public' AND permission = 'read' AND allowEdit = 0 AND allowComment = 0 AND isActive = 1").get(binding?.value || "") as { token: string } | undefined;
  if (!publication) return c.json({ error: "官方文档尚未发布" }, 404);
  const url = new URL(c.req.url);
  url.pathname = `/notebook-public/${encodeURIComponent(publication.token)}${suffix}`;
  url.search = "";
  const response = await sharedRouter.request(new Request(url, { headers: { "X-Forwarded-Proto": "https" } }));
  return response;
});
