"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../server/index");

async function boot(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-srv-"));
  const projectsDir = path.join(dataDir, "projetos");
  const fills = [];
  const app = await startServer({
    dataDir,
    projectsDir,
    port: 0,
    mock: true,
    routineMs: 0,
    openEditor: () => ({ ok: true, cmd: "code" }),
    searchWeb: async (query) => ({ query, results: [{ title: "Fonte", url: "https://exemplo.com", snippet: "trecho" }], error: "" }),
    getVaultIndex: () => [{ id: "login_1", tipo: "login", nome: "GitHub", usuario: "helison", senha: "super-secreta" }],
    onFillLogin: async (request) => {
      fills.push(request);
      return { ok: true, senha: "super-secreta" };
    },
    ...extra,
  });
  app.fills = fills;
  return app;
}

async function json(app, pathname, opts = {}) {
  const res = await fetch(`${app.url}${pathname}`, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}`, ...(opts.headers || {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function waitIdle(app, id) {
  for (let i = 0; i < 40; i += 1) {
    const { body } = await json(app, `/api/conversations/${id}`);
    if (!body.conversation.busy) return body.conversation;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("a conversa não ficou pronta");
}

test("a API local recusa pedido sem token", async () => {
  const app = await boot();
  try {
    const bare = await fetch(`${app.url}/api/health`);
    assert.equal(bare.status, 401);
    const approve = await fetch(`${app.url}/api/conversations/x/approvals/y`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal(approve.status, 401);
    const health = await json(app, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.name, "HELIOS");
    assert.equal(JSON.stringify(health.body).includes(app.apiToken()), false);
  } finally {
    await app.close();
  }
});

test("servidor local conversa, aprova e não vaza senha", async () => {
  const app = await boot();
  try {
    const health = await json(app, "/api/health");
    assert.equal(health.body.name, "HELIOS");
    const created = await json(app, "/api/conversations", { method: "POST", body: {} });
    const id = created.body.conversation.id;
    await json(app, `/api/conversations/${id}/messages`, { method: "POST", body: { text: "preencher login GitHub" } });
    let conv = await waitIdle(app, id);
    const fillCard = conv.messages.find((message) => message.role === "approval" && message.kind === "preencher" && message.state === "pending");
    assert.ok(fillCard, "cartão de preencher login");
    assert.equal(app.fills.length, 0);
    const dumped = JSON.stringify(conv);
    assert.equal(dumped.includes("super-secreta"), false);
    assert.match(dumped, /senha não passa|Preencher o login/);
    const disk = fs.readFileSync(path.join(app.dataDir, "conversations.json"), "utf8");
    assert.equal(disk.includes("super-secreta"), false);
    const filled = await json(app, `/api/conversations/${id}/approvals/${fillCard.id}`, { method: "POST", body: { decision: "approve" } });
    const fillAfter = filled.body.conversation.messages.find((message) => message.id === fillCard.id);
    assert.equal(fillAfter.state, "done");
    assert.match(fillAfter.result, /Preenchi o login/);
    assert.equal(fillAfter.result.includes("super-secreta"), false);
    assert.equal(app.fills.length, 1);
    assert.equal(app.fills[0].nome, "GitHub");

    await json(app, `/api/conversations/${id}/messages`, { method: "POST", body: { text: "enviar o resumo para o time" } });
    conv = await waitIdle(app, id);
    const card = conv.messages.find((message) => message.role === "approval" && message.kind === "enviar" && message.state === "pending");
    assert.ok(card, "cartão de aprovação pendente");
    const decided = await json(app, `/api/conversations/${id}/approvals/${card.id}`, { method: "POST", body: { decision: "approve" } });
    const after = decided.body.conversation.messages.find((message) => message.id === card.id);
    assert.equal(after.state, "done");
    assert.match(after.result, /Aprovado/);
    assert.equal(JSON.stringify(decided.body).includes("super-secreta"), false);
  } finally {
    await app.close();
  }
});

test("conta do Cursor não devolve a chave inteira", async () => {
  const app = await boot();
  try {
    const added = await json(app, "/api/accounts/key", { method: "POST", body: { apiKey: "crsr_demo_chave_valida_9876", label: "Trabalho" } });
    assert.equal(added.status, 201);
    const listed = await json(app, "/api/accounts");
    const raw = JSON.stringify(listed.body);
    assert.equal(raw.includes("crsr_demo_chave_valida_9876"), false);
    assert.match(raw, /9876/);
    const models = await json(app, `/api/models?text=${encodeURIComponent("oi")}`);
    assert.equal(models.body.auto.level, "rapido");
  } finally {
    await app.close();
  }
});

test("livecoding pela API executa um passo de cada vez", async () => {
  const app = await boot();
  try {
    const started = await json(app, "/api/livecoding", { method: "POST", body: { description: "página para o estagiário" } });
    const session = started.body.session;
    assert.equal(fs.existsSync(path.join(session.folder, "index.html")), false);
    const next = await json(app, `/api/livecoding/${session.id}/next`, { method: "POST", body: {} });
    assert.equal(next.body.session.status, "paused");
    assert.equal(fs.existsSync(path.join(session.folder, "index.html")), true);
    assert.match(fs.readFileSync(path.join(session.folder, "index.html"), "utf8"), /estagiário|livecoding|página/i);
  } finally {
    await app.close();
  }
});

test("conector MCP testa status real", async () => {
  const app = await boot();
  try {
    const added = await json(app, "/api/mcp", {
      method: "POST",
      body: { name: "eco", type: "stdio", command: process.execPath, args: [path.join(__dirname, "fixtures", "mcp-stdio.js")] },
    });
    assert.equal(added.body.server.confirmed, false);
    const blocked = await json(app, `/api/mcp/${added.body.server.id}/test`, { method: "POST", body: {} });
    assert.equal(blocked.status, 409);
    const confirmed = await json(app, `/api/mcp/${added.body.server.id}/confirm`, { method: "POST", body: {} });
    assert.equal(confirmed.body.server.confirmed, true);
    const tested = await json(app, `/api/mcp/${added.body.server.id}/test`, { method: "POST", body: {} });
    assert.equal(tested.body.server.status, "online");
    assert.equal(tested.body.server.toolCount, 1);
    const missing = await json(app, "/api/mcp", {
      method: "POST",
      body: { name: "ausente", type: "stdio", command: process.execPath, args: ["arquivo-que-nao-existe.js"] },
    });
    await json(app, `/api/mcp/${missing.body.server.id}/confirm`, { method: "POST", body: {} });
    const down = await json(app, `/api/mcp/${missing.body.server.id}/test`, { method: "POST", body: {} });
    assert.equal(down.body.server.status, "offline");
    assert.ok(down.body.server.error);
  } finally {
    await app.close();
  }
});
