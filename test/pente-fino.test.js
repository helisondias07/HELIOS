"use strict";

// Regressões da revisão "pente fino" (24/10/2026).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { startServer } = require("../server/index");
const { createStore } = require("../server/store");
const { createLivecoding } = require("../server/livecoding");
const { createActions } = require("../server/actions");
const { classifyTool } = require("../server/irreversible");
const { isLocalApiPath } = require("../server/util");
const voice = require("../renderer/voice");

async function boot(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-pf-"));
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

function rawRequest(app, method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(app.url);
    const req = http.request({ host: url.hostname, port: url.port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("conversa que estava ocupada quando o app fechou volta liberada e sem resposta 'running'", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-pf-store-"));
  fs.writeFileSync(path.join(dir, "conversations.json"), JSON.stringify({
    version: 2,
    items: [{
      id: "conv_x", title: "Travada", assistantId: "default", busy: true, createdAt: "2026-01-01", updatedAt: "2026-01-01",
      messages: [{ id: "m1", role: "user", text: "oi" }, { id: "m2", role: "assistant", status: "running", text: "" }],
    }],
  }));
  const store = createStore(dir);
  const conv = store.get("conv_x");
  assert.equal(conv.busy, false);
  assert.equal(conv.messages[1].status, "error");
  assert.match(conv.messages[1].text, /interrompida/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "conversations.json"), "utf8"));
  assert.equal(saved.items[0].busy, false);
});

test("aprovar duas vezes ao mesmo tempo executa a ação uma vez só, mesmo com ação lenta", async () => {
  let calls = 0;
  const app = await boot({
    onFillLogin: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { ok: true };
    },
  });
  try {
    const conv = (await json(app, "/api/conversations", { method: "POST", body: {} })).body.conversation;
    await json(app, `/api/conversations/${conv.id}/messages`, { method: "POST", body: { text: "preencher login GitHub" } });
    const done = await waitIdle(app, conv.id);
    const card = done.messages.find((m) => m.role === "approval" && m.state === "pending");
    assert.ok(card, "esperava um cartão pendente");
    const path1 = `/api/conversations/${conv.id}/approvals/${card.id}`;
    const results = await Promise.all([
      json(app, path1, { method: "POST", body: { decision: "approve" } }),
      json(app, path1, { method: "POST", body: { decision: "approve" } }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test("MCP: ferramentas que escrevem/enviam sem as palavras óbvias agora pedem aprovação", () => {
  assert.equal(classifyTool("create_issue"), "escrever");
  assert.equal(classifyTool("update_row"), "escrever");
  assert.equal(classifyTool("reply_to_thread"), "enviar");
  assert.equal(classifyTool("forwardMessage"), "enviar");
  assert.equal(classifyTool("mergePullRequest"), "publicar");
  assert.equal(classifyTool("cancel_event"), "apagar");
  assert.equal(classifyTool("buy_ticket"), "pagar");
  // leitura continua leitura
  for (const name of ["list_issues", "get_order", "search_messages", "read_inbox", "fetchPage", "echo"]) {
    assert.equal(classifyTool(name), "ler", name);
  }
});

test("sessão do livecoding salva como 'running' volta pausada e aceita o próximo passo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-pf-live-"));
  fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify([
    { id: "live_1", title: "t", folder: dir, steps: [{ titulo: "a" }], cursor: 0, status: "running" },
  ]));
  const live = createLivecoding({ rootDir: dir });
  assert.equal(live.get("live_1").status, "paused");
});

test("apagar aceita caminho relativo à pasta de projetos e continua barrando fora dela", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-pf-act-"));
  const projectsDir = path.join(dir, "projetos");
  fs.mkdirSync(path.join(projectsDir, "app"), { recursive: true });
  fs.writeFileSync(path.join(projectsDir, "app", "velho.txt"), "x");
  const outside = path.join(dir, "fora.txt");
  fs.writeFileSync(outside, "x");
  const actions = createActions({ dataDir: dir, projectsDir, mcp: null, onFillLogin: null, searchWeb: null });
  await actions.perform({ tipo: "apagar", alvo: path.join("app", "velho.txt") });
  assert.equal(fs.existsSync(path.join(projectsDir, "app", "velho.txt")), false);
  await assert.rejects(actions.perform({ tipo: "apagar", alvo: outside }));
  await assert.rejects(actions.perform({ tipo: "apagar", alvo: path.join("..", "fora.txt") }));
  assert.equal(fs.existsSync(outside), true);
});

test("API: sem token é sempre 401, corpo estranho e id malformado não viram 500", async () => {
  const app = await boot();
  try {
    const semToken = await rawRequest(app, "POST", "/api/conversations", { headers: { "content-type": "application/json" }, body: "{invalido" });
    assert.equal(semToken.status, 401);

    const auth = { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}` };
    const nulo = await rawRequest(app, "POST", "/api/conversations", { headers: auth, body: "null" });
    assert.equal(nulo.status, 201);
    const objeto = await json(app, "/api/conversations", { method: "POST", body: { title: { x: 1 } } });
    assert.equal(objeto.status, 201);
    assert.equal(objeto.body.conversation.title, "Nova conversa");

    const malformado = await rawRequest(app, "GET", "/api/conversations/%E0%A4%A", { headers: auth });
    assert.equal(malformado.status, 400);

    const conv = objeto.body.conversation;
    const numero = await json(app, `/api/conversations/${conv.id}/messages`, { method: "POST", body: { text: 123 } });
    assert.equal(numero.status, 400);
    const lista = await json(app, `/api/conversations/${conv.id}/messages`, { method: "POST", body: { text: { a: 1 } } });
    assert.equal(lista.status, 400);
  } finally {
    await app.close();
  }
});

test("IPC api: só caminhos /api/ do servidor local", () => {
  assert.equal(isLocalApiPath("/api/conversations"), true);
  assert.equal(isLocalApiPath("/api/memory?assistant=a%40b"), true);
  for (const bad of ["@evil.com/x", "//evil.com/api/x", "/api/../mcp", "/mcp", "http://evil.com/api/x", "/api/a b", "", null, 5]) {
    assert.equal(isLocalApiPath(bad), false, String(bad));
  }
});

test("voz: dois cliques rápidos no microfone abrem uma conversa só", async () => {
  let statusCalls = 0;
  const win = {
    speechSynthesis: { getVoices: () => [], addEventListener() {}, cancel() {}, speak() {} },
    SpeechSynthesisUtterance: class {},
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    addEventListener() {},
    navigator: {},
  };
  const ctl = voice.createController({
    window: win,
    banner() {},
    status: async () => {
      statusCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { hasGroqKey: false };
    },
  });
  await Promise.all([ctl.startConversation(), ctl.startConversation(), ctl.startConversation()]);
  assert.equal(statusCalls, 1);
  await ctl.startConversation();
  assert.equal(statusCalls, 2);
});