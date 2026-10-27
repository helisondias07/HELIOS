"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { boot, json, say, inbox, runRoutine } = require("./helpers-ideias");

const MIN = 60 * 1000;
const clockAt = () => {
  const clock = { t: Date.parse("2026-10-25T12:00:00Z") };
  clock.now = () => clock.t;
  return clock;
};
const outbox = (app) => path.join(app.dataDir, "outbox.json");
const outboxCount = (app) => (fs.existsSync(outbox(app)) ? JSON.parse(fs.readFileSync(outbox(app), "utf8")).length : 0);

test("aprovação de rotina expira em 10 min sem executar; aprovar depois é recusado; reabrir permite decidir", async () => {
  const clock = clockAt();
  const app = await boot({ now: clock.now });
  try {
    const out = await runRoutine(app, "Resumo diário", "enviar o resumo para o time");
    assert.equal(out.status, "pendente");
    let box = await inbox(app);
    assert.equal(box.count, 1);
    assert.equal(box.items[0].origin, "rotina");
    assert.equal(Date.parse(box.items[0].expiresAt), clock.t + 10 * MIN, "validade padrão: 10 minutos");
    const { convId, id } = box.items[0];

    clock.t += 9 * MIN;
    assert.equal((await inbox(app)).count, 1, "aos 9 min ainda vale");

    // Vence entre as varreduras: aprovar agora NÃO executa.
    clock.t += 2 * MIN;
    const late = await json(app, `/api/conversations/${convId}/approvals/${id}`, { method: "POST", body: { decision: "approve" } });
    assert.equal(late.status, 409);
    assert.match(late.body.error, /expirou/);
    assert.equal(outboxCount(app), 0, "nada foi enviado");

    box = await inbox(app);
    assert.equal(box.count, 0);
    assert.equal(box.expiredCount, 1);
    assert.equal(box.expired[0].id, id);
    assert.equal(box.expired[0].origin, "rotina");
    const conv = (await json(app, `/api/conversations/${convId}`)).body.conversation;
    const card = conv.messages.find((message) => message.id === id);
    assert.equal(card.state, "expired");
    assert.match(card.result, /nada foi feito/);

    // Ajustar um expirado também não vale; só reabrir (ou descartar).
    assert.equal((await json(app, `/api/conversations/${convId}/approvals/${id}`, { method: "POST", body: { decision: "adjust" } })).status, 409);

    // Reabrir: volta a pendente com validade nova. Ainda não executou nada.
    const reopened = await json(app, `/api/conversations/${convId}/approvals/${id}`, { method: "POST", body: { decision: "reopen" } });
    assert.equal(reopened.status, 200);
    assert.equal(outboxCount(app), 0);
    box = await inbox(app);
    assert.equal(box.count, 1);
    assert.equal(Date.parse(box.items[0].expiresAt), clock.t + 10 * MIN);
    assert.equal((await json(app, `/api/conversations/${convId}/approvals/${id}`, { method: "POST", body: { decision: "reopen" } })).status, 409, "pendente não se reabre");

    const ok = await json(app, `/api/conversations/${convId}/approvals/${id}`, { method: "POST", body: { decision: "approve" } });
    assert.equal(ok.status, 200);
    assert.equal(outboxCount(app), 1, "só agora, com o OK do Helison");
  } finally {
    await app.close();
  }
});

test("pedido de uma conversa ativa nunca expira", async () => {
  const clock = clockAt();
  const app = await boot({ now: clock.now });
  try {
    const conv = await say(app, "enviar o resumo para o time");
    const card = conv.messages.find((message) => message.role === "approval");
    assert.equal(card.state, "pending");
    assert.equal(card.expiresAt, null);
    clock.t += 72 * 60 * MIN;
    const box = await inbox(app);
    assert.equal(box.count, 1);
    assert.equal(box.expiredCount, 0);
    assert.equal(box.items[0].expiresAt, null);
    assert.equal((await json(app, `/api/conversations/${conv.id}/approvals/${card.id}`, { method: "POST", body: { decision: "approve" } })).status, 200);
    assert.equal(outboxCount(app), 1);
  } finally {
    await app.close();
  }
});

