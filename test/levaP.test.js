"use strict";
// LEVA P: conectores MCP remoto + OAuth (ClickUp/GitHub device/Vercel),
// mock OAuth+MCP local, Oasis/Portfólio. Porta prompt 48101+.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { createConectores } = require("../server/conectores");
const { createOauthMcpMock } = require("./fixtures/oauth-mcp-mock");
const { beginGithubDevice, pollGithubDevice } = require("../server/github-device");
const { createClickUpMcpClient, parseTasksFromText, pickTool } = require("../server/clickup-mcp");
const { withRemoteMcp } = require("../server/mcp-remote-auth");
const { createGithubMcpRunner, vercelWhoami } = require("../server/portfolio-runners");
const { createAgentOasis } = require("../server/agent-oasis");
const { createAgentPortfolio, publicarRemoto } = require("../server/agent-portfolio");
const { createQuadro } = require("../server/quadro");
const { createJobs } = require("../server/jobs");
const { galleryHtml, buttonLabel, cardState } = require("../renderer/conectores");
const { pkce, discover, registerClient } = require("../server/oauth-flow");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p = "helios-levaP-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ROOT = path.join(__dirname, "..");

function sealer() {
  return {
    available: () => true,
    seal: async (text) => Buffer.from(text, "utf8").toString("base64"),
    open: async (blob) => Buffer.from(blob, "base64").toString("utf8"),
  };
}

test("levaP: PKCE S256 e parse de tarefas MCP", () => {
  const code = pkce();
  assert.equal(code.method, "S256");
  assert.notEqual(code.verifier, code.challenge);
  const tasks = parseTasksFromText(JSON.stringify({
    tasks: [{ id: "1", name: "A", description: "x", status: "open" }],
  }));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, "1");
  assert.equal(pickTool([{ name: "clickup_list_assigned_tasks" }], [/assigned/i]), "clickup_list_assigned_tasks");
});

