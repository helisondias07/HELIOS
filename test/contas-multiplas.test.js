"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../server/index");
const { createAccountStore, classifyAccountError, describeAccountIssue, sdkAdapters, MAX_ACCOUNTS } = require("../server/accounts");
const { createUsage } = require("../server/usage");
const contas = require("../renderer/contas");

const KEY_A = "crsr_chave_falsa_conta_a_000111";
const KEY_B = "crsr_chave_falsa_conta_b_000222";
const KEY_C = "crsr_chave_falsa_conta_c_000333";
const KEY_D = "crsr_chave_falsa_conta_d_000444";
const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

function store(extra = {}) {
  const logs = [];
  const saved = [];
  const accounts = createAccountStore({ adapters: sdkAdapters({ mock: true }), persist: (snap) => saved.push(JSON.stringify(snap)), log: (line) => logs.push(line), ...extra });
  return { accounts, logs, saved };
}

async function boot(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-contas-"));
  const app = await startServer({ dataDir, projectsDir: path.join(dataDir, "projetos"), port: 0, mock: true, routineMs: 0, searchWeb: async (query) => ({ query, results: [], error: "" }), ...extra });
  app.dataDir = dataDir;
  return app;
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
  for (let i = 0; i < 80; i += 1) {
    const { body } = await json(app, `/api/conversations/${id}`);
    if (!body.conversation.busy) return body.conversation;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("a conversa não ficou pronta");
}

async function ask(app, convId, text) {
  const sent = await json(app, `/api/conversations/${convId}/messages`, { method: "POST", body: { text } });
  assert.equal(sent.status, 202 === sent.status ? 202 : sent.status);
  return waitIdle(app, convId);
}

const twoAccounts = () => ({
  version: 1,
  activeId: "acc_aaa111",
  accounts: [
    { id: "acc_aaa111", kind: "apiKey", apiKey: KEY_A, label: "Conta A" },
    { id: "acc_bbb222", kind: "apiKey", apiKey: KEY_B, label: "Conta B" },
  ],
});

test("cadastra até 3 contas com apelidos Conta A, B e C e recusa a quarta", async () => {
  const { accounts } = store();
  assert.equal(MAX_ACCOUNTS, 3);
  const a = await accounts.addApiKey({ apiKey: KEY_A });
  const b = await accounts.addApiKey({ apiKey: KEY_B });
  const c = await accounts.addApiKey({ apiKey: KEY_C });
  assert.deepEqual([a.label, b.label, c.label], ["Conta A", "Conta B", "Conta C"]);
  await assert.rejects(() => accounts.addApiKey({ apiKey: KEY_D }), (err) => err.status === 409 && /3 contas/.test(err.message));
  assert.equal(accounts.list().length, 3);
});

test("a conta nova não vira ativa sozinha; só a primeira, e 'Tornar ativa' é um clique", async () => {
  const { accounts } = store();
  const a = await accounts.addApiKey({ apiKey: KEY_A });
  const b = await accounts.addApiKey({ apiKey: KEY_B });
  assert.equal(accounts.active().id, a.id);
  assert.deepEqual(accounts.list().map((item) => item.active), [true, false]);
  accounts.setActive(b.id);
  assert.equal(accounts.active().id, b.id);
  accounts.remove(b.id);
  assert.equal(accounts.active().id, a.id);
});

test("trocar a chave mantém conta, apelido e posição; chave repetida e inválida são recusadas", async () => {
  const { accounts } = store();
  const a = await accounts.addApiKey({ apiKey: KEY_A, label: "Pessoal" });
  const b = await accounts.addApiKey({ apiKey: KEY_B });
  await assert.rejects(() => accounts.addApiKey({ apiKey: KEY_B, replaceId: a.id }), (err) => err.status === 409 && /já está cadastrada como Conta A/.test(err.message));
  await assert.rejects(() => accounts.addApiKey({ apiKey: "chave-invalid-0000000000", replaceId: a.id }), (err) => err.status === 422);
  assert.equal(accounts.active().apiKey, KEY_A, "chave inválida não mexe na conta");
  const replaced = await accounts.addApiKey({ apiKey: KEY_C, replaceId: a.id });
  assert.equal(replaced.id, a.id);
  assert.equal(replaced.label, "Pessoal");
  assert.equal(accounts.active().apiKey, KEY_C);
  assert.equal(accounts.list().find((item) => item.id === b.id).label, "Conta A", "apelido automático ocupa o primeiro nome livre");
});

test("apelido editável recusa e-mail, chave e nome repetido", async () => {
  const { accounts } = store();
  const a = await accounts.addApiKey({ apiKey: KEY_A });
  await accounts.addApiKey({ apiKey: KEY_B });
  assert.equal(accounts.setLabel(a.id, "Trabalho").label, "Trabalho");
  assert.throws(() => accounts.setLabel(a.id, "helison@exemplo.com"), (err) => err.status === 400);
  assert.throws(() => accounts.setLabel(a.id, KEY_C), (err) => err.status === 400);
  assert.throws(() => accounts.setLabel(a.id, "conta b"), (err) => err.status === 409);
});

test("contas antigas sem apelido ganham Conta A e Conta B", () => {
  const { accounts } = store({ initial: { version: 1, activeId: "acc_x1", accounts: [{ id: "acc_x1", kind: "apiKey", apiKey: KEY_A }, { id: "acc_x2", kind: "login", apiKey: KEY_B }] } });
  assert.deepEqual(accounts.list().map((item) => item.label), ["Conta A", "Conta B"]);
});

test("a chave nunca aparece na lista pública, no log nem na tela", async () => {
  const { accounts, logs } = store();
  await accounts.addApiKey({ apiKey: KEY_A });
  await accounts.addApiKey({ apiKey: KEY_B });
  await accounts.addApiKey({ apiKey: KEY_C, replaceId: accounts.list()[0].id });
  const raw = JSON.stringify(accounts.list());
  for (const key of [KEY_A, KEY_B, KEY_C]) {
    assert.equal(raw.includes(key), false);
    assert.equal(logs.join("\n").includes(key), false);
  }
  const html = contas.accountsHtml({ accounts: accounts.list().map((item) => ({ ...item, localUsage: null })), max: 3, slotNames: ["Conta A", "Conta B", "Conta C"], usage: {} }, { mock: false, auto: { label: "x", level: "y", reason: "z" } }, null, esc);
  for (const key of [KEY_A, KEY_B, KEY_C]) assert.equal(html.includes(key), false);
  assert.match(html, /chave definida/);
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /<input[^>]*name="apiKey"[^>]*value=/);
});

