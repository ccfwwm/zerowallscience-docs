import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-publication-images-"));
process.env.DB_PATH = path.join(temp, "test.db");
process.env.ELECTRON_USER_DATA = temp;
process.env.ATTACHMENT_SIGNING_SECRET = "publication-image-regression-secret";
process.env.ATTACHMENT_LEGACY_PUBLIC_URL = "false";

test("匿名公开文章支持跨文章图片并持续复核发布边界", async () => {
  const { getDb, closeDb } = require("../src/db/schema");
  const db = getDb();
  try {
    require("../src/runtime/notebook-publication");
    const { sharedRouter } = require("../src/routes/shares");
    const { officialDocs: docs } = require("../src/routes/official-docs");
    const { handleDownloadAttachment } = require("../src/routes/attachments");
    const { createAttachmentSignedUrl, createPublicationAttachmentScope } = require("../src/lib/attachment-signed-url");
    const { getAttachmentsDir } = require("../src/services/attachment-storage");
    const ATTACHMENTS_DIR = getAttachmentsDir();
    const app = new Hono();
    app.route("/api/shared", sharedRouter);
    app.route("/api/docs", docs);
    app.get("/api/attachments/:id", handleDownloadAttachment);
    db.prepare("INSERT INTO users(id,username,passwordHash) VALUES ('image-owner','image-owner','hash')").run();
    for (const id of ["public-root", "private-root"]) {
      db.prepare("INSERT INTO notebooks(id,userId,name) VALUES (?,'image-owner',?)").run(id, id);
    }
    for (const id of ["source", "markdown-target", "rich-target", "locked", "trashed", "private"]) {
      db.prepare("INSERT INTO notes(id,userId,notebookId,title,content,contentText,contentFormat,isLocked,isTrashed) VALUES (?,'image-owner',?,?,?,'','markdown',?,?)")
        .run(id, id === "private" ? "private-root" : "public-root", id, "", Number(id === "locked"), Number(id === "trashed"));
    }
    db.prepare("INSERT INTO notebook_publications(id,notebookId,ownerId,token,accessMode,permission,allowDownload) VALUES ('images-publication','public-root','image-owner','image-token','public','read',1)").run();
    db.prepare("INSERT OR REPLACE INTO system_settings(key,value) VALUES ('site_docs_notebook_id','public-root')").run();
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    ["source", "locked", "trashed", "private"].forEach((note, index) => {
      fs.writeFileSync(path.join(ATTACHMENTS_DIR, `${ids[index]}.png`), png);
      db.prepare("INSERT INTO attachments(id,noteId,userId,filename,mimeType,size,path) VALUES (?,?,'image-owner','image.png','image/png',?,?)")
        .run(ids[index], note, png.length, `${ids[index]}.png`);
    });
    for (const [target, format] of [["markdown-target", "markdown"], ["rich-target", "tiptap-json"]]) {
      const refs = ids.map((id) => `/api/attachments/${id}?w=320`);
      const content = format === "markdown" ? refs.map((src) => `![图片](${src})`).join("\n")
        : JSON.stringify({ type: "doc", content: refs.map((src) => ({ type: "image", attrs: { src } })) });
      db.prepare("UPDATE notes SET content=?,contentFormat=? WHERE id=?").run(content, format, target);
      for (const route of [`/api/docs/notes/${target}`, `/api/shared/notebook-public/image-token/notes/${target}`, `/api/shared/notebook-public/image-token/resources/note:${target}`]) {
        const response = await app.request(route);
        assert.equal(response.status, 200, `${route}: ${response.status === 200 ? "ok" : await response.clone().text()}`);
        const body = await response.json() as { content: string; attachmentUrls: Record<string, string> };
        assert.deepEqual(Object.keys(body.attachmentUrls), [ids[0]], route);
        assert.match(body.content, /w=320/);
        const signed = new URL(body.attachmentUrls[ids[0]], "http://localhost");
        const scope = JSON.parse(Buffer.from(signed.searchParams.get("scope")!.slice(3), "base64url").toString());
        assert.equal(scope.noteId, "source");
        const image = await app.request(signed.pathname + signed.search);
        assert.equal(image.status, 200);
        assert.equal(image.headers.get("Content-Type"), "image/png");
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
      }
    }
    assert.equal((await app.request(`/api/attachments/${ids[0]}`)).status, 404);
    const signed = createAttachmentSignedUrl(`/api/attachments/${ids[0]}`, ids[0], createPublicationAttachmentScope("images-publication", "source"));
    const readSigned = () => app.request(signed);
    for (const state of ["isLocked", "isTrashed"]) {
      db.prepare(`UPDATE notes SET ${state}=1 WHERE id='source'`).run();
      assert.equal((await readSigned()).status, 403);
      db.prepare(`UPDATE notes SET ${state}=0 WHERE id='source'`).run();
    }
    db.prepare("UPDATE notes SET notebookId='private-root' WHERE id='source'").run();
    assert.equal((await readSigned()).status, 403);
    const removed = await (await app.request("/api/docs/notes/markdown-target")).json() as any;
    assert.equal(removed.attachmentUrls[ids[0]], undefined);
    db.prepare("UPDATE notes SET notebookId='public-root' WHERE id='source'").run();
    db.prepare("UPDATE notebook_publications SET allowDownload=0 WHERE id='images-publication'").run();
    assert.equal((await app.request(`${signed}&download=1`)).status, 403);
    db.prepare("UPDATE notebook_publications SET isActive=0 WHERE id='images-publication'").run();
    assert.equal((await readSigned()).status, 403);
    assert.notEqual((await app.request("/api/docs/notes/markdown-target")).status, 200);
  } finally {
    closeDb();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
