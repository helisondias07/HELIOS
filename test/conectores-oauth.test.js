"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createConectores, GITHUB_LOOPBACK_PORT } = require("../server/conectores");
const { loadOAuthClients } = require("../server/oauth-clients");
const { galleryHtml } = require("../renderer/conectores");
const { createAccountStore, KEY_PAGE } = require("../server/accounts");
const { listenLoopback, pkce, sameState } = require("../server/oauth-flow");
const { createMcpRegistry } = require("../server/mcp-registry");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TOKEN = "access-token-de-teste-xyz";
const REFRESH = "refresh-token-de-teste-xyz";

function jsonRes(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    text: async () => JSON.stringify(body),
  };
}

function sealer() {
  return {
    available: () => true,
    seal: async (text) => Buffer.from(text, "utf8").toString("base64"),
    open: async (blob) => Buffer.from(blob, "base64").toString("utf8"),
  };
}

function scriptedFetch(steps) {
  return async (url, options = {}) => {
    const hit = steps.find((step) => step.match(url, options));
    if (!hit) throw new Error(`fetch sem roteiro: ${url}`);
    return hit.reply(url, options);
  };
}

test("PKCE S256 e o state do retorno precisam ser os mesmos", () => {
  const code = pkce();
  assert.equal(code.method, "S256");
  assert.notEqual(code.verifier, code.challenge);
  assert.equal(sameState("abc", "abc"), true);
  assert.equal(sameState("abc", "abd"), false);
  assert.equal(sameState("abc", "abcd"), false);
});

test("o loopback só aceita o callback em 127.0.0.1 e devolve o código", async () => {
  const loop = await listenLoopback({ timeoutMs: 2000 });
  const url = new URL(loop.redirectUri);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/callback");
  const pending = loop.wait();
  await new Promise((resolve, reject) => {
    const req = http.get(`${loop.redirectUri}?code=um&state=dois`, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
  });
  assert.deepEqual(await pending, { code: "um", state: "dois" });
});

test("OAuth de galeria: cadastro, PKCE, cofre e refresh sem vazar o token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-con-"));
  const seen = [];
  const box = { state: "" };
  const fetchImpl = scriptedFetch([
    { match: (url) => url === "https://mcp.clickup.com/mcp" || url === "https://mcp.linear.app/mcp" || url === "https://gmailmcp.googleapis.com/mcp/v1", reply: () => jsonRes(401, {}, { "www-authenticate": 'Bearer resource_metadata="https://mcp.exemplo.test/.well-known/oauth-protected-resource"' }) },
    { match: (url) => url.includes("oauth-protected-resource"), reply: () => jsonRes(200, { resource: "https://mcp.exemplo.test/mcp", authorization_servers: ["https://auth.exemplo.test"], scopes_supported: ["read"] }) },
    { match: (url) => url.includes("oauth-authorization-server"), reply: () => jsonRes(200, { authorization_endpoint: "https://auth.exemplo.test/authorize", token_endpoint: "https://auth.exemplo.test/token", registration_endpoint: "https://auth.exemplo.test/register", code_challenge_methods_supported: ["S256"] }) },
    { match: (url) => url.endsWith("/register"), reply: () => jsonRes(201, { client_id: "cliente-helios" }) },
    { match: (url, options) => url.endsWith("/token") && String(options.body || "").includes("authorization_code"), reply: (_url, options) => { seen.push(String(options.body)); return jsonRes(200, { access_token: TOKEN, refresh_token: REFRESH, expires_in: 3600, email: "a@exemplo.test" }); } },
    { match: (url) => url.endsWith("/token"), reply: () => jsonRes(200, { access_token: "access-novo-de-teste", expires_in: 30 }) },
  ]);
  const mcp = createMcpRegistry(dir, {
    sealer: sealer(),
    headerFor: (id) => gallery.authorization(id),
    connect: async (_name, cfg) => ({ tools: [], close() {}, headers: cfg.headers }),
  });
  const gallery = createConectores({
    dataDir: dir,
    sealer: sealer(),
    mcp,
    fetchImpl,
    oauthClients: { google: "123456-abc.apps.googleusercontent.com" },
    openExternal: async (url) => { box.url = url; box.state = new URL(url).searchParams.get("state"); },
    listen: async () => ({ redirectUri: "http://127.0.0.1:53682/callback", wait: async () => ({ code: "codigo", state: box.state }), close() {} }),
  });
  const started = gallery.start("clickup", { label: "Trabalho" });
  assert.equal(started.status, "waiting");
  let done = null;
  for (let i = 0; i < 20 && done?.status !== "connected"; i += 1) {
    await wait(15);
    done = gallery.view().connections.find((item) => item.id === started.id);
  }
  assert.equal(done.status, "connected", done && done.error);
  assert.equal(done.accountHint, "a@exemplo.test");
  assert.match(box.url, /code_challenge=/);
  assert.match(box.url, /code_challenge_method=S256/);
  assert.match(seen[0], /code_verifier=/);
  assert.match(seen[0], /redirect_uri=http%3A%2F%2F127.0.0.1/);
  const dumped = JSON.stringify(gallery.view()) + fs.readFileSync(gallery.file, "utf8") + JSON.stringify(mcp.list());
  assert.equal(dumped.includes(TOKEN), false);
  assert.equal(dumped.includes(REFRESH), false);
  const header = await gallery.authorization(done.id);
  assert.equal(header, `Bearer ${TOKEN}`);
  const again = await gallery.refresh(done.id);
  assert.equal(again.status, "connected");
  assert.equal(await gallery.authorization(done.id), "Bearer access-novo-de-teste");
  const renamed = gallery.rename(done.id, "Equipe");
  assert.equal(renamed.label, "Equipe");
  const second = gallery.start("gmail", { label: "Pessoal", clientId: "nao-usar.apps.googleusercontent.com" });
  assert.equal(second.presetId, "gmail");
  assert.equal(gallery.remove(done.id), true);
  assert.equal(gallery.view().connections.some((item) => item.id === done.id), false);
});