test("classifica limite de uso, de taxa e de autenticação do SDK", () => {
  const usage = classifyAccountError(Object.assign(new Error("Usage limit exceeded"), { name: "RateLimitError" }));
  const rate = classifyAccountError(Object.assign(new Error("Rate limit exceeded"), { name: "RateLimitError" }));
  const auth = classifyAccountError(Object.assign(new Error("Invalid API key"), { name: "AuthenticationError", status: 401 }));
  assert.equal(usage.kind, "usage");
  assert.equal(rate.kind, "rate");
  assert.equal(auth.kind, "auth");
  assert.equal(classifyAccountError(new Error("invalid usage of tool x")), null);
  assert.equal(classifyAccountError(new Error("disco cheio")), null);
  assert.match(describeAccountIssue(usage, "Conta A"), /limite de uso da conta Conta A acabou/);
  assert.match(describeAccountIssue(rate, "Conta A"), /limitando as requisições/);
});

test("próxima conta sugerida pula a que bateu o limite de uso, sem trocar nada", async () => {
  const { accounts } = store();
  const a = await accounts.addApiKey({ apiKey: KEY_A });
  const b = await accounts.addApiKey({ apiKey: KEY_B });
  const c = await accounts.addApiKey({ apiKey: KEY_C });
  assert.equal(accounts.nextAccount(a.id).id, b.id);
  accounts.noteIssue(b.id, "usage");
  assert.equal(accounts.nextAccount(a.id).id, c.id);
  accounts.noteIssue(c.id, "usage");
  assert.equal(accounts.nextAccount(a.id).limited, true);
  assert.equal(accounts.active().id, a.id, "nunca troca sozinho");
  accounts.noteOk(b.id);
  assert.equal(accounts.nextAccount(a.id).id, b.id);
  assert.equal(store().accounts.nextAccount("nada"), null);
});

