"use strict";

// Estado dos <details> preservado entre redesenhos da aba Atividade.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { create } = require("../renderer/details-state");

test("details-state: guarda aberto/fechado e reaplica o atributo open", () => {
  const s = create();
  assert.equal(s.attr("r1"), "");
  s.set("r1", true);
  assert.equal(s.attr("r1"), " open");
  assert.equal(s.has("r1"), true);
  s.set("r2", true);
  s.set("r1", false);
  assert.equal(s.attr("r1"), "");
  assert.equal(s.attr("r2"), " open");
  assert.equal(s.size(), 1);
});

test("details-state: instancias sao independentes e ids numericos funcionam", () => {
  const a = create();
  const b = create();
  a.set(7, true);
  assert.equal(b.has("7"), false);
  assert.equal(a.has(7), true);
});

test("app.js usa o estado: ledger reaplica open, escuta toggle e preserva a rolagem", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.match(app, /data-ledger="\$\{esc\(reg\.id\)\}"\$\{detailsOpen\.attr\(reg\.id\)\}/);
  assert.match(app, /addEventListener\("toggle"/);
  assert.match(app, /\$\("view"\)\.scrollTop = scrollTop/);
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  assert.ok(html.indexOf("details-state.js") < html.indexOf("app.js"));
});