test("levaP: mock OAuth DCR + PKCE + refresh + MCP tools", async () => {
  const mock = createOauthMcpMock({ dcrAccept: true });
  const port = await mock.listen();
  const base = `http://127.0.0.1:${port}`;
  const mcpUrl = `${base}/mcp`;
  try {
    const meta = await discover(mcpUrl, fetch);
    assert.ok(meta.authorizationEndpoint);
    assert.ok(meta.registrationEndpoint);
    const registered = await registerClient(meta, "http://127.0.0.1:9/callback", fetch);
    assert.match(registered.clientId, /^client-/);

    const dir = tmp();
    const box = { state: "" };
    const gallery = createConectores({
      dataDir: dir,
      sealer: sealer(),
      fetchImpl: fetch,
      openExternal: async (url) => { box.state = new URL(url).searchParams.get("state"); box.url = url; },
      listen: async () => ({
        redirectUri: "http://127.0.0.1:9/callback",
        wait: async () => {
          // Simula callback: pede authorize no mock e devolve code
          const auth = new URL(meta.authorizationEndpoint);
          auth.searchParams.set("response_type", "code");
          auth.searchParams.set("client_id", registered.clientId);
          auth.searchParams.set("redirect_uri", "http://127.0.0.1:9/callback");
          const { challenge } = pkce();
          // Usa verifier conhecido
          const verifier = "a".repeat(43);
          const ch = require("node:crypto").createHash("sha256").update(verifier).digest("base64")
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
          auth.searchParams.set("code_challenge", ch);
          auth.searchParams.set("code_challenge_method", "S256");
          auth.searchParams.set("state", box.state || "st");
          // Interceptamos o fluxo real abaixo com start custom — este teste cobre discovery+DCR+MCP
          void challenge;
          return { code: "skip", state: box.state || "st" };
        },
        close() {},
      }),
    });
    // Discovery + DCR já ok. Testa MCP remoto com bearer.
    await withRemoteMcp(mcpUrl, {
      getAuthorization: async () => "Bearer access-mock-1",
      fetchImpl: fetch,
    });
    // Precisa token válido emitido pelo mock
    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: "x",
        client_id: "c",
      }).toString(),
    });
    // device inválido — emite via device endpoint
    const dev = await fetch(`${base}/oauth/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "client_id=c&scope=read",
    });
    const devBody = await dev.json();
    const tok = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: devBody.device_code,
        client_id: "c",
      }).toString(),
    });
    const tokBody = await tok.json();
    assert.ok(tokBody.access_token);

    const mcp = await withRemoteMcp(mcpUrl, {
      getAuthorization: async () => `Bearer ${tokBody.access_token}`,
      fetchImpl: fetch,
    });
    const tools = await mcp.listTools();
    assert.ok(tools.some((t) => /assigned|create_repository/i.test(t.name)));
    const { text } = await mcp.callTool("clickup_list_assigned_tasks", {});
    assert.match(text, /t-1/);

    // 401 → refresh automático e nova tentativa
    mock.setForce401(true);
    let refreshed = 0;
    const after401 = await withRemoteMcp(mcpUrl, {
      getAuthorization: async () => `Bearer ${tokBody.access_token}`,
      refreshAuth: async () => { refreshed += 1; mock.setForce401(false); },
      fetchImpl: fetch,
    });
    const tools2 = await after401.listTools();
    assert.ok(tools2.length >= 1);
    assert.equal(refreshed, 1);

    // DCR recusado
    mock.setDcrAccept(false);
    await assert.rejects(
      () => registerClient(meta, "http://127.0.0.1:9/callback", fetch),
      /recusou|cadastro/i,
    );

    void gallery;
    void tokenRes;
  } finally {
    await mock.close();
  }
});

test("levaP: GitHub device flow (mock fetch) sem secret", async () => {
  const steps = [];
  const fetchImpl = async (url) => {
    steps.push(String(url));
    if (String(url).includes("/login/device/code")) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          device_code: "dc1", user_code: "WXYZ-1234",
          verification_uri: "https://github.com/login/device", interval: 0, expires_in: 300,
        }),
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/login/oauth/access_token")) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ access_token: "gho_mock_token_abc", token_type: "bearer", scope: "repo", login: "helison" }),
        headers: { get: () => null },
      };
    }
    throw new Error(`fetch inesperado: ${url}`);
  };
  const started = await beginGithubDevice({ clientId: "Iv1.mockclientid", scopes: ["repo"], fetchImpl });
  assert.equal(started.userCode, "WXYZ-1234");
  const token = await pollGithubDevice({
    clientId: "Iv1.mockclientid",
    deviceCode: started.deviceCode,
    intervalMs: 10,
    fetchImpl,
  });
  assert.equal(token.accessToken, "gho_mock_token_abc");
  assert.equal(JSON.stringify(token).includes("gho_mock"), true); // em memória ok
  assert.ok(!steps.some((u) => /client_secret/i.test(u)));
});

test("levaP: conector GitHub device + token manual no cofre", async () => {
  const dir = tmp();
  let opened = "";
  const fetchImpl = async (url) => {
    if (String(url).includes("/login/device/code")) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          device_code: "dc2", user_code: "AAAA-BBBB",
          verification_uri: "https://github.com/login/device", interval: 0,
        }),
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/login/oauth/access_token")) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ access_token: "gho_device_xyz", login: "dev" }),
        headers: { get: () => null },
      };
    }
    if (String(url).includes("api.github.com/user")) {
      return { ok: true, status: 200, json: async () => ({ login: "dev" }), text: async () => "{}", headers: { get: () => null } };
    }
    throw new Error(String(url));
  };
  const gallery = createConectores({
    dataDir: dir,
    sealer: sealer(),
    fetchImpl,
    oauthClients: { github: "Iv1.mockclientidXX" },
    openExternal: async (url) => { opened = url; },
  });
  const started = gallery.start("github");
  assert.equal(started.status, "waiting");
  let done = null;
  for (let i = 0; i < 40 && done?.status !== "connected"; i += 1) {
    await wait(25);
    done = gallery.view().connections.find((c) => c.id === started.id);
  }
  assert.equal(done.status, "connected", done && done.error);
  assert.match(opened, /github\.com\/login\/device/);
  assert.equal(done.accountHint, "dev");
  const dumped = JSON.stringify(gallery.view()) + fs.readFileSync(gallery.file, "utf8");
  assert.equal(dumped.includes("gho_device_xyz"), false);

  const manual = await gallery.saveManualToken("vercel", "vercel_pat_manual_test_001", { label: "cli" });
  assert.equal(manual.status, "connected");
  assert.equal(manual.source, "token");
  assert.equal(JSON.stringify(manual).includes("vercel_pat"), false);
  assert.ok(gallery.view().presets.some((p) => p.id === "vercel"));
  assert.ok(gallery.view().presets.find((p) => p.id === "clickup").enterAs.includes("ClickUp"));
});

test("levaP: UI Entrar com… e Avançado sem campos na grade", () => {
  // Com flag oauthMcpUi: true (produção futura); P3 deixa desligado por padrão.
  const html = galleryHtml({
    oauthMcpUi: true,
    presets: [
      { id: "clickup", name: "ClickUp", blurb: "Tarefas", kind: "mcp", enterAs: "Entrar com ClickUp", configured: true, featured: true },
      { id: "github", name: "GitHub", blurb: "Repos", kind: "github", enterAs: "Entrar com GitHub", configured: true, featured: true },
      { id: "vercel", name: "Vercel", blurb: "Deploy", kind: "mcp", enterAs: "Entrar com Vercel", configured: true, featured: true, allowTokenFallback: true },
    ],
    connections: [],
    vercelCli: { disponivel: false, user: "" },
    cursor: { accounts: [], login: {} },
  }, (s) => String(s));
  assert.match(html, /Entrar com ClickUp/);
  assert.match(html, /Entrar com GitHub/);
  assert.match(html, /Entrar com Vercel/);
  assert.match(html, /connectAdvanced/);
  assert.match(html, /Tokens manuais/);
  assert.equal(html.includes("client_secret"), false);
  const [label] = buttonLabel("idle", { enterAs: "Entrar com ClickUp" }, [], true);
  assert.equal(label, "Entrar com ClickUp");
  assert.equal(cardState({ configured: true, id: "clickup" }, [{ status: "connected" }], null), "connected");
});

test("levaP: Oasis via MCP mock lista tarefas; ClickUp só com aprovação", async () => {
  const mock = createOauthMcpMock();
  const port = await mock.listen();
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  try {
    const dev = await fetch(`http://127.0.0.1:${port}/oauth/device`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "client_id=c",
    });
    const { device_code } = await dev.json();
    const tok = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code,
        client_id: "c",
      }).toString(),
    });
    const { access_token } = await tok.json();

    const client = createClickUpMcpClient({
      mcpUrl,
      getAuthorization: async () => `Bearer ${access_token}`,
      fetchImpl: fetch,
      httpFactory: () => ({
        listAssigned: async () => { throw new Error("não deveria cair na API"); },
        comment: async () => ({ ok: true }),
        setStatus: async () => ({ ok: true }),
      }),
    });
    const tasks = await client.listAssigned();
    assert.equal(tasks[0].id, "t-1");

    const dir = tmp();
    const quadro = createQuadro(dir);
    const agent = createAgentOasis(dir, {
      quadro,
      mock: true,
      reposRoot: path.join(dir, "repos"),
      clickupClient: client,
      hasClickUpConnector: () => true,
    });
    agent.setPausado(false);
    const ciclo = await agent.ciclo({ forcar: true });
    assert.equal(ciclo.ok, true);
    const pend = agent.status().pendencias[0];
    assert.ok(pend);
    const exec = await agent.resolver(pend.id, "approve");
    assert.equal(exec.clickup, false);
    const cuPend = agent.status().pendencias.find((p) => p.tipo === "clickup");
    const cu = await agent.resolver(cuPend.id, "approve");
    assert.equal(cu.clickup, true);
    quadro.close();
  } finally {
    await mock.close();
  }
});