test("refresh inválido pede para entrar de novo e não guarda o erro com o token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-reauth-"));
  const fetchImpl = scriptedFetch([
    { match: (url) => url === "https://mcp.clickup.com/mcp" || url === "https://mcp.linear.app/mcp" || url === "https://gmailmcp.googleapis.com/mcp/v1", reply: () => jsonRes(401, {}, { "www-authenticate": 'Bearer resource_metadata="https://mcp.exemplo.test/.well-known/oauth-protected-resource"' }) },
    { match: (url) => url.includes("oauth-protected-resource"), reply: () => jsonRes(200, { resource: "https://mcp.exemplo.test/mcp", authorization_servers: ["https://auth.exemplo.test"] }) },
    { match: (url) => url.includes("oauth-authorization-server"), reply: () => jsonRes(200, { authorization_endpoint: "https://auth.exemplo.test/authorize", token_endpoint: "https://auth.exemplo.test/token", registration_endpoint: "https://auth.exemplo.test/register" }) },
    { match: (url) => url.endsWith("/register"), reply: () => jsonRes(201, { client_id: "cliente" }) },
    { match: (url, options) => String(options.body || "").includes("authorization_code"), reply: () => jsonRes(200, { access_token: TOKEN, refresh_token: REFRESH, expires_in: 30 }) },
    { match: () => true, reply: () => jsonRes(400, { error: "invalid_grant" }) },
  ]);
  const gallery = createConectores({
    dataDir: dir,
    sealer: sealer(),
    fetchImpl,
    openExternal: async (url) => { gallery._state = new URL(url).searchParams.get("state"); },
    listen: async () => ({ redirectUri: "http://127.0.0.1:9/callback", wait: async () => ({ code: "c", state: gallery._state }), close() {} }),
  });
  const started = gallery.start("linear");
  let connected = null;
  for (let i = 0; i < 20; i += 1) {
    await wait(15);
    connected = gallery.view().connections[0];
    if (connected?.status === "connected") break;
  }
  assert.equal(connected.status, "connected", connected.error);
  await assert.rejects(() => gallery.refresh(started.id), /Conecte de novo/);
  const item = gallery.view().connections[0];
  assert.equal(item.status, "reauth");
  assert.equal(JSON.stringify(item).includes(REFRESH), false);
});