test("validade configurável em Atividade (piso 1 min, teto 24 h) e vale para o próximo pedido", async () => {
  const clock = clockAt();
  const app = await boot({ now: clock.now });
  try {
    const view = (await json(app, "/api/atividade")).body.limits.find((item) => item.key === "aprovacaoExpiraMin");
    assert.equal(view.value, 10);
    assert.equal((await json(app, "/api/atividade/limites", { method: "POST", body: { aprovacaoExpiraMin: 0 } })).body.limits.aprovacaoExpiraMin, 1);
    assert.equal((await json(app, "/api/atividade/limites", { method: "POST", body: { aprovacaoExpiraMin: 999999 } })).body.limits.aprovacaoExpiraMin, 1440);
    await json(app, "/api/atividade/limites", { method: "POST", body: { aprovacaoExpiraMin: 2 } });
    await runRoutine(app, "Rápida", "apagar o rascunho antigo");
    const box = await inbox(app);
    assert.equal(Date.parse(box.items[0].expiresAt), clock.t + 2 * MIN);
    clock.t += 3 * MIN;
    const after = await inbox(app);
    assert.equal(after.count, 0);
    assert.equal(after.expiredCount, 1);
  } finally {
    await app.close();
  }
});

test("pedido de ajudante expira, a conversa dele fica para reabrir e descartar a remove", async () => {
  const clock = clockAt();
  const app = await boot({ now: clock.now });
  try {
    await say(app, "crie um ajudante para enviar o relatório");
    const box = await inbox(app);
    assert.equal(box.count, 1);
    assert.equal(box.items[0].origin, "ajudante");
    assert.ok(box.items[0].expiresAt);
    const { convId, id } = box.items[0];
    clock.t += 11 * MIN;
    const after = await inbox(app);
    assert.equal(after.count, 0);
    assert.equal(after.expired[0].origin, "ajudante");
    assert.equal((await json(app, `/api/conversations/${convId}`)).status, 200, "a conversa do ajudante é mantida enquanto houver expirado");
    assert.equal(outboxCount(app), 0);
    const denied = await json(app, `/api/conversations/${convId}/approvals/${id}`, { method: "POST", body: { decision: "deny" } });
    assert.equal(denied.status, 200);
    assert.equal((await json(app, `/api/conversations/${convId}`)).status, 404, "descartado: a conversa descartável some");
    assert.equal((await inbox(app)).expiredCount, 0);
  } finally {
    await app.close();
  }
});

test("quem expira com o app fechado continua expirado ao abrir (nunca vira execução)", async () => {
  const clock = clockAt();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-exp-"));
  let app = await boot({ dataDir, now: clock.now });
  try {
    await runRoutine(app, "Noturna", "enviar o resumo para o time");
    assert.equal((await inbox(app)).count, 1);
  } finally {
    await app.close();
  }
  clock.t += 30 * MIN;
  app = await boot({ dataDir, now: clock.now });
  try {
    const box = await inbox(app);
    assert.equal(box.count, 0);
    assert.equal(box.expiredCount, 1);
    assert.equal(outboxCount(app), 0);
  } finally {
    await app.close();
  }
});

test("expirados com mais de 7 dias são descartados e deixam de aparecer", async () => {
  const clock = clockAt();
  const app = await boot({ now: clock.now });
  try {
    await runRoutine(app, "Antiga", "publicar o post");
    clock.t += 11 * MIN;
    assert.equal((await inbox(app)).expiredCount, 1);
    clock.t += 8 * 24 * 60 * MIN;
    const box = await inbox(app);
    assert.equal(box.expiredCount, 0);
    assert.equal(outboxCount(app), 0);
  } finally {
    await app.close();
  }
});