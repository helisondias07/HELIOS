"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUsage } = require("../server/usage");
const { boot, json, say } = require("./helpers-ideias");

const uso = async (app) => (await json(app, "/api/uso")).body;
const rowOf = (data, id = "default") => data.assistants.find((row) => row.assistantId === id);
const lastReply = (conv) => conv.messages.filter((message) => message.role === "assistant").pop().text;

test("painel de uso: conta mensagens, chamadas, caracteres e tempo; tokens ficam em 0 e a tela avisa que é aproximado", async () => {
  const app = await boot();
  try {
    const before = await uso(app);
    assert.equal(before.approximate, true);
    assert.match(before.note, /aproximado/i);
    assert.equal(rowOf(before).today.mensagens, 0);
    assert.equal(rowOf(before).state, "sem-limite");
    assert.equal(rowOf(before).percent, null);
    await say(app, "oi, tudo bem?");
    await say(app, "e agora?");
    const row = rowOf(await uso(app));
    assert.equal(row.today.mensagens, 2);
    assert.equal(row.today.chamadas, 2);
    assert.ok(row.today.caracteresEnviados > 0 && row.today.caracteresRecebidos > 0);
    assert.equal(row.today.tokens, 0, "o demo não informa tokens e nada é inventado");
    assert.equal(row.total.mensagens, 2);
  } finally {
    await app.close();
  }
});

