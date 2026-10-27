"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../server/index");
const { isLoopbackAddress } = require("../server/mcp-server");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TOKEN = "token-de-teste-helios-local";
const SENTINELA = "super-secreta-do-cofre";

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-mcp-"));
  const app = await startServer({
    dataDir,
    projectsDir: path.join(dataDir, "projetos"),
    port: 0,
    mock: true,
    routineMs: 0,
    openEditor: () => ({ ok: true, cmd: "code" }),
    getMcpToken: () => TOKEN,
    getVaultIndex: () => [{ id: "login_1", tipo: "login", nome: "GitHub", usuario: "helison", senha: SENTINELA }],
  });
  return app;
}

async function rpc(app, body, { token = TOKEN } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${app.url}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return {
    status: res.status,
    text,
    body: text ? JSON.parse(text) : null,
    session: res.headers.get("mcp-session-id"),
  };
}

async function call(app, name, args) {
  const out = await rpc(app, { jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args || {} } });
  assert.equal(out.body.error, undefined);
  return out.body.result;
}

test("o MCP só aceita loopback", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("0.0.0.0"), false);
  assert.equal(isLoopbackAddress("192.168.0.8"), false);
});

test("o MCP exige token, não lê o cofre e deixa ação irreversível pendente", async () => {
  const app = await boot();
  try {
    assert.equal(app.host, "127.0.0.1");
    assert.match(app.url, /^http:\/\/127\.0\.0\.1:/);
    const health = await fetch(`${app.url}/api/health`).then((res) => res.json());
    assert.equal(JSON.stringify(health).includes(TOKEN), false);
    assert.equal(JSON.stringify(health).includes(SENTINELA), false);

    const anon = await rpc(app, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: "" });
    assert.equal(anon.status, 401);
    const wrong = await rpc(app, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: "outro-token" });
    assert.equal(wrong.status, 401);

    const init = await rpc(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teste", version: "0" } },
    });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.serverInfo.name, "helios");
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.ok(init.session);
    const note = await rpc(app, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.status, 202);

    const list = await rpc(app, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = list.body.result.tools.map((tool) => tool.name);
    for (const name of [
      "helios_criar_tarefa",
      "helios_listar_tarefas",
      "helios_atualizar_tarefa",
      "helios_listar_rotinas",
      "helios_rodar_rotina",
      "helios_buscar_conversas",
      "helios_ler_conversa",
      "helios_consultar_memoria",
      "helios_enviar_mensagem",
    ]) assert.ok(names.includes(name), name);

    const created = await call(app, "helios_criar_tarefa", { titulo: "Revisar o header", detalhe: "com o estagiário" });
    assert.match(created.content[0].text, /Revisar o header/);
    const createdTask = JSON.parse(created.content[0].text).tarefa;
    const done = await call(app, "helios_atualizar_tarefa", { id: createdTask.id, status: "feita" });
    assert.match(done.content[0].text, /feita/);
    const listed = await call(app, "helios_listar_tarefas", {});
    assert.match(listed.content[0].text, /feita/);

    await fetch(`${app.url}/api/memory`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}` },
      body: JSON.stringify({ text: "O Helison explica o header em português.", kind: "fato" }),
    });
    const memory = await call(app, "helios_consultar_memoria", { consulta: "header" });
    assert.match(memory.content[0].text, /header/);

    const routine = await fetch(`${app.url}/api/routines`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}` },
      body: JSON.stringify({ title: "Resumo", prompt: "resume o que ficou pendente hoje", everyMinutes: 60 }),
    }).then((res) => res.json());
    const routines = await call(app, "helios_listar_rotinas", {});
    assert.match(routines.content[0].text, /Resumo/);
    const ran = await call(app, "helios_rodar_rotina", { id: routine.routine.id });
    assert.match(ran.content[0].text, /"status":"ok"/);

    const sent = await call(app, "helios_enviar_mensagem", { texto: "apagar o rascunho da landing" });
    const sentJson = JSON.parse(sent.content[0].text);
    assert.equal(sentJson.status, "pendente");
    assert.ok(sentJson.cartao.id);
    const found = await call(app, "helios_buscar_conversas", { consulta: "rascunho da landing" });
    assert.match(found.content[0].text, /rascunho da landing/);
    const read = await call(app, "helios_ler_conversa", { id: sentJson.conversa });
    assert.match(read.content[0].text, /rascunho da landing/);

    const blocked = await call(app, "helios_ler_cofre", {});
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /cofre/);

    const dump = [init, list, created, listed, memory, routines, ran, sent, found, read, blocked]
      .map((item) => JSON.stringify(item)).join("\n");
    assert.equal(dump.includes(SENTINELA), false);
    assert.equal(dump.includes(TOKEN), false);
  } finally {
    await app.close();
  }
});