test("login do Cursor: chave demo não vira conta; a página oficial de chaves é o plano B", async () => {
  const opened = [];
  const accounts = createAccountStore({
    allowDemoKeys: false,
    openKeyPage: (url) => opened.push(url),
    adapters: { async validateKey() { return { email: null }; }, async login() { return { apiKey: "demo_abcdef1234567890" }; } },
  });
  accounts.startLogin();
  await wait(30);
  assert.equal(accounts.list().length, 0);
  assert.equal(accounts.loginStatus().needsKey, true);
  assert.equal(opened[0], KEY_PAGE);
  assert.match(accounts.loginStatus().error, /demonstração/);
});

test("colar e adotar login local não devolvem a chave", async () => {
  const accounts = createAccountStore({
    adapters: { async validateKey() { return { email: "h@exemplo.test" }; }, async login() { throw new Error("não"); } },
  });
  const missed = await accounts.acceptClipboard("olá mundo");
  assert.equal(missed.found, false);
  const saved = await accounts.acceptClipboard("crsr_chave_valida_0000000001");
  assert.equal(saved.found, true);
  assert.equal(JSON.stringify(saved).includes("crsr_chave_valida_0000000001"), false);
  const adopted = await accounts.adoptLocal(JSON.stringify({ apiKey: "cursor_login_local_0000000002", email: "h@exemplo.test", apiKeyExpiresAtMs: Date.now() + 864e5 }));
  assert.equal(adopted.kind, "login");
  assert.equal(JSON.stringify(adopted).includes("cursor_login_local"), false);
  await assert.rejects(() => accounts.adoptLocal("{}"), /Não achei/);
});

test("sem client id no aplicativo o cartão não pede nada e o id não sai na API", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-cfg-"));
  const googleId = "123456-helios.apps.googleusercontent.com";
  const slackSecret = "aa11bb22cc33dd44ee";
  const empty = createConectores({ dataDir: dir });
  assert.equal(empty.view().presets.find((item) => item.id === "gmail").configured, false);
  assert.equal(empty.view().presets.find((item) => item.id === "github").configured, false);
  assert.equal(empty.view().presets.find((item) => item.id === "slack").configured, false);
  assert.equal(empty.view().presets.find((item) => item.id === "clickup").configured, true);
  assert.throws(() => empty.start("gmail", { clientId: googleId }), /não está disponível/);
  assert.equal(empty.view().connections.length, 0);
  const ready = createConectores({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "helios-cfg2-")),
    oauthClients: { google: googleId, slack: "1234567890.1234567890", slackSecret },
  });
  const view = JSON.stringify(ready.view());
  assert.equal(ready.view().presets.find((item) => item.id === "gmail").configured, true);
  assert.equal(ready.view().presets.find((item) => item.id === "gcalendar").configured, true);
  assert.equal(ready.view().presets.find((item) => item.id === "slack").configured, true);
  assert.equal(view.includes(googleId), false);
  assert.equal(view.includes(slackSecret), false);
  assert.equal(view.includes("clientId"), false);
});

