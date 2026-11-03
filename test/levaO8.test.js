"use strict";
// LEVA O8: MCP remoto finalizado (allowlist, rate limit, log sem segredos,
// desligado por padrão) + script/docs do túnel cloudflared. Porta prompt 48061+.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const {
  createMcpServer,
  createMcpRemoteConfig,
  REMOTE_ALLOWLIST,
  REMOTE_TOOLS,
} = require("../server/mcp-server");
const { createQuadro } = require("../server/quadro");
const { createChefe } = require("../server/chefe");
const { createAssistants } = require("../server/assistants");
const { createMissions } = require("../server/missions");
const { boot, json, TOKEN } = require("./helpers-ideias");

const tmp = (prefix = "helios-levaO8-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const REMOTE_TOK = "remote-token-levaO8-mock-xxxxxxxx";
const ROOT = path.join(__dirname, "..");

function mockReq(auth, { loopback = true } = {}) {
  const addr = loopback ? "127.0.0.1" : "203.0.113.9";
  return {
    method: "POST",
    headers: {
      authorization: auth,
      "content-type": "application/json",
    },
    socket: { localAddress: loopback ? "127.0.0.1" : addr, remoteAddress: addr },
  };
}

function mockRes() {
  const out = { status: 0, headers: {}, body: "" };
  return {
    out,
    writeHead(code, headers) {
      out.status = code;
      out.headers = headers || {};
    },
    end(chunk) {
      out.body = chunk == null ? "" : String(chunk);
    },
  };
}

async function mcpJson(server, auth, message, opts) {
  const res = mockRes();
  await server.respond(mockReq(auth, opts), res, message);
  return { status: res.out.status, body: res.out.body ? JSON.parse(res.out.body) : null };
}

function makeRemoteServer(dir, { enabled = true, ratePerMin = 30 } = {}) {
  const quadro = createQuadro(dir);
  const assistants = createAssistants(dir);
  assistants.seedBuiltins();
  const missions = createMissions(dir);
  const chefe = createChefe(dir, { quadro, missions, assistants });
  const cfg = createMcpRemoteConfig(dir);
  if (enabled) cfg.setEnabled(true);
  if (ratePerMin !== 30) cfg.setRatePerMin(ratePerMin);
  const server = createMcpServer({
    tasks: { add: () => ({}), list: () => [], update: () => null },
    routines: { list: () => [], markRan: () => {} },
    store: { create: () => ({ id: "c1", messages: [] }), get: () => null, update: () => {}, list: () => [] },
    memory: { context: () => ({ text: "", ids: [] }) },
    memories: null,
    assistants,
    orchestration: null,
    bot: { send: () => {} },
    getToken: () => TOKEN,
    quadro,
    chefe,
    getRemoteToken: () => REMOTE_TOK,
    isRemoteEnabled: () => cfg.isEnabled(),
    dataDir: dir,
    remoteRatePerMin: () => cfg.ratePerMin(),
  });
  return { server, cfg, quadro, chefe, dir };
}

test("levaO8: MCP remoto desligado por padrão; API sem valor de token", async () => {
  const dir = tmp();
  const app = await boot({
    dataDir: dir,
    chefeMs: 0,
    getMcpRemoteToken: () => REMOTE_TOK,
  });
  try {
    const cfg = await json(app, "/api/mcp/remoto");
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.enabled, false);
    assert.equal(cfg.body.tokenDefinido, true);
    assert.ok(!("token" in cfg.body));
    assert.ok(!JSON.stringify(cfg.body).includes(REMOTE_TOK));
    assert.ok(Array.isArray(cfg.body.allowlist));
    assert.equal(cfg.body.allowlist.length, 6);

    const denied = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${REMOTE_TOK}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(denied.status, 403);
  } finally {
    await app.close();
  }
});

