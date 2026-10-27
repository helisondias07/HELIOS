"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Captura o prompt que chega ao agente. Precisa vir antes de carregar o servidor.
const mockAgent = require("../server/mock-agent");
const prompts = [];
const realCreate = mockAgent.createMockAgent;
mockAgent.createMockAgent = (opts) => {
  const agent = realCreate(opts);
  const realSend = agent.send;
  agent.send = (message, extra) => {
    prompts.push(typeof message === "string" ? message : message?.text || "");
    return realSend.call(agent, message, extra);
  };
  return agent;
};

const { startServer } = require("../server/index");
const { createAssistants, TEMPLATES } = require("../server/assistants");
const { assistantPrompt, buildPrompt } = require("../server/agent-prompt");
const { createStore } = require("../server/store");
const { createRoutines, dispatchDue } = require("../server/routines");

const TOKEN = "token-de-teste-assistentes";

function fakeConnect() {
  const calls = [];
  const connect = async (name) => ({
    tools: [{ name: "read_inbox", description: "Lê." }],
    call: async (tool) => {
      calls.push({ server: name, tool });
      return { content: [{ type: "text", text: `ok:${name}.${tool}` }] };
    },
    close() {},
  });
  connect.calls = calls;
  return connect;
}

async function boot(extra = {}) {
  const dataDir = extra.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "helios-ast-"));
  const connect = fakeConnect();
  const app = await startServer({
    dataDir,
    projectsDir: path.join(dataDir, "projetos"),
    port: 0,
    mock: true,
    routineMs: 0,
    connect,
    getMcpToken: () => TOKEN,
    getVaultIndex: () => [],
    ...extra,
  });
  app.connect = connect;
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

async function chat(app, text, convId) {
  const id = convId || (await json(app, "/api/conversations", { method: "POST", body: {} })).body.conversation.id;
  await json(app, `/api/conversations/${id}/messages`, { method: "POST", body: { text } });
  for (let i = 0; i < 80; i += 1) {
    const { body } = await json(app, `/api/conversations/${id}`);
    if (!body.conversation.busy) return body.conversation;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("a conversa não ficou pronta");
}

async function newAssistant(app, body) {
  const res = await json(app, "/api/assistants", { method: "POST", body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.assistant;
}

async function convFor(app, assistantId) {
  const res = await json(app, "/api/conversations", { method: "POST", body: { assistantId } });
  assert.equal(res.status, 201);
  return res.body.conversation.id;
}

const pendingOf = (conv) => conv.messages.filter((m) => m.role === "approval" && m.state === "pending");

test("migração: dados antigos (sem assistente) continuam intactos e viram do assistente padrão", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-ast-mig-"));
  const legacy = {
    version: 1,
    items: [{
      id: "conv_antiga",
      title: "Conversa de antes",
      messages: [
        { id: "m1", role: "user", text: "oi", at: "2026-01-01T10:00:00.000Z", status: "done" },
        { id: "a1", role: "assistant", text: "Olá, Helison.", at: "2026-01-01T10:00:01.000Z", status: "done" },
        { id: "p1", role: "approval", kind: "enviar", summary: "Enviar o resumo", detail: "", action: { tipo: "enviar", resumo: "Enviar o resumo" }, state: "pending", at: "2026-01-01T10:00:02.000Z" },
      ],
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T10:00:02.000Z",
      busy: false,
      agentId: null,
      agentModel: null,
    }],
  };
  const original = JSON.stringify(legacy, null, 2) + "\n";
  fs.writeFileSync(path.join(dataDir, "conversations.json"), original);
  fs.writeFileSync(path.join(dataDir, "memory.json"), JSON.stringify({ version: 1, items: [{ id: "mem_old", kind: "fato", text: "O Helison prefere respostas curtas.", source: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] }));

  let app = await boot({ dataDir });
  try {
    const convs = (await json(app, "/api/conversations")).body.conversations;
    assert.equal(convs.length, 1);
    assert.equal(convs[0].assistantId, "default");
    assert.equal(convs[0].messages.length, 3);
    assert.equal(convs[0].messages[1].text, "Olá, Helison.");
    assert.equal(fs.readFileSync(path.join(dataDir, "conversations.pre-assistentes.json"), "utf8"), original, "cópia do arquivo antigo");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "conversations.json"), "utf8")).version, 2);
    const mem = (await json(app, "/api/memory")).body.items;
    assert.equal(mem.length, 1);
    assert.match(mem[0].text, /respostas curtas/);
    const list = (await json(app, "/api/assistants")).body;
    assert.equal(list.assistants[0].id, "default");
    assert.equal(list.assistants[0].builtin, true);
    const inbox = (await json(app, "/api/inbox")).body;
    assert.equal(inbox.items[0].assistantName, "HELIOS");
    const approved = await json(app, "/api/conversations/conv_antiga/approvals/p1", { method: "POST", body: { decision: "approve" } });
    assert.equal(approved.status, 200);
    const after = await chat(app, "oi de novo", "conv_antiga");
    assert.equal(after.messages.length >= 5, true);
  } finally {
    await app.close();
  }
  // segunda abertura: não refaz a migração nem sobrescreve a cópia
  fs.writeFileSync(path.join(dataDir, "conversations.pre-assistentes.json"), "marca");
  app = await boot({ dataDir });
  try {
    assert.equal(fs.readFileSync(path.join(dataDir, "conversations.pre-assistentes.json"), "utf8"), "marca");
    assert.equal((await json(app, "/api/conversations")).body.conversations[0].assistantId, "default");
  } finally {
    await app.close();
  }
});

