"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ctx = require("../src/meeting-context");
const prompts = require("../src/meeting-prompts");
const { createSettings } = require("../src/settings-store");

test("glossário: aceita vários formatos, ignora notas, duplicados e segredos", () => {
  const { entries, skipped } = ctx.parseGlossary([
    "# título",
    "> nota",
    "- sprint = sprint (não traduzir)",
    "deploy -> publicação",
    "PR: pull request",
    "checkout | finalização da compra",
    "Sprint = duplicado",
    "senha: abc12345",
    "token = sk-abcdefghijklmnopqrstuvwxyz0123456789",
    "linha sem separador",
  ].join("\n"));
  assert.deepEqual(entries.map((e) => e.term), ["sprint", "deploy", "PR", "checkout"]);
  assert.equal(entries[1].meaning, "publicação");
  assert.ok(skipped >= 1);
  assert.ok(!JSON.stringify(entries).includes("sk-"));
});

test("glossário: limita quantidade e tamanho", () => {
  const many = Array.from({ length: 200 }, (_, i) => `termo${i} = ${"x".repeat(400)}`).join("\n");
  const { entries } = ctx.parseGlossary(many);
  assert.ok(entries.length <= ctx.LIMITS.glossaryEntries);
  assert.ok(entries.every((e) => e.meaning.length <= ctx.LIMITS.glossaryMeaning));
});

test("bloco de contexto: só termos que aparecem, com acento ou não", () => {
  const entries = ctx.parseGlossary("sprint = ciclo\nstorefront = vitrine\nrefatoração = refactoring").entries;
  const block = ctx.buildBlock({ meetingContext: "Entrevista na Wake", entries, haystack: "we finished the sprint and the refatoracao" });
  assert.match(block, /Contexto da reunião: Entrevista na Wake/);
  assert.match(block, /sprint = ciclo/);
  assert.match(block, /refatoração = refactoring/);
  assert.doesNotMatch(block, /storefront/);
});

test("bloco de contexto: respeita o limite de caracteres e prioriza as falas mais novas", () => {
  const history = Array.from({ length: 6 }, (_, i) => `fala numero ${i} ${"palavra ".repeat(30)}`);
  const block = ctx.buildBlock({ meetingContext: "a".repeat(900), history, maxChars: 400 });
  assert.ok(block.length <= 400);
  const full = ctx.buildBlock({ meetingContext: "Reunião", history: ["primeira fala", "segunda fala"], maxChars: 1200 });
  assert.match(full, /NÃO traduza/);
  assert.ok(full.indexOf("primeira") < full.indexOf("segunda"));
  const tight = ctx.buildBlock({ meetingContext: "Reunião", history: ["alfa ".repeat(30), "beta ".repeat(30), "gama ".repeat(30), "delta ".repeat(30)], maxChars: 400 });
  assert.ok(tight.length <= 400);
  assert.ok(!tight.includes("alfa") && tight.includes("delta"));
});

test("segredos nunca entram no bloco que vai ao modelo", () => {
  const secret = "minha chave sk-abcdefghijklmnopqrstuvwxyz0123456789";
  assert.ok(ctx.problem(secret));
  assert.ok(ctx.problem("fale com joao@exemplo.com"));
  assert.equal(ctx.problem("Entrevista para dev front-end"), "");
  const block = ctx.buildBlock({ meetingContext: secret, history: [secret, "fala normal"], entries: [], maxChars: 800 });
  assert.ok(!block.includes("sk-"));
  assert.match(block, /fala normal/);
});

test("tradução: sem contexto o prompt é idêntico ao antigo; com contexto só acrescenta", () => {
  const items = [{ id: 1, text: "hello" }, { id: 2, text: "world" }];
  const plain = prompts.translateBatch(items);
  assert.deepEqual(prompts.translateBatch(items, {}), plain);
  assert.deepEqual(prompts.translateBatch(items, { block: "", formality: "" }), plain);
  const withCtx = prompts.translateBatch(items, { block: "Contexto da reunião: loja", formality: ctx.formalityLine("formal") });
  assert.equal(withCtx[0].content.startsWith(plain[0].content), true);
  assert.match(withCtx[0].content, /Contexto da reunião: loja/);
  assert.match(withCtx[0].content, /formal/);
  assert.deepEqual(withCtx.slice(1), plain.slice(1));
  assert.equal(ctx.formalityLine("neutro"), "");
  assert.equal(ctx.formalityLine("qualquer"), "");
});

test("respostas: contexto vai ao sistema e 'both' pede uma resposta em EN e PT (Leva H)", () => {
  const lines = [{ who: "them", text: "Tell me about your last project?" }];
  const msgs = prompts.suggest(lines, { lang: "both", myContext: "dev", meeting: "Contexto da reunião: vaga na Wake" });
  assert.match(msgs[0].content, /vaga na Wake/);
  const user = msgs[msgs.length - 1].content;
  assert.doesNotMatch(user, /OPÇÃO/);
  assert.equal((user.match(/^EN:/gm) || []).length, 1);
  assert.equal((user.match(/^PT:/gm) || []).length, 1);
  const en = prompts.suggest(lines, { lang: "en", meeting: "CTX-X" });
  assert.match(en[0].content, /CTX-X/);
  const sum = prompts.summary(lines, { meeting: "CTX-Y" });
  assert.match(sum[0].content, /CTX-Y/);
});

test("pesquisa: monta a consulta com o contexto, nunca abre nada e recusa segredo", () => {
  const built = ctx.buildSearch({ term: "storefront", meetingContext: "Entrevista para desenvolvedor front-end em e-commerce Wake" });
  assert.match(built.query, /^storefront /);
  assert.match(built.query, /entrevista/);
  assert.ok(built.url.startsWith("https://www.google.com/search?q="));
  assert.equal(decodeURIComponent(built.url.split("q=")[1]), built.query);
  const fromLine = ctx.buildSearch({ lastLine: "We use Fiturban and Wake for the storefront", meetingContext: "" });
  assert.match(fromLine.query, /Fiturban/);
  assert.throws(() => ctx.buildSearch({ term: "", lastLine: "", meetingContext: "x" }), /Selecione/);
  assert.throws(() => ctx.buildSearch({ term: "sk-abcdefghijklmnopqrstuvwxyz0123456789" }));
  assert.equal(ctx.searchUrl("wake fiturban"), "https://www.google.com/search?q=wake%20fiturban");
  assert.throws(() => ctx.searchUrl(""), /vazia/);
  assert.throws(() => ctx.searchUrl("joao@exemplo.com"));
  assert.ok(!ctx.searchUrl("a&b=c https://evil.example").includes("&b="));
});

test("configurações: novos campos têm padrão e são validados", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-mctx-"));
  const settings = createSettings(dir);
  const view = settings.publicView();
  assert.equal(view.meetingContext, "");
  assert.equal(view.formality, "neutro");
  assert.equal(view.translateHistory, 3);
  assert.equal(view.translateContextChars, 1200);
  settings.update({ meetingContext: "x".repeat(2000), formality: "gíria", translateHistory: 99, translateContextChars: 5 });
  const next = settings.publicView();
  assert.equal(next.meetingContext.length, 800);
  assert.equal(next.formality, "neutro");
  assert.equal(next.translateHistory, 6);
  assert.equal(next.translateContextChars, 300);
  settings.update({ formality: "informal", translateHistory: 0 });
  assert.equal(settings.publicView().formality, "informal");
  assert.equal(settings.publicView().translateHistory, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});