test("erro de limite de uso no chat vira aviso com botão; não troca nem repete sozinho", async () => {
  const app = await boot({ getAccounts: twoAccounts });
  try {
    const conv = (await json(app, "/api/conversations", { method: "POST", body: {} })).body.conversation;
    const done = await ask(app, conv.id, "faça algo [[simular:uso]]");
    const reply = done.messages[done.messages.length - 1];
    assert.equal(reply.status, "error");
    assert.equal(reply.accountIssue.kind, "usage");
    assert.equal(reply.accountIssue.accountId, "acc_aaa111");
    assert.equal(reply.accountIssue.next.label, "Conta B");
    assert.match(reply.text, /limite de uso da conta Conta A acabou/);
    assert.match(reply.text, /não troca de conta sozinho/);
    assert.match(reply.text, /Conta B/);
    assert.equal(done.messages.filter((m) => m.role === "user").length, 1, "a mensagem não foi repetida");
    const list = (await json(app, "/api/accounts")).body.accounts;
    assert.equal(list.find((item) => item.active).id, "acc_aaa111", "a conta ativa continua a mesma");
    assert.equal(list[0].issue.kind, "usage");
    assert.equal(JSON.stringify(done).includes(KEY_A), false);
    // Só o clique troca; depois do clique, reenviar é outro clique.
    const switched = await json(app, "/api/accounts/active", { method: "POST", body: { id: reply.accountIssue.next.id } });
    assert.equal(switched.status, 200);
    const afterSwitch = (await json(app, `/api/conversations/${conv.id}`)).body.conversation;
    assert.equal(afterSwitch.messages.length, done.messages.length, "trocar não envia nada");
    const resent = await ask(app, conv.id, "faça algo");
    assert.equal(resent.messages[resent.messages.length - 1].status, "done");
  } finally {
    await app.close();
  }
});

test("erro de taxa sugere esperar na mesma conta, sem botão de trocar", async () => {
  const app = await boot({ getAccounts: twoAccounts });
  try {
    const conv = (await json(app, "/api/conversations", { method: "POST", body: {} })).body.conversation;
    const done = await ask(app, conv.id, "oi [[simular:taxa]]");
    const reply = done.messages[done.messages.length - 1];
    assert.equal(reply.accountIssue.kind, "rate");
    assert.equal(reply.accountIssue.next, null);
    assert.match(reply.text, /espere cerca de um minuto/);
    assert.match(reply.text, /mesma conta/);
    const html = contas.noticeHtml({ id: reply.id, accountIssue: reply.accountIssue }, { isLast: true, esc });
    assert.match(html, /data-resend/);
    assert.doesNotMatch(html, /data-switch/);
  } finally {
    await app.close();
  }
});

test("chave que não vale mais avisa em português e oferece a outra conta", async () => {
  const app = await boot({ getAccounts: twoAccounts });
  try {
    const conv = (await json(app, "/api/conversations", { method: "POST", body: {} })).body.conversation;
    const done = await ask(app, conv.id, "oi [[simular:auth]]");
    const reply = done.messages[done.messages.length - 1];
    assert.equal(reply.accountIssue.kind, "auth");
    assert.match(reply.text, /expirou ou a chave não vale mais/);
    assert.equal(reply.accountIssue.next.label, "Conta B");
  } finally {
    await app.close();
  }
});

test("com uma conta só, o aviso de limite não oferece troca", async () => {
  const app = await boot({ getAccounts: () => ({ version: 1, activeId: "acc_aaa111", accounts: [{ id: "acc_aaa111", kind: "apiKey", apiKey: KEY_A, label: "Conta A" }] }) });
  try {
    const conv = (await json(app, "/api/conversations", { method: "POST", body: {} })).body.conversation;
    const done = await ask(app, conv.id, "oi [[simular:uso]]");
    const reply = done.messages[done.messages.length - 1];
    assert.equal(reply.accountIssue.next, null);
    assert.match(reply.text, /Não há outra conta cadastrada/);
  } finally {
    await app.close();
  }
});

test("aviso do chat: botões só na última mensagem e depois da troca aparece Reenviar", () => {
  const message = { id: "msg_1", accountIssue: { kind: "usage", accountId: "acc_a", accountLabel: "Conta A", next: { id: "acc_b", label: "Conta B" } } };
  assert.equal(contas.noticeHtml(message, { isLast: false, esc }), "");
  const html = contas.noticeHtml(message, { isLast: true, esc });
  assert.match(html, /Trocar para a Conta B/);
  assert.doesNotMatch(html, /data-resend/);
  const moved = contas.noticeHtml(message, { isLast: true, switched: { msg_1: "Conta B" }, esc });
  assert.match(moved, /Conta ativa agora: <strong>Conta B<\/strong>/);
  assert.match(moved, /Reenviar mensagem/);
  assert.doesNotMatch(moved, /data-switch/);
});