test("levaO8: allowlist mínima + tools locais completas; remoto bloqueia memória", async () => {
  const dir = tmp();
  const { server } = makeRemoteServer(dir, { enabled: true });

  const localList = await mcpJson(server, `Bearer ${TOKEN}`, {
    jsonrpc: "2.0", id: 1, method: "tools/list",
  });
  assert.equal(localList.status, 200);
  const localNames = localList.body.result.tools.map((t) => t.name);
  assert.ok(localNames.includes("helios_consultar_memoria"));
  assert.ok(localNames.includes("helios_enviar_mensagem"));

  const remoteList = await mcpJson(server, `Bearer ${REMOTE_TOK}`, {
    jsonrpc: "2.0", id: 2, method: "tools/list",
  });
  assert.equal(remoteList.status, 200);
  const remoteNames = remoteList.body.result.tools.map((t) => t.name);
  assert.deepEqual(new Set(remoteNames), new Set(REMOTE_ALLOWLIST));
  assert.equal(remoteNames.length, REMOTE_TOOLS.length);
  assert.ok(!remoteNames.includes("helios_consultar_memoria"));

  const blocked = await mcpJson(server, `Bearer ${REMOTE_TOK}`, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "helios_consultar_memoria", arguments: { consulta: "cpf" } },
  });
  assert.equal(blocked.status, 200);
  assert.match(blocked.body.result.content[0].text, /indisponível|remoto/i);

  const ordem = await mcpJson(server, `Bearer ${REMOTE_TOK}`, {
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "helios_chefe_ordem", arguments: { texto: "Ping inofensivo O8." } },
  });
  assert.equal(ordem.status, 200);
  const parsed = JSON.parse(ordem.body.result.content[0].text);
  assert.ok(parsed.item?.id || parsed.ciclo);
});

test("levaO8: rate limit remoto vivo + log sem segredos", async () => {
  const dir = tmp();
  const { server, cfg } = makeRemoteServer(dir, { enabled: true, ratePerMin: 1 });
  assert.equal(cfg.ratePerMin(), 1);

  const ok1 = await mcpJson(server, `Bearer ${REMOTE_TOK}`, {
    jsonrpc: "2.0", id: 1, method: "ping",
  });
  assert.equal(ok1.status, 200);

  const limited = await mcpJson(server, `Bearer ${REMOTE_TOK}`, {
    jsonrpc: "2.0", id: 2, method: "ping",
  });
  assert.equal(limited.status, 429);
  assert.match(limited.body.error.message, /rate limit/i);

  // getter vivo: sobe o teto na mesma janela e a próxima passa
  cfg.setRatePerMin(100);
  assert.equal(cfg.ratePerMin(), 100);
  const after = await mcpJson(server, `Bearer ${REMOTE_TOK}`, {
    jsonrpc: "2.0", id: 3, method: "ping",
  });
  assert.equal(after.status, 200);

  const logFile = path.join(dir, "mcp-remote-access.json");
  assert.ok(fs.existsSync(logFile));
  const raw = fs.readFileSync(logFile, "utf8");
  assert.ok(!raw.includes(REMOTE_TOK));
  assert.doesNotMatch(raw, /Bearer\s+[A-Za-z0-9_-]{16,}/i);
  assert.doesNotMatch(raw, /Authorization/i);
  const data = JSON.parse(raw);
  assert.ok(Array.isArray(data.items));
  assert.ok(data.items.some((i) => i.ok === false && /rate limit/i.test(i.reason || "")));
  assert.ok(data.items.every((i) => !("token" in i) && !("authorization" in i) && !("body" in i)));
});

test("levaO8: token local ≠ remoto; API liga/desliga sem vazar token", async () => {
  const dir = tmp();
  const app = await boot({
    dataDir: dir,
    chefeMs: 0,
    port: 0,
    getMcpRemoteToken: () => REMOTE_TOK,
  });
  try {
    // local com token remoto deve falhar enquanto desligado; com ligado, modo remoto
    await json(app, "/api/mcp/remoto", { method: "POST", body: { enabled: true, ratePerMin: 40 } });
    const st = await json(app, "/api/mcp/remoto");
    assert.equal(st.body.enabled, true);
    assert.equal(st.body.ratePerMin, 40);
    assert.ok(!("token" in st.body));
    assert.ok(!JSON.stringify(st.body).includes(REMOTE_TOK));

    const remoteTools = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${REMOTE_TOK}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(remoteTools.status, 200);
    assert.equal(remoteTools.body.result.tools.length, 6);

    // token local continua com lista completa
    const localTools = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }).then((r) => r.json());
    assert.ok(localTools.result.tools.length > 6);

    await json(app, "/api/mcp/remoto", { method: "POST", body: { enabled: false } });
    const off = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${REMOTE_TOK}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    assert.equal(off.status, 403);
  } finally {
    await app.close();
  }
});

