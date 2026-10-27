"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../server/index");

const TOKEN = "token-de-teste-novos-itens";

async function boot(extra = {}) {
  const dataDir = extra.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "helios-ideias-"));
  return startServer({
    dataDir,
    projectsDir: path.join(dataDir, "projetos"),
    port: 0,
    mock: true,
    routineMs: 0,
    getMcpToken: () => TOKEN,
    getVaultIndex: () => [{ id: "login_1", tipo: "login", nome: "GitHub", senha: "senha-super-secreta" }],
    onFillLogin: async () => ({ ok: true }),
    openEditor: () => ({ ok: true, cmd: "code" }),
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

async function idle(app, id) {
  for (let i = 0; i < 200; i += 1) {
    const { body } = await json(app, `/api/conversations/${id}`);
    if (body.conversation && !body.conversation.busy) return body.conversation;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("a conversa não ficou pronta");
}

/** Manda uma mensagem (em conversa nova, se não vier id) e espera terminar. */
async function say(app, text, convId, extra = {}) {
  const id = convId || (await json(app, "/api/conversations", { method: "POST", body: extra })).body.conversation.id;
  await json(app, `/api/conversations/${id}/messages`, { method: "POST", body: { text } });
  return idle(app, id);
}

const inbox = async (app) => (await json(app, "/api/inbox")).body;

/** Chamada JSON-RPC ao MCP local (como um cliente externo faria). */
async function rpcCall(app, name, args) {
  const res = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return JSON.parse(JSON.parse(await res.text()).result.content[0].text);
}

/** Cria uma rotina e a dispara pelo MCP: a conversa dela é "Rotina: <título>" (origem automática). */
async function runRoutine(app, title, prompt) {
  const existing = (await json(app, "/api/routines")).body.routines.find((item) => item.title === title);
  const routine = existing || (await json(app, "/api/routines", { method: "POST", body: { title, prompt, everyMinutes: 60 } })).body.routine;
  if (existing) await json(app, `/api/routines/${routine.id}`, { method: "POST", body: { prompt } });
  return rpcCall(app, "helios_rodar_rotina", { id: routine.id, esperarMs: 4000 });
}

module.exports = { boot, json, idle, say, inbox, rpcCall, runRoutine, TOKEN };