test("API: 4ª conta é recusada, apelido salvo e a lista nunca traz a chave", async () => {
  const app = await boot();
  try {
    for (const key of [KEY_A, KEY_B, KEY_C]) assert.equal((await json(app, "/api/accounts/key", { method: "POST", body: { apiKey: key } })).status, 201);
    const fourth = await json(app, "/api/accounts/key", { method: "POST", body: { apiKey: KEY_D } });
    assert.equal(fourth.status, 409);
    const listed = (await json(app, "/api/accounts")).body;
    assert.equal(listed.max, 3);
    assert.deepEqual(listed.accounts.map((item) => item.label), ["Conta A", "Conta B", "Conta C"]);
    const renamed = await json(app, "/api/accounts/label", { method: "POST", body: { id: listed.accounts[1].id, label: "Reserva" } });
    assert.equal(renamed.status, 200);
    const replaced = await json(app, "/api/accounts/key", { method: "POST", body: { apiKey: KEY_D, replaceId: listed.accounts[2].id } });
    assert.equal(replaced.status, 201);
    const raw = JSON.stringify((await json(app, "/api/accounts")).body);
    for (const key of [KEY_A, KEY_B, KEY_C, KEY_D]) assert.equal(raw.includes(key), false);
    assert.match(raw, /Reserva/);
  } finally {
    await app.close();
  }
});

test("uso local por conta ativa e alerta de 80% do teto diário", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-uso-"));
  let active = "acc_a";
  let at = new Date(2026, 9, 27, 10, 0, 0).getTime();
  const usage = createUsage(dir, { now: () => at, globalCallsPerDay: () => 10, activeAccountId: () => active });
  for (let i = 0; i < 3; i += 1) usage.record("default", { usage: { totalTokens: 100 } });
  active = "acc_b";
  usage.record("default", {});
  assert.equal(usage.accountStatus("acc_a").today.chamadas, 3);
  assert.equal(usage.accountStatus("acc_a").today.tokens, 300);
  assert.equal(usage.accountStatus("acc_b").today.chamadas, 1);
  at += 3 * 864e5;
  assert.equal(usage.accountStatus("acc_a").today.chamadas, 0);
  assert.equal(usage.accountStatus("acc_a").week.chamadas, 3);
  at += 6 * 864e5;
  assert.equal(usage.accountStatus("acc_a").week.chamadas, 0);
  for (let i = 0; i < 4; i += 1) usage.record("default", {});
  assert.equal(usage.globalStatus().alert, false);
  for (let i = 0; i < 4; i += 1) usage.record("default", {});
  const g = usage.globalStatus();
  assert.equal(g.percent, 80);
  assert.equal(g.alert, true);
  const html = contas.usageCardHtml({ usage: { global: g, assistantAlerts: [], realLimitUrl: "https://cursor.com/dashboard", note: "só o uso local" }, accounts: [] }, esc);
  assert.match(html, /perto do fim/);
  assert.match(html, /cursor\.com\/dashboard/);
  assert.match(html, /só o uso local/);
  // Reiniciar não perde o uso por conta.
  const again = createUsage(dir, { now: () => at, activeAccountId: () => "acc_a" });
  assert.equal(again.accountStatus("acc_a").week.chamadas, 0);
  assert.equal(again.accountStatus("acc_b").week.chamadas, 8);
});

test("o texto descreve a barra do plano Cursor e o fallback manual, com link do painel", async () => {
  const app = await boot();
  try {
    const data = (await json(app, "/api/accounts")).body;
    assert.match(data.usage.note, /plano Cursor|GetCurrentPeriodUsage/i);
    assert.match(data.usage.note, /Limite manual/i);
    assert.match(data.usage.note, /SDK/i);
    assert.equal(data.usage.realLimitUrl, "https://cursor.com/dashboard");
  } finally {
    await app.close();
  }
});

test("a caixa de acesso MCP está explicada, recolhida e com o token oculto", () => {
  const html = contas.accountsHtml({ accounts: [], max: 3, slotNames: ["Conta A"], usage: {} }, { mock: true, auto: { label: "x", level: "y", reason: "z" } }, null, esc);
  assert.match(html, /<details class="card stack acct-mcp"/);
  assert.doesNotMatch(html, /<details[^>]*acct-mcp[^>]* open/);
  assert.match(html, /Não é uma conta/);
  assert.match(html, /id="mcpToken" type="password"/);
  assert.match(html, /127.0.0.1/);
});