test("o Gmail abre o navegador com o client id do aplicativo, não com um id colado", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-gmail-"));
  const googleId = "123456-helios.apps.googleusercontent.com";
  const box = {};
  const fetchImpl = scriptedFetch([
    { match: (url) => url === "https://gmailmcp.googleapis.com/mcp/v1", reply: () => jsonRes(401, {}, { "www-authenticate": 'Bearer resource_metadata="https://mcp.exemplo.test/.well-known/oauth-protected-resource"' }) },
    { match: (url) => url.includes("oauth-protected-resource"), reply: () => jsonRes(200, { resource: "https://gmailmcp.googleapis.com/mcp/v1", authorization_servers: ["https://accounts.google.com/"] }) },
    { match: (url) => url.includes("accounts.google.com"), reply: () => jsonRes(200, { authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth", token_endpoint: "https://oauth2.googleapis.com/token" }) },
  ]);
  const gallery = createConectores({
    dataDir: dir,
    oauthClients: { google: googleId },
    fetchImpl,
    openExternal: async (url) => { box.url = url; },
    listen: async () => ({ redirectUri: "http://127.0.0.1:9/callback", wait: () => new Promise(() => {}), close() {} }),
  });
  const started = gallery.start("gmail", { clientId: "evil.apps.googleusercontent.com" });
  assert.equal(started.label, "pessoal");
  for (let i = 0; i < 20 && !box.url; i += 1) await wait(15);
  assert.match(box.url, /client_id=123456-helios/);
  assert.equal(box.url.includes("evil"), false);
  assert.match(box.url, /access_type=offline/);
  assert.equal(box.url.includes("resource="), false);
});

test("o GitHub volta numa porta fixa, para o callback cadastrado uma vez", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-gh-"));
  const box = {};
  const gallery = createConectores({
    dataDir: dir,
    oauthClients: { github: "Iv1.abcdef0123456789" },
    fetchImpl: async () => { throw new Error("não chegou a descobrir"); },
    listen: async (opts) => { box.port = opts.port; throw Object.assign(new Error("parar"), { code: "STOP" }); },
  });
  gallery.start("github");
  for (let i = 0; i < 20 && box.port === undefined; i += 1) await wait(10);
  assert.equal(box.port, GITHUB_LOOPBACK_PORT);
  assert.equal(GITHUB_LOOPBACK_PORT, 47332);
});

test("a configuração lê o arquivo, a pasta de dados e a variável, e descarta id inválido", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-oauth-"));
  const shipped = path.join(dir, "shipped.json");
  const user = path.join(dir, "user.json");
  fs.writeFileSync(shipped, JSON.stringify({ google: "111111-shipped.apps.googleusercontent.com", github: "Iv1.shipped012345" }));
  fs.writeFileSync(user, JSON.stringify({ github: "Iv1.userfile012345", slackSecret: "aa11bb22cc33dd44ee" }));
  const fromFile = loadOAuthClients({ file: shipped, userFile: user, env: {} });
  assert.equal(fromFile.google, "111111-shipped.apps.googleusercontent.com");
  assert.equal(fromFile.github, "Iv1.userfile012345");
  assert.equal(fromFile.slackSecret, "aa11bb22cc33dd44ee");
  const fromEnv = loadOAuthClients({
    file: shipped,
    userFile: user,
    env: { HELIOS_GOOGLE_CLIENT_ID: "222222-env.apps.googleusercontent.com", HELIOS_GITHUB_CLIENT_ID: "cole uma chave" },
  });
  assert.equal(fromEnv.google, "222222-env.apps.googleusercontent.com");
  assert.equal(fromEnv.github, "Iv1.userfile012345");
  const bad = loadOAuthClients({ file: shipped, env: { HELIOS_GOOGLE_CLIENT_ID: "não é um client id" } });
  assert.equal(bad.google, "111111-shipped.apps.googleusercontent.com");
});

test("a grade tem busca, contas conectadas e um botão só, sem campo técnico", () => {
  const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const html = galleryHtml({
    presets: [
      { id: "gmail", name: "Gmail", blurb: "Lê a caixa de entrada.", configured: true },
      { id: "github", name: "GitHub", blurb: "Repositórios e perfil.", configured: false },
      { id: "clickup", name: "ClickUp", blurb: "Tarefas e documentos.", configured: true },
      { id: "cursor", name: "Cursor", blurb: "A conta que move o agente.", configured: true },
    ],
    connections: [
      { id: "g1", presetId: "gmail", label: "pessoal", status: "connected", accountHint: "ana@exemplo.test", error: "" },
      { id: "g2", presetId: "gmail", label: "agenciaoasis", status: "reauth", accountHint: "", error: "Esta conta precisa entrar de novo." },
      { id: "c1", presetId: "clickup", label: "trabalho", status: "waiting", accountHint: "", error: "" },
    ],
    cursor: { login: { status: "idle" }, accounts: [{ id: "acc_1", label: "Helison", email: "h@exemplo.test" }] },
  }, esc);
  assert.match(html, /id="connectSearch"/);
  assert.match(html, /Buscar conector/);
  assert.match(html, /Conectados/);
  assert.match(html, /Gmail — pessoal/);
  assert.match(html, /Gmail — agenciaoasis/);
  assert.match(html, /Adicionar outra conta/);
  assert.match(html, /Renomear/);
  assert.match(html, /Reconectar/);
  assert.match(html, /Remover/);
  assert.match(html, /Conectado/);
  assert.match(html, /Conectando…/);
  assert.match(html, /Em breve/);
  assert.match(html, /configuração do app pendente/);
  assert.match(html, /id="connectAdvanced"/);
  assert.match(html, /connectAdvancedPanel" hidden/);
  assert.equal(html.includes("clientId"), false);
  assert.equal(html.includes("apiKey"), false);
  assert.equal(html.includes("name=\"url\""), true);
  assert.equal((html.match(/name="url"/g) || []).length, 1);
});
