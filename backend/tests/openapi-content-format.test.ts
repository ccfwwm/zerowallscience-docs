import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("OpenAPI note schemas include contentFormat", () => {
  const source = readFileSync(path.resolve("src/services/openapi.ts"), "utf8");

  assert.match(source, /contentFormat:\s*\{\s*type:\s*"string"[\s\S]*enum:\s*\[\s*"tiptap-json",\s*"markdown",\s*"plaintext",\s*"html"\s*\]/);
  assert.match(source, /post:\s*\{[\s\S]*contentFormat:\s*\{\s*type:\s*"string"[\s\S]*default:\s*"tiptap-json"/);
  assert.match(source, /put:\s*\{[\s\S]*contentFormat:\s*\{\s*type:\s*"string"[\s\S]*version:\s*\{\s*type:\s*"integer"/);
});
