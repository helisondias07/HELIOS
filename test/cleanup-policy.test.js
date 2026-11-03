"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

test("limpeza: snapshots não ficam na raiz e a política aponta para arquivo externo", () => {
  const entries = fs.readdirSync(ROOT, { withFileTypes: true }).map((entry) => entry.name);
  assert.equal(entries.some((name) => /^\.backup-/i.test(name)), false);
  const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(ignore, /\.backup-\*\//);
  const policy = fs.readFileSync(path.join(ROOT, "docs", "operacao", "limpeza-repositorio.md"), "utf8");
  assert.match(policy, /baseline externa/i);
});
