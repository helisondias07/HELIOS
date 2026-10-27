"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../server/index");
const { createAccountStore, sdkAdapters } = require("../server/accounts");
const contas = require("../renderer/contas");

const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Adaptador falso do "login real": não fala com o Cursor, só imita o contrato (URL https, depois chave). */
function fakeRealAdapters({ finish = true, fail = null } = {}) {
  const calls = { login: 0 };
  return {
    calls,
    adapters: {
      async validateKey() { return { email: null, keyName: "k" }; },
      login({ onUrl, signal }) {
        calls.login += 1;
        onUrl("https://cursor.com/loginDeepControl?challenge=x&uuid=y&mode=login&redirectTarget=cli");
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
          if (fail) setTimeout(() => reject(new Error(fail)), 5);
          else if (finish) setTimeout(() => resolve({ apiKey: "crsr_login_falsa_000999", email: "a@b.c", expiresAt: null }), 5);
        });
      },
    },
  };
}

test("o endereço demo=1 não existe mais e o modo demonstração nunca aponta para cursor.com", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server", "accounts.js"), "utf8");
  assert.equal(/demo=1/.test(source), false);
  let seen = null;
  const mock = sdkAdapters({ mock: true });
  return mock.login({ onUrl: (url) => { seen = url; }, signal: new AbortController().signal }).then(() => {
    assert.ok(seen);
    assert.equal(new URL(seen).hostname.endsWith(".invalid"), true);
  });
});

test("o adaptador real usa o login oficial do SDK sem abrir navegador por conta própria", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server", "accounts.js"), "utf8");
  assert.match(source, /Cursor\.auth\.login\(\{/);
  assert.match(source, /openBrowser:\s*false/);
  assert.match(source, /onLoginUrl:\s*onUrl/);
});

test("login pelo navegador: só aceita https, conclui e guarda conta sem mostrar a chave", async () => {
  const { adapters } = fakeRealAdapters();
  const opened = [];
  const accounts = createAccountStore({ adapters });
  accounts.events.on("login-url", (url) => opened.push(url));
  const started = accounts.startLogin();
  assert.equal(started.status, "waiting");
  await wait(60);
  const status = accounts.loginStatus();
  assert.equal(status.status, "done");
  assert.match(status.url, /^https:\/\/cursor\.com\/loginDeepControl\?/);
  assert.equal(opened.length, 1);
  const list = accounts.list();
  assert.equal(list.length, 1);
  assert.equal(JSON.stringify(list).includes("crsr_login_falsa"), false);
});

test("login com endereço que não é https não vira link", async () => {
  const accounts = createAccountStore({ adapters: { async validateKey() {}, login({ onUrl }) { onUrl("javascript:alert(1)"); return new Promise(() => {}); } } });
  accounts.startLogin();
  assert.equal(accounts.loginStatus().url, null);
  accounts.cancelLogin();
});

test("login cancelado ou com erro mostra mensagem clara e sugere a chave de API", async () => {
  const waiting = fakeRealAdapters({ finish: false });
  const a = createAccountStore({ adapters: waiting.adapters });
  a.startLogin();
  a.cancelLogin();
  await wait(20);
  assert.equal(a.loginStatus().status, "cancelled");
  assert.equal(a.list().length, 0);

  const failing = fakeRealAdapters({ fail: "network down" });
  const b = createAccountStore({ adapters: failing.adapters });
  b.startLogin();
  await wait(40);
  assert.equal(b.loginStatus().status, "error");
  assert.match(b.loginStatus().error, /chave de API/);
});

test("login que ninguém conclui expira sozinho em vez de ficar esperando para sempre", async () => {
  const hung = fakeRealAdapters({ finish: false });
  const accounts = createAccountStore({ adapters: hung.adapters, loginTimeoutMs: 30 });
  accounts.startLogin();
  await wait(90);
  assert.equal(accounts.loginStatus().status, "error");
  assert.match(accounts.loginStatus().error, /tempo/);
});

test("login respeita o limite de 3 contas", () => {
  const { adapters } = fakeRealAdapters();
  const accounts = createAccountStore({ adapters, initial: {} });
  return (async () => {
    for (const key of ["crsr_k1_000000000001", "crsr_k2_000000000002", "crsr_k3_000000000003"]) await accounts.addApiKey({ apiKey: key });
    assert.throws(() => accounts.startLogin(), /3 contas/);
  })();
});

test("no modo demonstração o servidor não abre navegador nenhum e avisa que é demonstração", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-login-"));
  const opened = [];
  const app = await startServer({ dataDir, projectsDir: path.join(dataDir, "projetos"), port: 0, mock: true, routineMs: 0, openExternal: (url) => opened.push(url) });
  try {
    const headers = { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}` };
    const res = await fetch(`${app.url}/api/accounts/login`, { method: "POST", headers, body: "{}" });
    assert.equal(res.status, 200);
    await wait(120);
    const body = await (await fetch(`${app.url}/api/accounts`, { headers })).json();
    assert.equal(body.demo, true);
    assert.deepEqual(opened, []);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("tela: botão principal de login, estados honestos e chave de API como alternativa", () => {
  const data = { accounts: [], max: 3, slotNames: ["Conta 1", "Conta 2", "Conta 3"], demo: false };
  const models = { mock: true, auto: { label: "a", level: "b", reason: "c" }, estimates: [] };
  const html = contas.accountsHtml(data, models, null, esc);
  assert.match(html, /id="doLogin"[^>]*>Entrar com o Cursor pelo navegador/);
  assert.match(html, /Ou use uma chave de API/);
  assert.match(html, /name="apiKey"/);
  assert.equal(/demo=1/.test(html), false);

  const waiting = contas.loginStateHtml({ status: "waiting", url: "https://cursor.com/loginDeepControl?x=1" }, false, esc);
  assert.match(waiting, /Aguardando você entrar no navegador/);
  assert.match(waiting, /abrir o link de novo/);
  assert.match(waiting, /id="cancelLogin"/);

  const failed = contas.loginStateHtml({ status: "error", error: "deu ruim" }, false, esc);
  assert.match(failed, /não deu certo/);
  assert.match(failed, /chave de API/);

  const demo = contas.loginStateHtml(null, true, esc);
  assert.match(demo, /Modo demonstração/);
  assert.match(demo, /não abre o Cursor de verdade/);
});