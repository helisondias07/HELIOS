"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../server/index");
const { createGmailClient, waitForCode, extractCode, codeQuery } = require("../server/gmail");
const mail = require("../server/vagas-email");
const { createJobs } = require("../server/jobs");
const { createAssistants, BUILTINS } = require("../server/assistants");
const { createConectores, GOOGLE_SETUP } = require("../server/conectores");
const { createVault } = require("../src/vault-store");
const { createCodeReader, codeScript } = require("../src/code-reader");
const { partitionFor, mergePlatforms } = require("../src/jobs-host");
const { PLATFORMS } = require("../server/jobs");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `helios-levag-${p}-`));
const R = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const b64 = (s) => Buffer.from(s).toString("base64url");

function fakeGmail(messages) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("/messages")) return { ok: true, status: 200, json: async () => ({ messages: messages.map((m) => ({ id: m.id })) }) };
    const id = decodeURIComponent(u.pathname.split("/").pop());
    const m = messages.find((x) => x.id === id);
    return { ok: true, status: 200, json: async () => ({ id: m.id, internalDate: String(m.at), snippet: m.body.slice(0, 50), payload: { headers: [{ name: "Subject", value: m.subject }, { name: "From", value: m.from }], mimeType: "text/plain", body: { data: b64(m.body) } } }) };
  };
  return { fetchImpl, calls };
}

test("leva G: extractCode pega o código e a busca usa remetente + newer_than:10m", () => {
  assert.equal(extractCode("Seu código de verificação é 482913. Não compartilhe."), "482913");
  assert.equal(extractCode("Code: AB12CD", /code:\s*([A-Z0-9]{6})/i), "AB12CD");
  assert.equal(extractCode("Sem nada aqui 2026"), "");
  const q = codeQuery({ from: "linkedin.com" });
  assert.match(q, /from:\(?linkedin\.com/);
  assert.match(q, /newer_than:10m/);
});

test("leva G: waitForCode ignora e-mail anterior ao login e acha o novo, sem logar o código", async () => {
  const since = 1_000_000;
  const { fetchImpl } = fakeGmail([
    { id: "old", at: since - 5000, subject: "Código", from: "x@linkedin.com", body: "Seu código é 111111" },
    { id: "new", at: since + 3000, subject: "Código", from: "x@linkedin.com", body: "Seu código é 654321" },
  ]);
  const client = createGmailClient({ fetchImpl, getAuthorization: async () => "Bearer t" });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    const got = await waitForCode({ clients: [client], from: "linkedin.com", since, intervalMs: 1, timeoutMs: 50 });
    assert.equal(got.code, "654321");
  } finally { console.log = orig; }
  assert.equal(logs.some((l) => l.includes("654321")), false);
  const none = await waitForCode({ clients: [createGmailClient({ fetchImpl: fakeGmail([{ id: "o", at: 1, subject: "c", from: "a", body: "123456" }]).fetchImpl, getAuthorization: async () => "Bearer t" })], since, intervalMs: 1, timeoutMs: 5, sleep: async () => {} });
  assert.equal(none.code, "");
  assert.match(none.motivo, /não chegou/);
});

test("leva G: o leitor de código injeta na página e não devolve o código", async () => {
  let injected = "";
  const reader = createCodeReader({
    getAccounts: () => [{ id: "g1", label: "pessoal" }],
    getAuthorization: async () => "Bearer t",
    wait: async () => ({ code: "778899" }),
  });
  const out = await reader.fillCode({ executeJavaScript: async (js) => { injected = js; return true; } }, { from: "gupy", since: 0 });
  assert.deepEqual(out, { ok: true });
  assert.match(injected, /778899/);
  assert.equal(JSON.stringify(out).includes("778899"), false);
  assert.match(codeScript("1234"), /one-time-code/);
  const empty = createCodeReader({ getAccounts: () => [], getAuthorization: async () => "" });
  assert.equal((await empty.fillCode({}, {})).ok, false);
});

