"use strict";
// LEVA Q: login automático em lote nas plataformas (silencioso, reserva, sem segredos).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { startServer } = require("../server/index");
const {
  classifyLoginResult,
  shouldTryReserva,
  RESERVA_EMAIL,
  mergePlatforms,
} = require("../src/jobs-host");
const { PLATFORMS } = require("../server/jobs");

const TOKEN = "token-de-teste-levaQ-xxxxxxxx";
/** Segredos reais / chaves proibidas no JSON (motivo "senha errada" é texto ok). */
function assertNoSecrets(payload) {
  const raw = JSON.stringify(payload);
  assert.ok(!/"senha"\s*:/i.test(raw));
  assert.ok(!/"password"\s*:/i.test(raw));
  assert.ok(!/"cookie"\s*:/i.test(raw));
  assert.ok(!/"cookies"\s*:/i.test(raw));
  assert.ok(!/"token"\s*:/i.test(raw));
  assert.ok(!/"authorization"\s*:/i.test(raw));
  assert.ok(!raw.includes(RESERVA_EMAIL));
  assert.ok(!raw.includes(TOKEN));
  assert.ok(!/Bearer\s+\S+/i.test(raw));
}

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `helios-levaQ-${name}-`));
}

async function call(server, method, pathname, body) {
  const res = await fetch(`${server.url}${pathname}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${server.apiToken()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function waitDone(server, { maxMs = 4000 } = {}) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const r = await call(server, "GET", "/api/vagas/login-todas");
    if (r.body && r.body.rodando === false && r.body.iniciado) return r.body;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("login-todas não terminou a tempo");
}

test("levaQ: classifyLoginResult e reserva", () => {
  assert.equal(classifyLoginResult({ ok: true }).status, "logado");
  assert.equal(classifyLoginResult({ ok: false, motivo: "captcha" }).motivo, "captcha");
  assert.equal(classifyLoginResult({ ok: false, motivo: "otp" }).motivo, "2FA não lido");
  assert.equal(classifyLoginResult({ ok: false, motivo: "google" }).motivo, "login só pelo Google");
  assert.equal(classifyLoginResult({ ok: false, motivo: "form" }).motivo, "formulário não achado");
  assert.equal(classifyLoginResult({ ok: false, motivo: "senha" }).motivo, "senha errada");
  assert.equal(RESERVA_EMAIL, "closedfps@gmail.com");
  assert.equal(shouldTryReserva({ status: "pendente", motivo: "senha errada" }), true);
  assert.equal(shouldTryReserva({ status: "pendente", motivo: "captcha" }), false);
  assert.equal(shouldTryReserva({ status: "logado", motivo: "" }), false);
});

test("levaQ: mergePlatforms inclui cofre + built-ins", () => {
  const merged = mergePlatforms(PLATFORMS, [
    { id: "p1", nome: "Catho", url: "https://www.catho.com.br/login" },
    { id: "p2", nome: "LinkedIn", url: "https://www.linkedin.com/login" },
  ]);
  assert.ok(merged.linkedin);
  assert.ok(merged.catho || merged["catho"]);
  assert.equal(merged.linkedin.loginUrl.includes("linkedin.com"), true);
});

test("levaQ: POST inicia lote; GET lê progresso; sem segredos", async () => {
  const calls = [];
  const platforms = {
    linkedin: { id: "linkedin", label: "LinkedIn", domains: ["linkedin.com"], loginUrl: "https://www.linkedin.com/login" },
    gupy: { id: "gupy", label: "Gupy", domains: ["gupy.io"], loginUrl: "https://login.gupy.io/candidates/signin" },
    demo: { id: "demo", label: "Demo Vagas", domains: ["exemplo.invalid"], loginUrl: "https://exemplo.invalid/login" },
  };
  const server = await startServer({
    dataDir: tmp("api"),
    mock: true,
    port: 0,
    routineMs: 0,
    chefeMs: 0,
    getApiToken: () => TOKEN,
    loginTodasPauseMs: 5,
    listVagasPlatforms: () => platforms,
    loginVagas: async (id, opts = {}) => {
      calls.push({ id, silent: opts.silent === true, usuario: opts.usuario || "" });
      assert.equal(opts.silent, true);
      if (id === "demo") return { ok: false, error: "O login não confirmou.", motivo: "senha" };
      if (id === "gupy") return { ok: false, error: "O site mostrou um captcha.", motivo: "captcha" };
      return { ok: true, message: "ok" };
    },
  });
  try {
    const denied = await fetch(`${server.url}/api/vagas/login-todas`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 401);

    const start = await call(server, "POST", "/api/vagas/login-todas", { reserva: false });
    assert.equal(start.status, 200);
    assert.equal(start.body.iniciado, true);
    assertNoSecrets(start.body);

    const done = await waitDone(server);
    assert.equal(done.rodando, false);
    assert.equal(done.resultados.length, 3);
    const byId = Object.fromEntries(done.resultados.map((r) => [r.id, r]));
    assert.equal(byId.linkedin.status, "logado");
    assert.equal(byId.linkedin.email, "principal");
    assert.equal(byId.gupy.status, "pendente");
    assert.equal(byId.gupy.motivo, "captcha");
    assert.equal(byId.demo.status, "pendente");
    assert.equal(byId.demo.motivo, "senha errada");
    assert.ok(calls.every((c) => c.silent));
    assert.ok(calls.every((c) => !c.usuario));
    assertNoSecrets(done);
    for (const row of done.resultados) {
      assert.deepEqual(Object.keys(row).sort(), ["email", "id", "label", "motivo", "status"]);
    }
  } finally {
    await server.close();
  }
});

test("levaQ: reserva=true repete só senha errada com usuario alternativo (sem gravar)", async () => {
  const calls = [];
  const platforms = {
    ok: { id: "ok", label: "Ok", domains: ["ok.invalid"], loginUrl: "https://ok.invalid/login" },
    bad: { id: "bad", label: "Bad", domains: ["bad.invalid"], loginUrl: "https://bad.invalid/login" },
    captcha: { id: "captcha", label: "Captcha", domains: ["cap.invalid"], loginUrl: "https://cap.invalid/login" },
  };
  const server = await startServer({
    dataDir: tmp("reserva"),
    mock: true,
    port: 0,
    routineMs: 0,
    chefeMs: 0,
    getApiToken: () => TOKEN,
    loginTodasPauseMs: 5,
    listVagasPlatforms: () => platforms,
    loginVagas: async (id, opts = {}) => {
      calls.push({ id, usuario: opts.usuario || "" });
      if (id === "ok") return { ok: true };
      if (id === "captcha") return { ok: false, motivo: "captcha", error: "captcha" };
      if (opts.usuario === RESERVA_EMAIL) return { ok: true, message: "reserva ok" };
      return { ok: false, motivo: "senha", error: "senha errada" };
    },
  });
  try {
    const start = await call(server, "POST", "/api/vagas/login-todas", { reserva: true, plataformas: ["ok", "bad", "captcha"] });
    assert.equal(start.body.iniciado, true);
    const done = await waitDone(server);
    const byId = Object.fromEntries(done.resultados.map((r) => [r.id, r]));
    assert.equal(byId.ok.status, "logado");
    assert.equal(byId.ok.email, "principal");
    assert.equal(byId.bad.status, "logado");
    assert.equal(byId.bad.email, "reserva");
    assert.equal(byId.captcha.status, "pendente");
    assert.equal(byId.captcha.motivo, "captcha");
    assert.equal(byId.captcha.email, "principal");
    const badCalls = calls.filter((c) => c.id === "bad");
    assert.equal(badCalls.length, 2);
    assert.equal(badCalls[0].usuario, "");
    assert.equal(badCalls[1].usuario, RESERVA_EMAIL);
    assert.equal(calls.filter((c) => c.id === "captcha").length, 1);
    assert.ok(!JSON.stringify(done).includes("senha-secreta"));
    assert.ok(!/"cookie"/i.test(JSON.stringify(done)));
  } finally {
    await server.close();
  }
});

test("levaQ: lote já rodando não reinicia; filtro de plataformas", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const platforms = {
    a: { id: "a", label: "A", domains: ["a.invalid"], loginUrl: "https://a.invalid/login" },
    b: { id: "b", label: "B", domains: ["b.invalid"], loginUrl: "https://b.invalid/login" },
  };
  const server = await startServer({
    dataDir: tmp("busy"),
    mock: true,
    port: 0,
    routineMs: 0,
    chefeMs: 0,
    getApiToken: () => TOKEN,
    loginTodasPauseMs: 5,
    listVagasPlatforms: () => platforms,
    loginVagas: async (id) => {
      if (id === "a") await gate;
      return { ok: true };
    },
  });
  try {
    const first = await call(server, "POST", "/api/vagas/login-todas", { plataformas: ["a", "b"] });
    assert.equal(first.body.iniciado, true);
    const second = await call(server, "POST", "/api/vagas/login-todas", {});
    assert.equal(second.body.iniciado, false);
    assert.match(String(second.body.motivo || ""), /já está rodando/i);
    release();
    const done = await waitDone(server);
    assert.equal(done.resultados.length, 2);
  } finally {
    release();
    await server.close();
  }
});

test("levaQ: backup e docs de operação", () => {
  assert.equal(fs.existsSync(path.join(ROOT, ".backup-levaQ")), false);
  assert.match(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"), /\.backup-\*\//);
  const acessos = fs.readFileSync(path.join(ROOT, "docs", "operacao", "acessos.md"), "utf8");
  const testes = fs.readFileSync(path.join(ROOT, "docs", "operacao", "testes-e-instalacao.md"), "utf8");
  const changelog = fs.readFileSync(path.join(ROOT, "docs", "operacao", "CHANGELOG.md"), "utf8");
  assert.match(acessos, /login-todas|login em lote|Leva Q/i);
  assert.match(testes, /levaQ|login-todas/i);
  assert.match(changelog, /Q —|Leva Q|login-todas/i);
  assert.ok(48221 >= 48221); // porta de ensaio do prompt (suite usa port: 0)
});

test("levaQ: plataformas .com.br do cofre nao se confundem pelo dominio", () => {
  const { mergePlatforms } = require("../src/jobs-host");
  const out = mergePlatforms({}, [
    { id: "a", nome: "Alfa", url: "https://www.alfa.com.br/login" },
    { id: "b", nome: "Beta", url: "https://beta.com.br/entrar" },
    { id: "c", nome: "Gama", url: "https://auth.vagas.gama.com.br/sign-in" },
  ]);
  assert.deepEqual(Object.keys(out).sort(), ["alfa", "beta", "gama"]);
  assert.equal(out.alfa.loginUrl, "https://www.alfa.com.br/login");
  assert.equal(out.gama.domains[0], "gama.com.br");
});

test("levaQ2: rotas abrir-login e sessoes existem no servidor", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "server", "index.js"), "utf8");
  assert.ok(src.includes("/api/vagas/abrir-login"));
  assert.ok(src.includes("/api/vagas/sessoes"));
});

test("levaQ4: popup do Google OAuth e permitida, outras nao", () => {
  const { isOAuthPopupUrl } = require("../src/jobs-host");
  assert.equal(isOAuthPopupUrl("https://accounts.google.com/o/oauth2/v2/auth?x=1"), true);
  assert.equal(isOAuthPopupUrl("about:blank"), true);
  assert.equal(isOAuthPopupUrl("https://ssl.gstatic.com/a.js"), true);
  assert.equal(isOAuthPopupUrl("https://www.linkedin.com/post/new"), false);
  assert.equal(isOAuthPopupUrl("http://accounts.google.com/"), false);
  assert.equal(isOAuthPopupUrl("https://accounts.google.com.evil.io/"), false);
});
