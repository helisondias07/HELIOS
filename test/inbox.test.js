"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../server/index");
const { buildInbox } = require("../server/inbox");
const { createStore } = require("../server/store");

async function boot(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-inbox-"));
  return startServer({
    dataDir,
    projectsDir: path.join(dataDir, "projetos"),
    port: 0,
    mock: true,
    routineMs: 0,
    openEditor: () => ({ ok: true, cmd: "code" }),
    getVaultIndex: () => [{ id: "login_1", tipo: "login", nome: "GitHub", senha: "super-secreta" }],
    onFillLogin: async () => ({ ok: true }),
    ...extra,
  });
}

async function json(app, pathname, opts = {}) {
  const res = await fetch(`${app.url}${pathname}`, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function waitIdle(app, id) {
  for (let i = 0; i < 60; i += 1) {
    const { body } = await json(app, `/api/conversations/${id}`);
    if (!body.conversation.busy) return body.conversation;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("a conversa não ficou pronta");
}

async function say(app, id, text) {
  await json(app, `/api/conversations/${id}/messages`, { method: "POST", body: { text } });
  return waitIdle(app, id);
}

test("caixa de entrada junta aprovações e perguntas de várias conversas e rotinas", async () => {
  const app = await boot();
  try {
    const empty = await json(app, "/api/inbox");
    assert.equal(empty.status, 200);
    assert.equal(empty.body.count, 0);

    const a = (await json(app, "/api/conversations", { method: "POST", body: {} })).body.conversation;
    const b = (await json(app, "/api/conversations", { method: "POST", body: {} })).body.conversation;
    await say(app, a.id, "enviar o resumo para o time");
    await say(app, b.id, "me pergunte se posso apagar o rascunho");
    // uma rotina cria a própria conversa, com o título "Rotina: ..."
    const rotConv = (await json(app, "/api/conversations", { method: "POST", body: { title: "Rotina: Fechamento" } })).body.conversation;
    await say(app, rotConv.id, "pagar a conta de luz");

    const inbox = (await json(app, "/api/inbox")).body;
    assert.equal(inbox.count, 3);
    const kinds = inbox.items.map((item) => item.kind).sort();
    assert.deepEqual(kinds, ["approval", "approval", "question"]);
    const question = inbox.items.find((item) => item.kind === "question");
    assert.equal(question.convId, b.id);
    assert.deepEqual(question.options, ["Sim", "Não"]);
    const fromRoutine = inbox.items.find((item) => item.origin === "rotina");
    assert.equal(fromRoutine.convId, rotConv.id);
    assert.equal(fromRoutine.tipo, "pagar");
    assert.equal(JSON.stringify(inbox).includes("super-secreta"), false);
  } finally {
    await app.close();
  }
});

test("aprovar, ajustar, negar e responder pela caixa de entrada esvazia a lista", async () => {
  const app = await boot();
  try {
    const conv = (await json(app, "/api/conversations", { method: "POST", body: {} })).body.conversation;
    await say(app, conv.id, "enviar o resumo para o time");
    await say(app, conv.id, "enviar o relatório de ontem");
    await say(app, conv.id, "apagar o rascunho");
    await say(app, conv.id, "me pergunte qual cliente atender primeiro");
    let inbox = (await json(app, "/api/inbox")).body;
    assert.equal(inbox.count, 4);
    const [send1, send2, del] = ["enviar o resumo", "enviar o relatório", "apagar o rascunho"].map((frag) => inbox.items.find((item) => item.summary.includes(frag)));
    const q = inbox.items.find((item) => item.kind === "question");

    const approved = await json(app, `/api/conversations/${send1.convId}/approvals/${send1.id}`, { method: "POST", body: { decision: "approve" } });
    assert.equal(approved.body.conversation.messages.find((m) => m.id === send1.id).state, "done");
    const adjusted = await json(app, `/api/conversations/${send2.convId}/approvals/${send2.id}`, { method: "POST", body: { decision: "adjust", note: "mande só o resumo" } });
    assert.equal(adjusted.body.conversation.messages.find((m) => m.id === send2.id).state, "adjust");
    const denied = await json(app, `/api/conversations/${del.convId}/approvals/${del.id}`, { method: "POST", body: { decision: "deny" } });
    const deniedCard = denied.body.conversation.messages.find((m) => m.id === del.id);
    assert.equal(deniedCard.state, "denied");
    assert.match(deniedCard.result, /Negado/);

    const empty = await json(app, `/api/conversations/${q.convId}/questions/${q.id}`, { method: "POST", body: { answer: "  " } });
    assert.equal(empty.status, 400);
    const answered = await json(app, `/api/conversations/${q.convId}/questions/${q.id}`, { method: "POST", body: { answer: "Atender a Marina primeiro" } });
    assert.equal(answered.status, 200);
    await waitIdle(app, q.convId);
    const final = (await json(app, `/api/conversations/${q.convId}`)).body.conversation;
    const qm = final.messages.find((m) => m.id === q.id);
    assert.equal(qm.state, "answered");
    assert.equal(qm.answer, "Atender a Marina primeiro");
    assert.ok(final.messages.some((m) => m.role === "user" && /Atender a Marina primeiro/.test(m.text)));
    assert.equal((await json(app, `/api/conversations/${q.convId}/questions/${q.id}`, { method: "POST", body: { answer: "de novo" } })).status, 409);

    inbox = (await json(app, "/api/inbox")).body;
    assert.equal(inbox.count, 0);
    // negado não executa: nada foi apagado e o cartão não pode ser decidido de novo
    assert.equal((await json(app, `/api/conversations/${del.convId}/approvals/${del.id}`, { method: "POST", body: { decision: "approve" } })).status, 409);
  } finally {
    await app.close();
  }
});

test("buildInbox ignora cartões já decididos e mensagens comuns", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-inbox-unit-"));
  const store = createStore(dir);
  const conv = store.create("Nova conversa");
  store.update(conv.id, (c) => {
    c.messages.push(
      { id: "m1", role: "user", text: "oi", at: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "approval", kind: "enviar", summary: "x", state: "done", at: "2026-01-01T00:00:01Z" },
      { id: "a2", role: "approval", kind: "pagar", summary: "y", state: "pending", at: "2026-01-01T00:00:02Z" },
      { id: "q1", role: "question", question: "ok?", state: "dismissed", at: "2026-01-01T00:00:03Z" },
    );
  });
  const out = buildInbox(store);
  assert.equal(out.count, 1);
  assert.equal(out.items[0].id, "a2");
  assert.equal(out.items[0].origin, "conversa");
});