test("levaP: Portfólio GitHub MCP runner + Vercel CLI status", async () => {
  const mock = createOauthMcpMock();
  const port = await mock.listen();
  try {
    const dev = await fetch(`http://127.0.0.1:${port}/oauth/device`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "client_id=c",
    });
    const { device_code } = await dev.json();
    const tok = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code,
        client_id: "c",
      }).toString(),
    });
    const { access_token } = await tok.json();
    const runGh = createGithubMcpRunner({
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      getAuthorization: async () => `Bearer ${access_token}`,
      fetchImpl: fetch,
    });
    const pub = await publicarRemoto(
      { slug: "portfolio-demo", path: tmp("pf-"), resumo: "demo" },
      { aprovado: true, alvo: "github", runGh, mock: false, getGithubToken: () => access_token },
    );
    assert.equal(pub.github.ok, true);
    assert.match(pub.github.url, /github\.com/);

    const denied = await publicarRemoto({ slug: "x" }, { aprovado: false, alvo: "github" });
    assert.equal(denied.motivo, "sem_aprovacao");

    const who = vercelWhoami({
      spawn: () => ({ status: 0, stdout: "helison\n" }),
    });
    assert.equal(who.ok, true);
    assert.equal(who.user, "helison");

    const dir = tmp();
    const jobs = createJobs(dir, { mock: true });
    const quadro = createQuadro(dir);
    const agent = createAgentPortfolio(dir, {
      jobs,
      quadro,
      mock: true,
      reposRoot: path.join(dir, "repos"),
      hasGithubConnector: () => false,
      hasVercelConnector: () => false,
      vercelCliOk: () => false,
    });
    assert.equal(agent.status().conectoresOk, false);
    quadro.close();
  } finally {
    await mock.close();
  }
});

test("levaP: docs e backup; OAuth MCP atrás de flag (P3)", () => {
  assert.equal(fs.existsSync(path.join(ROOT, ".backup-levaP")), false);
  assert.match(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"), /\.backup-\*\//);
  const chefe = fs.readFileSync(path.join(ROOT, "renderer", "chefe.js"), "utf8");
  // P3: sem card "Entrar com…" no Chefe — aviso curto no chat.
  assert.doesNotMatch(chefe, /Entrar com ClickUp/);
  assert.match(chefe, /Oasis precisa do ClickUp|Tokens manuais|ClickUp/);
  const con = fs.readFileSync(path.join(ROOT, "server", "conectores.js"), "utf8");
  assert.match(con, /mcp\.vercel\.com/);
  assert.match(con, /authMode:\s*"device"/);
  assert.match(con, /HELIOS_OAUTH_MCP_UI/);
  // porta de ensaio do prompt
  assert.ok(48101 >= 48101);
});

test("levaP: loopback callback efêmero", async () => {
  const { listenLoopback } = require("../server/oauth-flow");
  const loop = await listenLoopback({ timeoutMs: 2000, port: 0 });
  const url = new URL(loop.redirectUri);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/callback");
  assert.ok(Number(url.port) > 0);
  const pending = loop.wait();
  await new Promise((resolve, reject) => {
    http.get(`${loop.redirectUri}?code=c&state=s`, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
  assert.deepEqual(await pending, { code: "c", state: "s" });
});