test("leva G: resumo do Gmail pula e-mail de código", async () => {
  const { fetchImpl } = fakeGmail([
    { id: "a", at: 10, subject: "Seu código de verificação", from: "no@site.com", body: "123456" },
    { id: "b", at: 11, subject: "Infelizmente não seguiremos com sua candidatura", from: "rh@acme.com", body: "buscamos inglês fluente" },
  ]);
  const reader = createCodeReader({ getAccounts: () => [{ id: "g1", label: "p" }], getAuthorization: async () => "Bearer t", fetchImpl });
  const r = await reader.scanInbox();
  assert.equal(r.ok, true);
  assert.deepEqual(r.emails.map((e) => e.id), ["b"]);
});

test("leva G: classificação de e-mails de vagas e padrões das recusas", () => {
  assert.equal(mail.classify({ subject: "Seu código de acesso", snippet: "use 123456" }), "codigo");
  assert.equal(mail.classify({ subject: "Atualização da sua candidatura", snippet: "Infelizmente optamos por seguir com outros candidatos" }), "recusa");
  assert.equal(mail.classify({ subject: "Teste técnico — prazo 3 dias", snippet: "" }), "teste");
  const p = mail.patterns(["Buscamos inglês avançado", "Precisa de inglês e testes", "Experiência com Next.js"]);
  assert.equal(p.total, 3);
  assert.equal(p.top[0].termo.includes("ingl"), true);
  assert.ok(p.sugestoes.length >= 1);
});

test("leva G: recusa tira a vaga da lista ativa, guarda o motivo e entra no resumo", async () => {
  const t = Date.parse("2026-10-30T11:00:00Z");
  const jobs = createJobs(tmp("jobs"), { mock: true, now: () => t, readProfile: () => "React" });
  jobs.setPrefs({ termos: "desenvolvedor front-end", notaMinima: 0 });
  await jobs.search();
  const v = jobs.list()[0];
  assert.ok(v);
  const r = jobs.ingestEmails([{ id: "m1", from: `RH <rh@${v.company.toLowerCase().replace(/\W/g, "")}.com>`, subject: `Sua candidatura na ${v.company}`, snippet: "Infelizmente não seguiremos. Buscamos inglês fluente.", at: t }]);
  assert.equal(r.recusas, 1);
  jobs.markRejected(v.id, "Pediram inglês fluente");
  assert.equal(jobs.get(v.id).status, "recusada");
  assert.ok(jobs.rejections().length >= 1);
  const d = jobs.digest(t);
  assert.match(d, /Recusas hoje: [1-9]/);
  assert.equal(/\b\d{6}\b/.test(JSON.stringify(jobs.rejections())), false);
});

test("leva G: Vagas, Lojas Wake e Portfólio nascem uma vez, com pasta e contexto importado", () => {
  const dir = tmp("ast");
  const a = createAssistants(dir);
  a.seedBuiltins();
  for (const id of ["vagas", "lojas-wake", "portfolio"]) assert.ok(a.get(id), id);
  assert.ok(fs.existsSync(path.join(a.folderOf("vagas"), "arquivos")));
  a.remove("portfolio");
  a.seedBuiltins();
  assert.equal(a.get("portfolio"), null, "removido não volta");
  const out = a.importContext("vagas", "Sou dev front-end. token sk-ABCDEF1234567890ABCDEF");
  assert.ok(out.chars > 0);
  assert.match(a.importedText("vagas"), /dev front-end/);
  assert.equal(BUILTINS.length, 6); // O1: +chefe, pesquisa, oasis
  for (const id of ["chefe", "pesquisa", "oasis"]) assert.ok(a.get(id), id);
});