test("limite por assistente: aviso ao cruzar 80% e 100%, sem bloquear quando o bloqueio está desligado", async () => {
  const app = await boot();
  try {
    const res = await json(app, "/api/uso/default/limite", { method: "POST", body: { chamadasPorDia: 5 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.status.state, "ok");
    const texts = [];
    let convId;
    for (let i = 0; i < 6; i += 1) {
      const conv = await say(app, `pergunta ${i}`, convId);
      convId = conv.id;
      texts.push(lastReply(conv));
    }
    assert.doesNotMatch(texts[2], /Uso do dia/);
    assert.match(texts[3], /Uso do dia: 80% do limite/, "4 de 5 = 80%");
    assert.match(texts[4], /limite de HELIOS atingido \(100%\)/);
    assert.match(texts[4], /bloqueio está desligado/);
    assert.doesNotMatch(texts[5], /bloqueados/, "sem bloqueio, segue funcionando");
    const data = await uso(app);
    assert.equal(rowOf(data).today.chamadas, 6);
    assert.equal(rowOf(data).state, "limite");
    assert.equal(rowOf(data).blocked, false);
    assert.deepEqual(data.alerts.map((item) => item.state), ["limite"]);
  } finally {
    await app.close();
  }
});

test("bloqueio opcional: no limite a mensagem não chega ao modelo e a conversa não fica ocupada", async () => {
  const app = await boot();
  try {
    await json(app, "/api/uso/default/limite", { method: "POST", body: { chamadasPorDia: 2, bloquear: true } });
    let convId;
    for (let i = 0; i < 2; i += 1) convId = (await say(app, `pergunta ${i}`, convId)).id;
    const conv = await say(app, "mais uma", convId);
    assert.equal(conv.busy, false);
    const reply = conv.messages.filter((message) => message.role === "assistant").pop();
    assert.equal(reply.status, "error");
    assert.match(reply.text, /limite de uso de hoje do assistente HELIOS foi atingido \(2 de 2 chamadas\)/);
    assert.match(reply.text, /Nada foi enviado ao modelo/);
    const row = rowOf(await uso(app));
    assert.equal(row.today.chamadas, 2, "a chamada bloqueada não conta");
    assert.equal(row.blocked, true);

    // Aumentar o limite libera de novo.
    await json(app, "/api/uso/default/limite", { method: "POST", body: { chamadasPorDia: 10 } });
    assert.equal(lastReply(await say(app, "agora vai", convId)).includes("Nada foi enviado"), false);
  } finally {
    await app.close();
  }
});

test("ajudantes e consultas contam para o assistente que os pediu e o bloqueio vale para eles", async () => {
  const app = await boot();
  try {
    await say(app, "crie um ajudante para olhar a agenda");
    let row = rowOf(await uso(app));
    assert.equal(row.today.ajudantes, 1);
    assert.equal(row.today.mensagens, 1);
    assert.equal(row.today.chamadas, 2, "a mensagem e o ajudante");
    await json(app, "/api/uso/default/limite", { method: "POST", body: { chamadasPorDia: 2, bloquear: true } });
    const conv = await say(app, "crie um ajudante para olhar a agenda");
    assert.match(lastReply(conv), /limite de uso de hoje/, "bloqueado antes de criar ajudante");
    row = rowOf(await uso(app));
    assert.equal(row.today.ajudantes, 1);
  } finally {
    await app.close();
  }
});

test("cada assistente tem o seu medidor e o seu limite", async () => {
  const app = await boot();
  try {
    const created = (await json(app, "/api/assistants", { method: "POST", body: { name: "Financas", role: "contas da casa", instructions: "ajude com contas" } })).body;
    const id = created.assistant?.id || created.id;
    assert.ok(id);
    await json(app, `/api/uso/${id}/limite`, { method: "POST", body: { chamadasPorDia: 1, bloquear: true } });
    const conv = (await json(app, "/api/conversations", { method: "POST", body: { assistantId: id } })).body.conversation;
    await say(app, "oi", conv.id);
    assert.match(lastReply(await say(app, "oi de novo", conv.id)), /assistente Financas/);
    const other = await say(app, "oi");
    assert.doesNotMatch(lastReply(other), /limite de uso/, "o padrão não tem limite");
    const data = await uso(app);
    assert.equal(rowOf(data, id).today.mensagens, 1);
    assert.equal(rowOf(data).today.mensagens, 1);
  } finally {
    await app.close();
  }
});

test("validação: limite negativo ou não numérico, bloquear não booleano e assistente inexistente", async () => {
  const app = await boot();
  try {
    assert.equal((await json(app, "/api/uso/default/limite", { method: "POST", body: { chamadasPorDia: -1 } })).status, 400);
    assert.equal((await json(app, "/api/uso/default/limite", { method: "POST", body: { tokensPorDia: "muito" } })).status, 400);
    assert.equal((await json(app, "/api/uso/default/limite", { method: "POST", body: { bloquear: "sim" } })).status, 400);
    assert.equal((await json(app, "/api/uso/nao-existe/limite", { method: "POST", body: { chamadasPorDia: 5 } })).status, 404);
    const ok = await json(app, "/api/uso/default/limite", { method: "POST", body: { chamadasPorDia: 0 } });
    assert.equal(ok.body.status.state, "sem-limite", "0 = sem limite");
  } finally {
    await app.close();
  }
});

test("uso diário zera à meia-noite, o acumulado e os limites sobrevivem a reiniciar, e tokens só entram quando o SDK informa", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-uso-"));
  const clock = { t: new Date(2026, 9, 25, 10, 0, 0).getTime() };
  let usage = createUsage(dir, { now: () => clock.t });
  usage.setLimit("a1", { tokensPorDia: 1000, bloquear: true });
  usage.record("a1", { kind: "mensagem", charsIn: 100, charsOut: 50, ms: 200 });
  assert.equal(usage.status("a1").percent, 0);
  assert.equal(usage.status("a1").state, "ok");
  usage.record("a1", { kind: "mensagem", usage: { inputTokens: 500, outputTokens: 350 } });
  const s = usage.status("a1");
  assert.equal(s.today.tokens, 850);
  assert.equal(s.today.execucoesComTokens, 1);
  assert.equal(s.percent, 85);
  assert.equal(s.state, "alerta");
  assert.equal(usage.blockReason("a1", "Ana"), null, "alerta não bloqueia");
  usage.record("a1", { kind: "ajudante", usage: { totalTokens: 200 } });
  assert.match(usage.blockReason("a1", "Ana"), /1050 de 1000 tokens/);

  usage = createUsage(dir, { now: () => clock.t });
  assert.equal(usage.status("a1").today.chamadas, 3, "sobrevive ao reinício");
  assert.equal(usage.status("a1").limit.bloquear, true);
  clock.t += 24 * 60 * 60 * 1000;
  const next = usage.status("a1");
  assert.equal(next.today.chamadas, 0, "novo dia");
  assert.equal(next.total.chamadas, 3, "acumulado permanece");
  assert.equal(next.blocked, false);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, "uso.json"), "utf8"))).includes("senha"), false);
});