"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMeetingsStore } = require("../server/meetings-store");
const { parseWrapup, parseAction, wrapupPrompt } = require("../src/meeting-wrapup");

test("reunião começa em preparação e só inicia com consentimento", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-mtg-"));
  const store = createMeetingsStore(dir);
  const created = store.create({ title: "Alinhamento", objective: "Fechar recorte", consented: false });
  assert.equal(created.status, "prep");
  assert.throws(() => store.start(created.id), /outras pessoas/);
  store.update(created.id, { consented: true });
  const live = store.start(created.id);
  assert.equal(live.status, "live");
});

test("encerrar guarda transcrição e wrapup sem inventar sessão extra", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-mtg-"));
  const store = createMeetingsStore(dir);
  const created = store.create({ title: "Sync", consented: true });
  store.start(created.id);
  const ended = store.end(created.id, {
    lines: [{ who: "them", text: "Vamos publicar na sexta." }, { who: "me", text: "Eu envio o rascunho." }],
    wrapup: { resumo: "Publicar na sexta.", decisoes: ["Publicar na sexta"], pendencias: [{ text: "Você: enviar rascunho", owner: "Você", due: "" }], proximosPassos: [] },
    durationMs: 120000,
  });
  assert.equal(ended.status, "ended");
  assert.equal(ended.durationMs, 120000);
  assert.equal(ended.lines.length, 2);
  assert.equal(ended.wrapup.resumo, "Publicar na sexta.");
  assert.equal(store.list().length, 1);
});

test("wrapup só extrai responsável e prazo quando o texto cita", () => {
  const parsed = parseWrapup(`## Resumo\nAlinhamos o recorte.\n\n## Decisões\n- Manter o recorte\n\n## Pendências\n- Você: enviar o rascunho até sexta\n- Revisar o texto\n\n## Próximos passos\n- Nenhuma`);
  assert.match(parsed.resumo, /recorte/);
  assert.equal(parsed.decisoes[0], "Manter o recorte");
  assert.equal(parsed.pendencias[0].owner, "Você");
  assert.match(parsed.pendencias[0].due, /sexta/i);
  assert.equal(parsed.pendencias[1].owner, "");
  assert.equal(parsed.proximosPassos.length, 0);
  const action = parseAction("Ana: mandar o PDF até 12/11");
  assert.equal(action.owner, "Ana");
  assert.match(action.due, /12\/11/);
});

test("prompt de fechamento pede para não inventar e não enviar follow-up", () => {
  const messages = wrapupPrompt([{ who: "them", text: "ok" }], { title: "Sync", objective: "Fechar recorte" });
  const blob = messages.map((m) => m.content).join("\n");
  assert.match(blob, /Nunca invente/);
  assert.match(blob, /não diga que algo foi enviado/i);
  assert.match(blob, /Fechar recorte/);
});
