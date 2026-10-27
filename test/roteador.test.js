"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { suggest } = require("../server/gabinete");
const { boot, json, rpcCall, inbox } = require("./helpers-ideias");

const GERAL = { id: "default", name: "HELIOS", role: "Assistente geral", instructions: "", builtin: true, template: null };
const lista = (...extra) => [GERAL, ...extra];
const FIN = { id: "a1", name: "Finanças da casa", role: "Contas, vencimentos e orçamento doméstico", instructions: "Valores em reais", template: "financas-da-casa" };
const AGENDA = { id: "a2", name: "Agenda", role: "Compromissos, lembretes e rotinas", instructions: "", template: "agenda" };
const CODIGO = { id: "a3", name: "Código", role: "Revisão e pequenas mudanças de código", instructions: "", template: "codigo" };
const CASA = { id: "a4", name: "Zeca", role: "Cuida da reforma", instructions: "Ajuda a comparar orçamentos de pedreiro e pintor.", template: null };

test("sugere o especialista pelo nome, função e dicas do modelo", () => {
  const todos = lista(FIN, AGENDA, CODIGO);
  assert.equal(suggest("preciso pagar o boleto da luz que vence amanhã", todos).suggestion.assistantId, "a1");
  assert.equal(suggest("marcar reunião com o time na quinta e criar um lembrete", todos).suggestion.assistantId, "a2");
  assert.equal(suggest("achei um bug nesta função, ajuda a corrigir o código?", todos).suggestion.assistantId, "a3");
  const out = suggest("quanto gastei de orçamento esse mês", todos);
  assert.equal(out.suggestion.assistantId, "a1");
  assert.ok(out.suggestion.why.length > 0, "explica por quê");
  assert.equal(out.executed, false);
  assert.match(out.note, /nada foi enviado nem executado/);
});

test("funciona com assistente de nome livre, usando a função e as instruções", () => {
  const out = suggest("quero comparar o orçamento do pedreiro", lista(FIN, CASA));
  assert.equal(out.suggestion.assistantId, "a4");
});

test("sem combinação clara cai no assistente geral, com confiança baixa e sem inventar", () => {
  const out = suggest("qual a capital da Mongólia", lista(FIN, AGENDA));
  assert.equal(out.suggestion.assistantId, "default");
  assert.equal(out.suggestion.confidence, "baixa");
  assert.deepEqual(out.suggestion.why, []);
  const semEspecialista = suggest("pagar boleto", lista());
  assert.equal(semEspecialista.suggestion.assistantId, "default");
  assert.match(semEspecialista.suggestion.reason, /ainda não tem assistentes/);
});

test("pedido vazio é recusado e o pedido é limitado em tamanho", () => {
  assert.throws(() => suggest("  ", lista(FIN)), /Escreva o pedido/);
  const out = suggest(`boleto ${"x ".repeat(5000)}`, lista(FIN));
  assert.equal(out.suggestion.assistantId, "a1");
});

test("endpoint e MCP só sugerem: nenhuma conversa nova, nenhum cartão, nada enviado", async () => {
  const app = await boot();
  try {
    await json(app, "/api/assistants", { method: "POST", body: { template: "financas-da-casa" } });
    await json(app, "/api/assistants", { method: "POST", body: { template: "agenda" } });
    const before = (await json(app, "/api/conversations")).body.conversations.length;
    const res = await json(app, "/api/roteador", { method: "POST", body: { texto: "pagar a fatura do cartão que vence sexta" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.suggestion.name, "Finanças da casa");
    assert.equal(res.body.executed, false);
    assert.equal((await json(app, "/api/roteador", { method: "POST", body: { texto: "" } })).status, 400);
    const viaMcp = await rpcCall(app, "helios_sugerir_assistente", { pedido: "marcar uma reunião amanhã" });
    assert.equal(viaMcp.suggestion.name, "Agenda");
    assert.equal((await json(app, "/api/conversations")).body.conversations.length, before, "não criou conversa");
    assert.equal((await inbox(app)).count, 0);
  } finally {
    await app.close();
  }
});