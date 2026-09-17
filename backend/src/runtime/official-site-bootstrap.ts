import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { getDb } from "../db/schema.js";
import { ensureNotebookPublicationTables } from "./notebook-publication.js";

export function initializeOfficialSite(): void {
  if (process.env.ZEROWALL_DOCS_SITE !== "1") return;
  const db = getDb();
  ensureNotebookPublicationTables();
  db.transaction(() => {
    let admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string } | undefined;
    if (!admin) {
      const password = process.env.ZEROWALL_ADMIN_PASSWORD || "";
      if (password.length < 24) throw new Error("首次启动必须设置至少 24 位 ZEROWALL_ADMIN_PASSWORD");
      admin = { id: randomUUID() };
      db.prepare("INSERT INTO users (id, username, passwordHash, role, displayName) VALUES (?, 'admin', ?, 'admin', 'ZeroWall Science')").run(admin.id, bcrypt.hashSync(password, 12));
    }
    const setting = db.prepare("INSERT OR IGNORE INTO system_settings (key,value) VALUES (?,?)");
    // 文档站使用自己的入门内容，禁用上游首次登录示例教程。
    db.exec("DROP TRIGGER IF EXISTS users_seed_onboarding_on_first_login; DROP TRIGGER IF EXISTS users_seed_onboarding_after_insert");
    db.prepare("INSERT OR IGNORE INTO user_onboarding_state (userId,version,status) VALUES (?,1,'existing')").run(admin.id);
    for (const [key,value] of Object.entries({
      site_title: "ZeroWall Science 文档", site_favicon: "/admin/zerowall-icon.png",
      site_public_web_origin: "https://zerowallscience.org", site_docs_notebook_id: "zerowall-official-docs",
      "backup:auto": JSON.stringify({ enabled: true, mode: "daily", dailyAt: "03:00", intervalHours: 24, keepCount: 7, backupType: "full", emailOnSuccess: false }),
    })) setting.run(key,value);
    db.prepare("INSERT INTO system_settings (key,value) VALUES ('auth_allow_registration','false') ON CONFLICT(key) DO UPDATE SET value='false'").run();
    const notebook = db.prepare("INSERT OR IGNORE INTO notebooks (id,userId,parentId,name,sortOrder) VALUES (?,?,?,?,?)");
    notebook.run("zerowall-official-docs",admin.id,null,"ZeroWall Science 官方文档",0);
    notebook.run("zerowall-drafts",admin.id,null,"草稿（不公开）",1);
    const contentDir = process.env.ZEROWALL_DOCS_CONTENT || path.resolve("content/docs");
    const manifest = JSON.parse(fs.readFileSync(path.join(contentDir,"manifest.json"),"utf8")) as { groups: { id: string; title: string; pages: { id: string; title: string; file: string }[] }[] };
    manifest.groups.forEach((group,index) => {
      notebook.run(group.id,admin!.id,"zerowall-official-docs",group.title,index);
      group.pages.forEach((page,order) => {
        const content = fs.readFileSync(path.join(contentDir,page.file),"utf8");
        db.prepare("INSERT OR IGNORE INTO notes (id,userId,notebookId,title,content,contentText,contentFormat,sortOrder) VALUES (?,?,?,?,?,?,'markdown',?)")
          .run(page.id,admin!.id,group.id,page.title,content,content,order);
      });
    });
    db.prepare("INSERT OR IGNORE INTO notebook_publications (id,notebookId,ownerId,token,accessMode,permission,allowDownload,allowComment,allowEdit,allowReshare) VALUES (?,'zerowall-official-docs',?,?,'public','read',1,0,0,0)")
      .run("zerowall-official-publication",admin.id,randomBytes(32).toString("base64url"));
  })();
}

initializeOfficialSite();