test("levaO8: script tunel.ps1 e docs de operação", () => {
  const script = path.join(ROOT, "scripts", "tunel.ps1");
  assert.ok(fs.existsSync(script), "scripts/tunel.ps1");
  const ps1 = fs.readFileSync(script, "utf8");
  assert.match(ps1, /cloudflared tunnel --url/);
  assert.match(ps1, /-Port/);
  assert.match(ps1, /Named/);
  assert.match(ps1, /Authorization: Bearer/);
  assert.doesNotMatch(ps1, /Bearer\s+[A-Za-z0-9_-]{20,}/); // sem token literal

  const tunel = fs.readFileSync(path.join(ROOT, "docs", "operacao", "tunel.md"), "utf8");
  assert.match(tunel, /trycloudflare|Quick tunnel/i);
  assert.match(tunel, /Authorization: Bearer/);
  assert.match(tunel, /scripts\\tunel\.ps1|scripts\/tunel\.ps1/);
  assert.match(tunel, /winget install --id Cloudflare\.cloudflared/);
  assert.match(tunel, /Grok Bot/);
  assert.doesNotMatch(tunel, /Bearer\s+[A-Za-z0-9_-]{20,}/);

  const mcp = fs.readFileSync(path.join(ROOT, "docs", "operacao", "mcp.md"), "utf8");
  assert.match(mcp, /mcpRemote|MCP remoto/i);
  assert.match(mcp, /desligado/i);

  const contas = fs.readFileSync(path.join(ROOT, "renderer", "contas.js"), "utf8");
  assert.match(contas, /MCP remoto/);
  assert.match(contas, /tunel\.md/);
});

test("levaO8: createMcpRemoteConfig persiste enabled false por padrão", () => {
  const dir = tmp();
  const cfg = createMcpRemoteConfig(dir);
  assert.equal(cfg.isEnabled(), false);
  assert.equal(cfg.ratePerMin(), 30);
  assert.equal(cfg.view().enabled, false);
  assert.ok(!("token" in cfg.view()));
  cfg.setEnabled(false);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, "mcp-remote.json"), "utf8"));
  assert.equal(disk.enabled, false);
  assert.ok(!("token" in disk));
  const reloaded = createMcpRemoteConfig(dir);
  assert.equal(reloaded.isEnabled(), false);
});

test("levaO8: servidor HTTP mock na faixa 48061+ responde só com Bearer remoto ligado", async () => {
  const dir = tmp();
  const { server, cfg } = makeRemoteServer(dir, { enabled: false });

  function attach(httpServer) {
    httpServer.on("request", (req, res) => {
      if (req.url !== "/mcp") {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { body = {}; }
        server.respond(req, res, body);
      });
    });
  }

  let httpServer = null;
  let port = 0;
  for (let p = 48061; p <= 48080; p += 1) {
    const candidate = http.createServer();
    attach(candidate);
    try {
      await new Promise((resolve, reject) => {
        candidate.once("error", reject);
        candidate.listen(p, "127.0.0.1", resolve);
      });
      httpServer = candidate;
      port = p;
      break;
    } catch (err) {
      candidate.close();
      if (err && err.code === "EADDRINUSE") continue;
      throw err;
    }
  }
  assert.ok(httpServer, "nenhuma porta livre em 48061–48080");
  try {
    assert.ok(port >= 48061 && port <= 48080);
    assert.notEqual(port, 47331);

    const base = `http://127.0.0.1:${port}/mcp`;
    const off = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${REMOTE_TOK}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    assert.equal(off.status, 403);

    cfg.setEnabled(true);
    const on = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${REMOTE_TOK}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(on.status, 200);
    assert.match(on.body.result.instructions || "", /allowlist|remoto/i);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
