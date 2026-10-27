"use strict";

/** Correções da auditoria de 25/10/2026: C-5 (credenciais de conectores cifradas), C-6 (fuses), NV-5 (guarda de IPC), hardening. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createMcpRegistry } = require("../server/mcp-registry");
const { createRendererGuard, guardIpcMain } = require("../src/ipc-guard");
const { safeRel } = require("../server/livecoding");
const { startServer } = require("../server/index");

const TOKEN_VALUE = "valor-secreto-do-conector-123456";

/** Cifra de mentira (base64 invertido) com a mesma interface do cofre. */
function fakeSealer({ broken = false } = {}) {
  return {
    available: () => !broken,
    seal: async (text) => Buffer.from([...Buffer.from(text, "utf8")].reverse()).toString("base64"),
    open: async (blob) => {
      if (broken) throw new Error("sem chave");
      return Buffer.from([...Buffer.from(blob, "base64")].reverse()).toString("utf8");
    },
  };
}

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("C-5: env e headers de conectores vão cifrados para o disco e nunca aparecem na lista", async () => {
  const dir = tmp("helios-reg-");
  const reg = createMcpRegistry(dir, { connect: async () => ({ tools: [], call: async () => ({}), close() {} }), sealer: fakeSealer() });
  await reg.ready();
  const stdio = reg.add({ name: "local", type: "stdio", command: "node", args: ["x.js"], env: { API_TOKEN: TOKEN_VALUE } });
  const http = reg.add({ name: "nuvem", type: "http", url: "https://exemplo.com/mcp", headers: { Authorization: `Bearer ${TOKEN_VALUE}` } });
  await reg.flush();
  const raw = fs.readFileSync(reg.file, "utf8");
  assert.ok(!raw.includes(TOKEN_VALUE), "nenhum valor em texto aberto no arquivo");
  assert.match(raw, /secretsEnc/);
  assert.ok(raw.includes("API_TOKEN"), "os nomes das variáveis continuam visíveis para a tela");
  assert.equal(reg.list().find((item) => item.id === stdio.id).encrypted, true);
  assert.ok(!JSON.stringify(reg.list()).includes(TOKEN_VALUE));
  assert.equal(http.hasHeaders, true);

  const again = createMcpRegistry(dir, { connect: async () => ({}), sealer: fakeSealer() });
  await again.ready();
  assert.equal(again.list().length, 2);
  assert.ok(!JSON.stringify(again.list()).includes(TOKEN_VALUE));
});

test("C-5: mcp.json antigo em texto aberto é migrado para cifrado na primeira abertura", async () => {
  const dir = tmp("helios-reg-mig-");
  fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify([{ id: "mcp_1", name: "antigo", type: "stdio", command: "node", args: [], url: "", env: { API_TOKEN: TOKEN_VALUE }, headers: {}, tools: [], toolCount: 0, confirmed: true, status: "unknown" }]));
  const reg = createMcpRegistry(dir, { connect: async () => ({}), sealer: fakeSealer() });
  await reg.ready();
  await reg.flush();
  assert.ok(!fs.readFileSync(reg.file, "utf8").includes(TOKEN_VALUE));
  assert.equal(reg.list()[0].encrypted, true);
});

test("C-5: sem a chave para abrir, o bloco cifrado fica intacto e o conector fica bloqueado (nada é sobrescrito)", async () => {
  const dir = tmp("helios-reg-lock-");
  const first = createMcpRegistry(dir, { connect: async () => ({}), sealer: fakeSealer() });
  await first.ready();
  first.add({ name: "local", type: "stdio", command: "node", env: { API_TOKEN: TOKEN_VALUE } });
  await first.flush();
  const before = fs.readFileSync(first.file, "utf8");
  const locked = createMcpRegistry(dir, { connect: async () => ({}), sealer: fakeSealer({ broken: true }) });
  await locked.ready();
  assert.equal(locked.list()[0].secretsLocked, true);
  locked.add({ name: "outro", type: "http", url: "https://exemplo.com/mcp" });
  await locked.flush();
  const after = JSON.parse(fs.readFileSync(locked.file, "utf8"));
  assert.equal(JSON.parse(before)[0].secretsEnc, after.find((item) => item.name === "local").secretsEnc);
});

