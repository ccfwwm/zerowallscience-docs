import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("官方文档初始化幂等且不会覆盖后台编辑", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "zerowall-docs-"));
  process.env.DB_PATH = path.join(temp, "docs.db");
  process.env.ZEROWALL_DOCS_SITE = "1";
  process.env.ZEROWALL_ADMIN_PASSWORD = "IntegrationPassword123456789";
  process.env.ZEROWALL_DOCS_CONTENT = path.resolve("../content/docs");
  const { initializeOfficialSite } = await import("../src/runtime/official-site-bootstrap.ts");
  const { getDb, closeDb } = await import("../src/db/schema.ts");
  const db = getDb();
  const count = db.prepare("SELECT COUNT(*) AS count FROM notes WHERE notebookId IN (SELECT id FROM notebooks WHERE parentId = 'zerowall-official-docs')").get() as { count: number };
  assert.equal(count.count, 13);
  db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = 'overview'").run("人工修改", "人工修改");
  initializeOfficialSite();
  assert.equal((db.prepare("SELECT content FROM notes WHERE id = 'overview'").get() as { content: string }).content, "人工修改");
  assert.equal((db.prepare("SELECT value FROM system_settings WHERE key = 'auth_allow_registration'").get() as { value: string }).value, "false");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM notebook_publications WHERE permission = 'read' AND allowEdit = 0 AND allowComment = 0").get() as { count: number }).count, 1);
  closeDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
