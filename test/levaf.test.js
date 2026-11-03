"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const R = (f) => fs.readFileSync(path.join(__dirname, "..", "renderer", f), "utf8");

test("leva F: sidebar com assistentes, conversas, caixa de entrada e ajustes", () => {
  const html = R("index.html");
  for (const id of ["lfNew", "lfSearch", "lfAssistants", "lfConvs", "inboxBadge", "lfSettings", "lfRight", "lfModal", "openMeeting", "lfPanelToggle"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const tab of ["Detalhes", "Biblioteca", "Atividade"]) assert.match(html, new RegExp(`>${tab}</button>`));
  for (const set of ["account", "context", "memory", "autonomy", "routines", "vagas", "vault", "mcp", "ditado", "activity", "aparencia"]) {
    assert.match(html, new RegExp(`data-set="${set}"`), set);
  }
  assert.match(html, /data-lf-go="time"/);
  assert.match(html, /<script src="layout.js"><\/script>/);
});

test("leva F: nenhuma tela antiga sumiu (todas as views seguem com botão)", () => {
  const html = R("index.html");
  const app = R("app.js");
  const titles = app.slice(app.indexOf("const TITLES"), app.indexOf("};", app.indexOf("const TITLES")));
  const views = [...titles.matchAll(/^\s+([a-z]+):/gm)].map((m) => m[1]);
  assert.ok(views.length >= 15);
  for (const v of views) assert.match(html, new RegExp(`data-view="${v}"`), v);
});

test("leva F: dois temas (preto e branco com dourado) e composer com anexo", () => {
  const css = R("layout.css");
  assert.match(css, /\[data-theme="dark"\][\s\S]*--lf-gold/);
  assert.match(css, /\[data-theme="light"\][\s\S]*--lf-gold/);
  const app = R("app.js");
  assert.match(app, /id="attachBtn"/);
  assert.match(app, /function bindAttach/);
});

test("leva F: o modo reunião não carrega o layout novo", () => {
  const meeting = R(path.join("meeting", "index.html"));
  assert.equal(meeting.includes("layout.css"), false);
  assert.equal(meeting.includes("layout.js"), false);
});

test("leva F: helios_ajustes no agente, com cartão para ações de risco", () => {
  const bot = fs.readFileSync(path.join(__dirname, "..", "server", "bot.js"), "utf8");
  assert.match(bot, /helios_ajustes/);
  assert.match(bot, /kind: "ajuste"/);
  assert.match(bot, /action\.tipo === "ajuste"/);
  const index = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  assert.match(index, /settings: chatSettings/);
  for (const a of ["vagas_modo", "contexto_acrescentar", "abrir_reuniao"]) assert.match(index, new RegExp(a));
});