test("C-5: sem cifra disponível, o comportamento antigo continua (texto aberto) e a lista marca encrypted=null/false", async () => {
  const dir = tmp("helios-reg-plain-");
  const reg = createMcpRegistry(dir, { connect: async () => ({}) });
  await reg.ready();
  reg.add({ name: "local", type: "stdio", command: "node", env: { A: "b" } });
  assert.notEqual(reg.list()[0].encrypted, true);
  assert.ok(!JSON.stringify(reg.list()).includes('"b"'));
});

test("C-6: o empacotamento liga as fuses seguras do Electron", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const fuses = pkg.build.electronFuses;
  assert.equal(fuses.runAsNode, false);
  assert.equal(fuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(fuses.enableNodeCliInspectArguments, false);
  assert.equal(fuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(fuses.onlyLoadAppFromAsar, true);
});

test("NV-5: a guarda de IPC só aceita a página do HELIOS e falha fechada", () => {
  const dir = path.join(tmp("helios-ipc-"), "renderer");
  fs.mkdirSync(dir);
  const guard = createRendererGuard(dir);
  const page = pathToFileURL(path.join(dir, "index.html")).href;
  assert.equal(guard.isAllowedUrl(page), true);
  assert.equal(guard.isAllowedUrl(page.toUpperCase().replace("FILE:", "file:")), true, "maiúsculas/minúsculas do Windows");
  assert.equal(guard.isAllowedUrl("https://exemplo.com/renderer/index.html"), false);
  assert.equal(guard.isAllowedUrl(`${pathToFileURL(dir).href}/../segredo.html`), false);
  assert.equal(guard.isAllowedUrl(pathToFileURL(path.join(dir, "..", "outra", "index.html")).href), false);
  assert.equal(guard.isAllowedEvent({ senderFrame: { url: page } }), true);
  assert.equal(guard.isAllowedEvent({ senderFrame: { url: "https://exemplo.com" } }), false);
  assert.equal(guard.isAllowedEvent({}), false);
  assert.equal(guard.isAllowedEvent(null), false);
  let prevented = 0;
  guard.blockNavigation({ preventDefault: () => { prevented += 1; } }, "https://exemplo.com");
  guard.blockNavigation({ preventDefault: () => { prevented += 1; } }, page);
  assert.equal(prevented, 1);
});

test("NV-5: guardIpcMain recusa chamadas de origem estranha em handle e on", async () => {
  const dir = path.join(tmp("helios-ipc2-"), "renderer");
  fs.mkdirSync(dir);
  const guard = createRendererGuard(dir);
  const handlers = new Map();
  const ipc = { handle: (c, fn) => handlers.set(`h:${c}`, fn), on: (c, fn) => handlers.set(`o:${c}`, fn) };
  const denied = [];
  guardIpcMain(ipc, guard, (channel) => denied.push(channel));
  let ran = 0;
  ipc.handle("a", () => { ran += 1; return "ok"; });
  ipc.on("b", () => { ran += 1; });
  const good = { senderFrame: { url: pathToFileURL(path.join(dir, "index.html")).href } };
  const bad = { senderFrame: { url: "https://exemplo.com/" } };
  assert.equal(await handlers.get("h:a")(good), "ok");
  assert.throws(() => handlers.get("h:a")(bad), /Origem não autorizada/);
  handlers.get("o:b")(good);
  handlers.get("o:b")(bad);
  assert.equal(ran, 2);
  assert.deepEqual(denied, ["a", "b"]);
});

test("hardening: livecoding recusa arquivo ou pasta oculta e caminhos fora da pasta", () => {
  assert.equal(safeRel("index.html"), "index.html");
  assert.equal(safeRel("css/estilo.css"), "css/estilo.css");
  for (const bad of [".env", ".git/config", "a/.vscode/settings.json", "../x", "/etc/passwd", "C:/x", "a b.txt"]) {
    assert.equal(safeRel(bad), null, bad);
  }
});

test("hardening: /mcp sem token é recusado (401) antes de ler o corpo", async () => {
  const dataDir = tmp("helios-mcp401-");
  const app = await startServer({ dataDir, projectsDir: path.join(dataDir, "p"), port: 0, mock: true, routineMs: 0, getMcpToken: () => "token-de-teste" });
  try {
    const res = await fetch(`${app.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(200000) }) });
    assert.equal(res.status, 401);
    const ok = await fetch(`${app.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token-de-teste" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(ok.status, 200);
  } finally {
    await app.close();
  }
});