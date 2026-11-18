"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ctx = require("../src/meeting-context");

test("glossário ignora notas, duplicados e segredos", () => {
  const { entries, skipped } = ctx.parseGlossary([
    "# título",
    "- sprint = sprint (não traduzir)",
    "deploy -> publicação",
    "senha: abc12345",
    "token = sk-abcdefghijklmnopqrstuvwxyz0123456789",
  ].join("\n"));
  assert.deepEqual(entries.map((e) => e.term), ["sprint", "deploy"]);
  assert.ok(skipped >= 1);
  assert.ok(!JSON.stringify(entries).includes("sk-"));
});

test("bloco de contexto só leva termos que aparecem", () => {
  const entries = ctx.parseGlossary("sprint = ciclo\nstorefront = vitrine").entries;
  const block = ctx.buildBlock({ meetingContext: "Alinhamento do time", entries, haystack: "we finished the sprint" });
  assert.match(block, /Alinhamento do time/);
  assert.match(block, /sprint = ciclo/);
  assert.doesNotMatch(block, /storefront/);
});