test("leva G: trocar a conta do Cursor mantém assistentes, contexto e conversas", async () => {
  const dataDir = tmp("conta");
  const app = await startServer({ dataDir, projectsDir: path.join(dataDir, "p"), port: 0, mock: true, routineMs: 0, searchWeb: async (q) => ({ query: q, results: [] }) });
  const api = async (method, p, body) => {
    const res = await fetch(`${app.url}${p}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return res.json();
  };
  try {
    await api("POST", "/api/assistants/vagas/importar", { texto: "Contexto fixo das vagas" });
    const a = await api("POST", "/api/accounts/key", { apiKey: "crsr_chave_falsa_conta_a_000111" });
    const b = await api("POST", "/api/accounts/key", { apiKey: "crsr_chave_falsa_conta_b_000222" });
    const before = await api("GET", "/api/assistants");
    const convs0 = await api("GET", "/api/conversations");
    await api("POST", "/api/accounts/active", { id: b.account.id });
    const after = await api("GET", "/api/assistants");
    assert.deepEqual(after.assistants.map((x) => x.id), before.assistants.map((x) => x.id));
    for (const id of ["vagas", "lojas-wake", "portfolio"]) assert.ok(after.assistants.some((x) => x.id === id), id);
    assert.match((await api("GET", "/api/assistants/vagas/importado")).texto, /Contexto fixo/);
    assert.deepEqual(await api("GET", "/api/conversations"), convs0);
    await api("POST", "/api/accounts/active", { id: a.account.id });
    assert.match((await api("GET", "/api/assistants/vagas/importado")).texto, /Contexto fixo/);
  } finally { app.close(); }
});

test("leva G: Gmail pede client próprio com passos e prazo; com o cofre fica pronto", async () => {
  let user = {};
  const c = createConectores({ dataDir: tmp("con"), mcp: { list: () => [], add: () => {}, remove: () => {} }, getUserClients: () => user });
  await c.ready();
  const gmail = () => c.view().presets.find((p) => p.id === "gmail");
  if (gmail().configured === false) {
    assert.equal(gmail().setup, "google");
    assert.equal(GOOGLE_SETUP.prazo, "2026-11-11");
    assert.ok(GOOGLE_SETUP.passos.some((p) => /agente de IA/.test(p)));
  }
  user = { google: "123-abc.apps.googleusercontent.com", googleSecret: "GOCSPX-x" };
  assert.notEqual(gmail().configured, false);
});

test("leva G: ClickUp recusando o cadastro (DCR) dá erro curto e registra no log", async () => {
  const logs = [];
  const J = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("oauth-protected-resource")) return J(200, { resource: "https://mcp.clickup.com/mcp", authorization_servers: ["https://auth.exemplo.test"] });
    if (u.includes("oauth-authorization-server") || u.includes("openid-configuration")) return J(200, { issuer: "https://auth.exemplo.test", authorization_endpoint: "https://auth.exemplo.test/a", token_endpoint: "https://auth.exemplo.test/t", registration_endpoint: "https://auth.exemplo.test/r", code_challenge_methods_supported: ["S256"] });
    if (u.endsWith("/r")) return J(400, { error: "invalid_client_metadata" });
    return J(401, {}, { "www-authenticate": 'Bearer resource_metadata="https://mcp.clickup.com/.well-known/oauth-protected-resource"' });
  };
  const c = createConectores({ dataDir: tmp("dcr"), mcp: { list: () => [], add: () => {}, remove: () => {} }, fetchImpl, log: (l) => logs.push(l), listen: async () => ({ port: 1, redirectUri: "http://127.0.0.1:1/cb", wait: () => new Promise(() => {}), close: () => {} }) });
  await c.ready();
  c.start("clickup", {});
  for (let i = 0; i < 50 && !c.view().connections.some((x) => x.status === "error"); i += 1) await new Promise((r) => setTimeout(r, 20));
  const item = c.view().connections.find((x) => x.presetId === "clickup");
  assert.ok(item, "conexão criada");
  assert.equal(item.status, "error");
  assert.ok(item.error.length < 140, item.error);
  assert.match(item.error, /recusou o cadastro do HELIOS/);
  assert.ok(logs.length >= 1);
});

test("leva G: plataformas no cofre herdam a senha padrão e o cartão do chat não leva senha", async () => {
  const dir = tmp("vault");
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`x${s}`), decryptString: (b) => b.toString().slice(1) };
  const vault = await createVault({ dir, safeStorage });
  await vault.setKey("plataformaEmail", "eu@exemplo.test");
  await vault.setKey("plataformaSenha", "S3nh@-Padrao");
  const saved = await vault.savePlatform({ nome: "Gupy", url: "https://login.gupy.io/candidates/signin" });
  assert.equal(saved.senhaDefinida, true);
  const list = vault.platforms();
  assert.equal(list[0].usuario, "eu@exemplo.test");
  assert.equal(JSON.stringify(list).includes("S3nh@"), false);
  assert.equal(JSON.stringify(vault.list()).includes("S3nh@"), false);
  assert.equal(vault.platformCredential(vault.getLogin(saved.id)).senha, "S3nh@-Padrao");
  await assert.rejects(() => vault.savePlatform({ nome: "Ruim", url: "http://x" }));
  assert.equal(await vault.removePlatform("gupy"), true);
  const bot = R("server/bot.js");
  const line = bot.split("\n").find((l) => l.includes("const cardArgs"));
  assert.equal(/senha|password/.test(line), false);
});

test("leva G: partição única das vagas e plataformas do cofre entram na lista", () => {
  assert.equal(partitionFor("linkedin"), "persist:vagas");
  assert.equal(partitionFor("gupy"), partitionFor("linkedin"));
  const merged = mergePlatforms(PLATFORMS, [{ id: "l1", nome: "Vagas.com", url: "https://www.vagas.com.br/login" }, { id: "l2", nome: "LinkedIn", url: "https://www.linkedin.com/login" }]);
  assert.ok(merged["vagas-com"]);
  assert.equal(merged.linkedin.entryId, "l2");
});

test("leva G: UI curta — voz/nível no popover, chave de API recolhida, Gmail guiado, feed com aviso no tooltip", () => {
  const app = R("renderer/app.js");
  assert.match(app, /id="chatPop" hidden/);
  const header = app.slice(app.indexOf('<div class="panel thread">'), app.indexOf('id="chatPop"'));
  assert.equal(header.includes("voice.ui.options()"), false);
  assert.match(app, /data-ast-imp=/);
  assert.match(app, /id="vaultPlat"/);
  assert.match(app, /id="vgManha"/);
  assert.match(app, /id="vgFeed" title="[^"]*termos do LinkedIn/);
  const contas = require("../renderer/contas");
  const html = contas.accountsHtml({ accounts: [], max: 3, slotNames: ["Conta A"], usage: {} }, { mock: true, auto: { label: "x", level: "y", reason: "z" } }, null, (v) => String(v ?? ""));
  assert.match(html, /Entrar com o Cursor pelo navegador/);
  assert.match(html, /<details class="acct-key">/);
  const { galleryHtml } = require("../renderer/conectores");
  const g = galleryHtml({ presets: [{ id: "gmail", name: "Gmail", blurb: "x", configured: false, setup: "google", googleSetup: GOOGLE_SETUP }], connections: [], cursor: {} }, (v) => String(v ?? ""));
  assert.match(g, /Configurar/);
  assert.match(g, /data-google-setup/);
  assert.match(g, /11\/11\/2026/);
  assert.equal(R("renderer/meeting/index.html").includes("chatPop"), false);
});

test("leva G: verificação da manhã pelo chat e rotina diária", () => {
  const index = R("server/index.js");
  for (const a of ["vagas_verificacao_manha", "plataforma_salvar", "assistente_importar", "/api/routines/vagas-manha"]) assert.match(index, new RegExp(a.replace(/\//g, "\\/")));
  const bot = R("server/bot.js");
  assert.match(bot, /verificação dessa manhã|verificacao/i);
});