test("seis modelos prontos, criação, validação e assistente padrão protegido", async () => {
  assert.deepEqual(TEMPLATES.map((t) => t.name), ["Caixa de entrada", "Estudos", "Código", "Pesquisa", "Finanças da casa", "Agenda"]);
  const app = await boot();
  try {
    const listed = (await json(app, "/api/assistants")).body;
    assert.equal(listed.templates.length, 6);
    assert.equal(listed.assistants.length, 1);

    const fin = await newAssistant(app, { template: "financas-da-casa" });
    assert.equal(fin.name, "Finanças da casa");
    assert.match(fin.instructions, /R\$/);
    assert.equal(fin.mcp, null);
    const custom = await newAssistant(app, { template: "estudos", name: "Estudos de inglês", instructions: "Só inglês.", mcp: ["caixa"] });
    assert.equal(custom.instructions, "Só inglês.");
    assert.deepEqual(custom.mcp, ["caixa"]);

    assert.equal((await json(app, "/api/assistants", { method: "POST", body: { template: "financas-da-casa" } })).status, 409, "nome repetido");
    assert.equal((await json(app, "/api/assistants", { method: "POST", body: { template: "nao-existe" } })).status, 400);
    assert.equal((await json(app, "/api/assistants", { method: "POST", body: { name: "x" } })).status, 400);
    assert.equal((await json(app, "/api/assistants", { method: "POST", body: { name: "Ladrão", autonomy: { pagar: "sozinho" } } })).status, 400);
    assert.equal((await json(app, "/api/assistants", { method: "POST", body: { name: "Ladrão", autonomy: { preencher: "sozinho" } } })).status, 400);

    const edited = await json(app, `/api/assistants/${fin.id}`, { method: "POST", body: { role: "Contas", autonomy: { enviar: "pedir" } } });
    assert.equal(edited.body.assistant.role, "Contas");
    assert.equal(edited.body.assistant.name, "Finanças da casa", "o que não veio no pedido não muda");
    assert.equal((await json(app, "/api/assistants/default", { method: "POST", body: { name: "Outro" } })).status, 400);
    assert.equal((await json(app, "/api/assistants/default", { method: "DELETE" })).status, 400);
    assert.equal((await json(app, "/api/assistants/ast_inexistente", { method: "POST", body: { name: "Outro" } })).status, 404);
    assert.equal((await json(app, "/api/conversations", { method: "POST", body: { assistantId: "ast_inexistente" } })).status, 404);
  } finally {
    await app.close();
  }
});

test("cada conversa pertence a um assistente e remover o assistente devolve as conversas ao padrão", async () => {
  const app = await boot();
  try {
    const a = await newAssistant(app, { template: "agenda" });
    const idA = await convFor(app, a.id);
    const idDefault = await convFor(app, undefined);
    const list = (await json(app, "/api/conversations")).body.conversations;
    assert.equal(list.find((c) => c.id === idA).assistantId, a.id);
    assert.equal(list.find((c) => c.id === idDefault).assistantId, "default");
    await chat(app, "lembra que a reunião de sexta é às 15h", idA);
    assert.equal(fs.existsSync(path.join(app.dataDir, `memory-${a.id}.json`)), true);

    const removed = await json(app, `/api/assistants/${a.id}`, { method: "DELETE" });
    assert.equal(removed.body.conversasMovidas, 1);
    const after = (await json(app, `/api/conversations/${idA}`)).body.conversation;
    assert.equal(after.assistantId, "default");
    assert.ok(after.messages.length >= 2, "histórico preservado");
    assert.equal(fs.existsSync(path.join(app.dataDir, `memory-${a.id}.json`)), false, "memória do assistente removido foi apagada");
    assert.equal(fs.existsSync(path.join(app.dataDir, "memory.json")), false, "a memória do padrão não foi tocada nem criada");
  } finally {
    await app.close();
  }
});

