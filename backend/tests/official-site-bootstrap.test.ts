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
  db.prepare("UPDATE users SET lastLoginAt = datetime('now') WHERE username = 'admin'").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM notes WHERE id LIKE 'onboarding-%'").get() as { count: number }).count, 0);
  const count = db.prepare("SELECT COUNT(*) AS count FROM notes WHERE notebookId IN (SELECT id FROM notebooks WHERE parentId = 'zerowall-official-docs')").get() as { count: number };
  assert.equal(count.count, 13);
  db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = 'overview'").run("人工修改", "人工修改");
  initializeOfficialSite();
  assert.equal((db.prepare("SELECT content FROM notes WHERE id = 'overview'").get() as { content: string }).content, "人工修改");
  assert.equal((db.prepare("SELECT value FROM system_settings WHERE key = 'auth_allow_registration'").get() as { value: string }).value, "false");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM notebook_publications WHERE permission = 'read' AND allowEdit = 0 AND allowComment = 0").get() as { count: number }).count, 1);
  const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
  db.prepare("INSERT INTO users (id,username,passwordHash) VALUES ('outsider','outsider','unused')").run();
  db.prepare("INSERT INTO workspaces (id,name,ownerId) VALUES ('team','测试团队',?)").run(admin.id);
  db.prepare("INSERT INTO workspace_members (workspaceId,userId,role) VALUES ('team',?,'owner')").run(admin.id);
  const makePublication = (id: string, owner: string, mode = 'public', expiresAt: string | null = null, active = 1) => {
    db.prepare("INSERT INTO notebooks (id,userId,workspaceId,name) VALUES (?,?,'team',?)").run(id, owner, id);
    db.prepare("INSERT INTO notebook_publications (id,notebookId,ownerId,token,accessMode,permission,allowComment,expiresAt,isActive) VALUES (?,?,?,?,?,'read',1,?,?)")
      .run(id, id, owner, id, mode, expiresAt, active);
  };
  makePublication('team-public', admin.id);
  makePublication('link-only', admin.id, 'link');
  makePublication('expired', admin.id, 'public', '2000-01-01T00:00:00Z');
  makePublication('revoked', admin.id, 'public', null, 0);
  makePublication('inaccessible', 'outsider');
  db.prepare("UPDATE notebooks SET workspaceId=NULL WHERE id='inaccessible'").run();
  const { getOfficialDocsCandidates } = await import('../src/lib/officialDocsCandidates.ts');
  const candidates = getOfficialDocsCandidates(admin.id);
  assert.deepEqual(candidates.map(row => row.id).sort(), ['team-public', 'zerowall-official-docs']);
  assert.equal(candidates.find(row => row.id === 'team-public')?.workspaceName, '测试团队');
  const { default: settings } = await import('../src/routes/settings.ts');
  assert.equal((await settings.request('/official-docs-candidates', { headers: { 'X-User-Id': 'outsider' } })).status, 403);
  for (const id of ['link-only', 'expired', 'revoked', 'inaccessible']) {
    const response = await settings.request('/', { method: 'PUT', headers: { 'X-User-Id': admin.id, 'Content-Type': 'application/json' }, body: JSON.stringify({ site_docs_notebook_id: id }) });
    assert.equal(response.status, 400, id);
  }
  const response = await settings.request('/', { method: 'PUT', headers: { 'X-User-Id': admin.id, 'Content-Type': 'application/json' }, body: JSON.stringify({ site_docs_notebook_id: 'team-public' }) });
  assert.equal(response.status, 200);
  assert.equal((db.prepare("SELECT value FROM system_settings WHERE key='site_docs_notebook_id'").get() as {value:string}).value, 'team-public');
  assert.equal((db.prepare("SELECT allowComment FROM notebook_publications WHERE notebookId='team-public'").get() as {allowComment:number}).allowComment, 0);
  assert.equal((db.prepare("SELECT allowComment FROM notebook_publications WHERE notebookId='inaccessible'").get() as {allowComment:number}).allowComment, 1);
  closeDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