test("a memória é isolada por assistente", async () => {
  const app = await boot();
  try {
    const a = await newAssistant(app, { template: "estudos" });
    const b = await newAssistant(app, { template: "codigo" });
    await json(app, "/api/memory", { method: "POST", body: { text: "O Helison estuda React toda terça.", kind: "fato", assistantId: a.id } });
    await json(app, "/api/memory", { method: "POST", body: { text: "O repositório principal usa pnpm.", kind: "fato", assistantId: b.id } });
    await json(app, "/api/memory", { method: "POST", body: { text: "O Helison mora em São Paulo.", kind: "fato" } });
    const texts = async (query) => (await json(app, `/api/memory${query}`)).body.items.map((i) => i.text).join("|");
    assert.match(await texts(`?assistant=${a.id}`), /React/);
    assert.doesNotMatch(await texts(`?assistant=${a.id}`), /pnpm|São Paulo/);
    assert.match(await texts(`?assistant=${b.id}`), /pnpm/);
    assert.doesNotMatch(await texts(`?assistant=${b.id}`), /React|São Paulo/);
    assert.match(await texts(""), /São Paulo/);
    assert.doesNotMatch(await texts(""), /React|pnpm/);

    // o agente grava na memória do assistente da conversa
    await chat(app, "lembra que o Helison prefere café sem açúcar", await convFor(app, a.id));
    assert.match(await texts(`?assistant=${a.id}`), /café/);
    assert.doesNotMatch(await texts(""), /café/);
    assert.doesNotMatch(await texts(`?assistant=${b.id}`), /café/);
    assert.equal((await json(app, "/api/memory?assistant=ast_nao_existe")).status, 404);

    // e o MCP local consulta por assistente
    const rpc = async (name, args) => {
      const res = await fetch(`${app.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      return JSON.parse((await res.json()).result.content[0].text);
    };
    assert.match((await rpc("helios_consultar_memoria", { consulta: "React estuda", assistente: "Estudos" })).texto, /React/);
    assert.doesNotMatch((await rpc("helios_consultar_memoria", { consulta: "React estuda" })).texto, /React/);
  } finally {
    await app.close();
  }
});

test("o prompt é isolado por assistente: só o perfil e a memória do dono da conversa entram", async () => {
  const app = await boot();
  try {
    const a = await newAssistant(app, { name: "Alfa", role: "Função alfa", instructions: "INSTRUCAO-ALFA", mcp: ["caixa"] });
    const b = await newAssistant(app, { name: "Beta", role: "Função beta", instructions: "INSTRUCAO-BETA" });
    await json(app, "/api/memory", { method: "POST", body: { text: "Fato exclusivo do alfa sobre jardinagem.", assistantId: a.id } });
    await json(app, "/api/memory", { method: "POST", body: { text: "Fato exclusivo do padrão sobre jardinagem.", assistantId: undefined } });

    prompts.length = 0;
    await chat(app, "oi, fale de jardinagem", await convFor(app, a.id));
    const alfa = prompts.at(-1);
    assert.match(alfa, /Assistente atual: Alfa/);
    assert.match(alfa, /INSTRUCAO-ALFA/);
    assert.match(alfa, /Fato exclusivo do alfa/);
    assert.match(alfa, /caixa/);
    assert.doesNotMatch(alfa, /INSTRUCAO-BETA|Beta|exclusivo do padrão/);

    await chat(app, "oi, fale de jardinagem", await convFor(app, b.id));
    const beta = prompts.at(-1);
    assert.match(beta, /INSTRUCAO-BETA/);
    assert.doesNotMatch(beta, /INSTRUCAO-ALFA|Fato exclusivo/);

    await chat(app, "oi, fale de jardinagem", await convFor(app, undefined));
    const padrao = prompts.at(-1);
    assert.doesNotMatch(padrao, /Assistente atual|INSTRUCAO/);
    assert.match(padrao, /exclusivo do padrão/);
    assert.doesNotMatch(padrao, /exclusivo do alfa/);
  } finally {
    await app.close();
  }
});

test("o prompt do assistente padrão fica igual ao de antes", () => {
  const base = { text: "oi", level: "rapido", history: "Helison: a", memoryText: "mem", vaultText: "cofre" };
  assert.equal(buildPrompt({ ...base, assistantText: assistantPrompt({ builtin: true }) }), buildPrompt(base));
  assert.equal(assistantPrompt(null), "");
  const text = assistantPrompt({ name: "X", role: "R", instructions: "I", mcp: [] });
  assert.match(text, /nenhum conector/);
});

test("conectores MCP permitidos por assistente", async () => {
  const app = await boot();
  try {
    for (const name of ["caixa", "outro"]) {
      const added = await json(app, "/api/mcp", { method: "POST", body: { name, type: "http", url: "http://127.0.0.1:9/mcp" } });
      await json(app, `/api/mcp/${added.body.server.id}/test`, { method: "POST", body: {} });
    }
    const some = await newAssistant(app, { name: "Só caixa", mcp: ["caixa"] });
    const none = await newAssistant(app, { name: "Sem conectores", mcp: [] });

    await chat(app, "mcp caixa.read_inbox", await convFor(app, some.id));
    assert.deepEqual(app.connect.calls.map((c) => c.server), ["caixa"]);
    const blocked = await chat(app, "mcp outro.read_inbox", await convFor(app, some.id));
    assert.equal(app.connect.calls.length, 1, "conector fora da lista não é chamado");
    assert.equal(blocked.messages.some((m) => m.role === "approval"), false);
    await chat(app, "mcp caixa.read_inbox", await convFor(app, none.id));
    assert.equal(app.connect.calls.length, 1);
    await chat(app, "mcp outro.read_inbox", await convFor(app, undefined));
    assert.deepEqual(app.connect.calls.map((c) => c.server), ["caixa", "outro"], "o padrão usa todos");
  } finally {
    await app.close();
  }
});

test("autonomia própria do assistente vale só nas conversas dele e não destrava pagar nem preencher", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-ast-aut-"));
  const app = await boot({ dataDir, getVaultIndex: () => [{ id: "login_1", tipo: "login", nome: "GitHub" }], onFillLogin: async () => ({ ok: true }) });
  try {
    const trusted = await newAssistant(app, { name: "Confiável", autonomy: { enviar: "sozinho" } });
    const sent = await chat(app, "enviar o resumo para o time", await convFor(app, trusted.id));
    assert.equal(pendingOf(sent).length, 0);
    assert.equal(sent.messages.find((m) => m.auto).state, "done");
    const other = await chat(app, "enviar o resumo para o time", await convFor(app, undefined));
    assert.equal(pendingOf(other).length, 1, "o padrão continua pedindo");
    assert.equal(pendingOf(await chat(app, "pagar a conta de luz", await convFor(app, trusted.id))).length, 1);
  } finally {
    await app.close();
  }
  // arquivo de assistentes adulterado
  fs.writeFileSync(path.join(dataDir, "assistants.json"), JSON.stringify({ version: 1, items: [{ id: "ast_hack1234", name: "Hack", role: "", instructions: "", mcp: null, autonomy: { pagar: "sozinho", preencher: "sozinho" } }] }));
  const again = await boot({ dataDir, getVaultIndex: () => [{ id: "login_1", tipo: "login", nome: "GitHub" }], onFillLogin: async () => ({ ok: true }) });
  try {
    assert.equal(pendingOf(await chat(again, "pagar a conta de luz", await convFor(again, "ast_hack1234"))).length, 1);
    assert.equal(pendingOf(await chat(again, "preencher login GitHub", await convFor(again, "ast_hack1234"))).length, 1);
  } finally {
    await again.close();
  }
});

test("o MCP local manda a mensagem para o assistente pedido", async () => {
  const app = await boot();
  try {
    const a = await newAssistant(app, { template: "pesquisa" });
    const res = await fetch(`${app.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "helios_enviar_mensagem", arguments: { texto: "oi", assistente: "Pesquisa" } } }) });
    const out = JSON.parse(JSON.parse(await res.text()).result.content[0].text);
    const conv = (await json(app, `/api/conversations/${out.conversa}`)).body.conversation;
    assert.equal(conv.assistantId, a.id);
    const missing = await fetch(`${app.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "helios_enviar_mensagem", arguments: { texto: "oi", assistente: "Fantasma" } } }) }).then((r) => r.json());
    assert.equal(missing.result.isError, true);
  } finally {
    await app.close();
  }
});

test("rotina de um assistente abre a conversa dele", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-ast-rot-"));
  const assistants = createAssistants(dir);
  const ast = assistants.create({ template: "agenda" });
  const store = createStore(dir);
  const routines = createRoutines(dir);
  const item = routines.add({ title: "Bom dia", prompt: "resuma a agenda de hoje", everyMinutes: 1, assistantId: ast.id });
  assert.equal(item.assistantId, ast.id);
  const ran = dispatchDue({ routines, store, send() {}, at: Date.now() + 5 * 60 * 1000 });
  assert.equal(ran.ran.length, 1);
  assert.equal(store.list().find((c) => c.title === "Rotina: Bom dia").assistantId, ast.id);
});
