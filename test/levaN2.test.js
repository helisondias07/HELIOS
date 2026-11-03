"use strict";
// LEVA N2: uso real por conta (exchange + GetCurrentPeriodUsage), fallback manual, UI e mock.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseCurrentPeriodUsage,
  createCursorUsage,
  createMockCursorUsage,
  loadMockUsageFixture,
  jwtExpiryMs,
  USAGE_PATH,
  EXCHANGE_PATH,
  SAMPLE_PERIOD,
} = require("../server/cursor-usage");
const { createAccountUsage } = require("../server/account-usage");
const contas = require("../renderer/contas");
const { startServer } = require("../server/index");

const KEY_A = "crsr_chave_falsa_conta_a_levaN2aa";
const KEY_B = "crsr_chave_falsa_conta_b_levaN2bb";
const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "helios-levan2-"));

const SAMPLE = {
  billingCycleStart: "1768399334000",
  billingCycleEnd: "1771077734000",
  planUsage: {
    totalSpend: 23222,
    includedSpend: 23222,
    bonusSpend: 0,
    remaining: 16778,
    limit: 40000,
    autoPercentUsed: 0,
    apiPercentUsed: 46.444,
    totalPercentUsed: 15.48,
  },
  spendLimitUsage: {
    totalSpend: 0,
    individualLimit: 10000,
    individualUsed: 0,
    individualRemaining: 10000,
    limitType: "user",
  },
  enabled: true,
  displayMessage: "You've used 46% of your usage limit",
  autoModelSelectedDisplayMessage: "You've used 15% of your included total usage",
};

const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const p = new URL(url).pathname;
    const h = handlers[p];
    if (!h) return new Response("{}", { status: 404 });
    const r = await h({ url, init, n: calls.filter((c) => new URL(c.url).pathname === p).length });
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

test("levaN2: parseCurrentPeriodUsage — total%, baldes, centavos; sem inventar", () => {
  const v = parseCurrentPeriodUsage(SAMPLE);
  assert.equal(v.status, "ok");
  assert.equal(v.percent, 15.5);
  assert.equal(v.autoPercent, 0);
  assert.equal(v.apiPercent, 46.4);
  assert.equal(v.usedCents, 23222);
  assert.equal(v.limitCents, 40000);
  assert.equal(v.remainingCents, 16778);
  assert.equal(v.onDemandCents, 0);
  assert.equal(v.cycleEnd, new Date(1771077734000).toISOString());

  const fromSpend = parseCurrentPeriodUsage({ planUsage: { includedSpend: 500, limit: 2000 } });
  assert.equal(fromSpend.status, "ok");
  assert.equal(fromSpend.bucket, "included");
  assert.equal(fromSpend.percent, 25);
  assert.equal(fromSpend.remainingCents, 1500);

  for (const body of [{}, null, { planUsage: {} }, { planUsage: { limit: 0, includedSpend: 0 } }, { planUsage: { totalPercentUsed: "NaN" } }]) {
    const e = parseCurrentPeriodUsage(body);
    assert.equal(e.status, "empty");
    assert.equal(e.percent, null);
  }
});

test("levaN2: jwtExpiryMs e exchange+usage com fetch mockado (cache, force, 401 retry)", async () => {
  assert.equal(jwtExpiryMs(jwt({ exp: 2000000000 })), 2000000000 * 1000);
  assert.equal(jwtExpiryMs("abc"), null);

  let t = 1_000_000;
  const f = fakeFetch({
    [EXCHANGE_PATH]: () => ({ accessToken: jwt({ exp: Math.floor(t / 1000) + 3600 }) }),
    [USAGE_PATH]: () => SAMPLE,
  });
  const u = createCursorUsage({ fetchImpl: f, baseUrl: "https://api2.example", now: () => t });
  const v = await u.get({ id: "acc_1", apiKey: "crsr_secret_key_123" });
  assert.equal(v.status, "ok");
  assert.equal(v.percent, 15.5);
  assert.ok(!JSON.stringify(v).includes("crsr_secret"));
  await u.get({ id: "acc_1", apiKey: "crsr_secret_key_123" });
  assert.equal(f.calls.length, 2);
  t += 5_000;
  await u.get({ id: "acc_1", apiKey: "crsr_secret_key_123" }, { force: true });
  assert.equal(f.calls.length, 3);

  const retry = fakeFetch({
    [EXCHANGE_PATH]: () => ({ accessToken: "tok-sem-exp" }),
    [USAGE_PATH]: ({ n }) => (n === 1 ? new Response("{}", { status: 401 }) : SAMPLE),
  });
  assert.equal((await createCursorUsage({ fetchImpl: retry }).get({ id: "a", apiKey: "k_1234567890" })).status, "ok");

  const bad = createCursorUsage({ fetchImpl: fakeFetch({ [EXCHANGE_PATH]: () => new Response("{}", { status: 401 }) }) });
  assert.equal((await bad.get({ id: "b", apiKey: "k_bad" })).status, "auth");

  const down = createCursorUsage({
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
  });
  assert.equal((await down.get({ id: "a", apiKey: "k" })).status, "error");
  assert.deepEqual(await down.get(null), { status: "no-account" });
});

test("levaN2: account-usage prefere remainingCents real; manual só no fallback", async () => {
  const dir = tmp();
  const cursorUsage = createMockCursorUsage({
    default: SAMPLE,
    byKey: { levaN2bb: { __status: "error", error: "Uso indisponível agora: fixture" } },
  });
  const au = createAccountUsage(dir, { now: () => Date.parse("2026-10-31T12:00:00-03:00"), cursorUsage });
  await au.refreshMe("acc_a", KEY_A, { force: true });
  await au.refreshMe("acc_b", KEY_B, { force: true });

  const a = au.status("acc_a");
  assert.equal(a.source, "real");
  assert.equal(a.showBar, true);
  assert.equal(a.remaining.kind, "usd");
  assert.ok(Math.abs(a.remaining.value - 167.78) < 0.01);
  assert.equal(a.real.remainingCents, 16778);
  assert.equal(a.pools.autoPercent, 0);
  assert.equal(a.pools.apiPercent, 46.4);
  assert.ok(a.nextResetAt);

  au.setLimit("acc_b", { kind: "tokens", value: 1000 });
  au.record("acc_b", { totalTokens: 200, inputTokens: 200, outputTokens: 0 });
  const b = au.status("acc_b");
  assert.equal(b.source, "manual");
  assert.equal(b.percent, 20);
  assert.equal(b.real.status, "error");

  const decorated = au.decorateList([
    { id: "acc_a", label: "A", active: true, hasKey: true },
    { id: "acc_b", label: "B", active: false, hasKey: true },
  ]);
  assert.equal(decorated.maisRestanteId, "acc_a");
  assert.ok(au.remainingScore(a) > au.remainingScore(b));
});

test("levaN2: HELIOS_MOCK_USAGE carrega fixture; SAMPLE sem dados reais", () => {
  const builtIn = loadMockUsageFixture("1");
  assert.ok(builtIn.default.planUsage);
  assert.equal(builtIn.default.planUsage.limit, SAMPLE_PERIOD.planUsage.limit);

  const file = path.join(tmp(), "usage-fix.json");
  fs.writeFileSync(file, JSON.stringify({
    default: SAMPLE,
    byKey: { err: { __status: "auth", error: "Entre de novo" } },
  }));
  const fromFile = loadMockUsageFixture(file);
  assert.equal(fromFile.default.planUsage.limit, 40000);
  assert.equal(fromFile.byKey.err.__status, "auth");
});

test("levaN2: UI — barra real, baldes, fallback, checkbox alinhado, sem emoji", () => {
  const realAcc = {
    id: "acc_1",
    label: "Conta A",
    active: true,
    hasKey: true,
    kind: "apiKey",
    kindLabel: "Chave de API",
    localUsage: { today: { chamadas: 0, tokens: 0 }, week: { chamadas: 0, tokens: 0 } },
    cursorUsage: {
      source: "real",
      showBar: true,
      percent: 43,
      limit: { kind: "usd", value: 20 },
      remaining: { kind: "usd", value: 11.5, usedCents: 850, max: 20 },
      used: { totalTokens: 200, costInformado: true, costCents: 40, runs: 2 },
      limiteRotulo: null,
      nextResetAt: "2026-11-07T03:00:00.000Z",
      period: { type: "weekly", resetDay: 5 },
      pools: { autoPercent: 12.5, apiPercent: 30 },
      real: { status: "ok", remainingCents: 1150, limitCents: 2000, usedCents: 850 },
      manualLimit: null,
      me: { email: "a@example.test", name: "Ana", apiKeyName: "HELIOS" },
    },
  };
  const errAcc = {
    id: "acc_2",
    label: "Conta B",
    active: false,
    hasKey: true,
    kind: "apiKey",
    kindLabel: "Chave de API",
    localUsage: { today: { chamadas: 0, tokens: 0 }, week: { chamadas: 0, tokens: 0 } },
    cursorUsage: {
      source: "indisponivel",
      showBar: false,
      percent: null,
      limit: null,
      remaining: null,
      used: { totalTokens: 10, costInformado: false, costRotulo: "custo não informado pelo SDK", runs: 1 },
      limiteRotulo: "Uso indisponível agora: fixture",
      nextResetAt: "2026-11-07T03:00:00.000Z",
      period: { type: "weekly", resetDay: 5 },
      pools: null,
      real: { status: "error", error: "Uso indisponível agora: fixture" },
      manualLimit: null,
      me: null,
    },
  };
  const html = contas.accountsHtml(
    { accounts: [realAcc, errAcc], max: 3, slotNames: ["Conta A", "Conta B", "Conta C"], autoSwitch: false, maisRestanteId: "acc_1", demo: true, usage: { note: "x", realLimitUrl: "https://cursor.com/dashboard" } },
    { mock: true, auto: { label: "demo", level: "padrao", reason: "teste" }, estimates: [] },
    null,
    esc,
  );
  assert.match(html, /acct-bar-active/);
  assert.match(html, /class="acct-uso"/);
  assert.match(html, /<strong>30%<\/strong>/);
  assert.match(html, /title="[^"]*US\$ 8,50 de US\$ 20,00 usados/);
  assert.doesNotMatch(html, /class="muted acct-pools"/);
  assert.match(html, /acct-secondary/);
  assert.match(html, /SDK:/);
  assert.match(html, /Uso no HELIOS:/);
  assert.match(html, /Uso indisponível agora/);
  assert.match(html, /class="check acct-auto"/);
  assert.match(html, /Definir limite manual/);
  assert.match(html, /acct-limit-wrap/);
  assert.match(html, /acctRefresh/);
  assert.match(html, /dados de teste/);
  assert.doesNotMatch(html, /😀|🎉|🚀/);
});

test("levaN2: API refresh com mockUsage fixture fictícia", async () => {
  const dataDir = tmp();
  const app = await startServer({
    dataDir,
    projectsDir: path.join(dataDir, "projetos"),
    port: 0,
    mock: true,
    routineMs: 0,
    mockUsage: { default: SAMPLE, byKey: {} },
  });
  try {
    const json = async (pathname, opts = {}) => {
      const res = await fetch(`${app.url}${pathname}`, {
        method: opts.method || "GET",
        headers: { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}` },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      return { status: res.status, body: await res.json() };
    };
    await json("/api/accounts/key", { method: "POST", body: { apiKey: KEY_A, label: "Conta A" } });
    const refreshed = await json("/api/accounts/usage/refresh", { method: "POST", body: {} });
    assert.equal(refreshed.status, 200);
    const row = refreshed.body.accounts.find((a) => a.label === "Conta A") || refreshed.body.accounts[0];
    assert.equal(row.cursorUsage.source, "real");
    assert.equal(row.cursorUsage.real.remainingCents, 16778);
    assert.equal(row.cursorUsage.pools.apiPercent, 46.4);
    assert.equal(refreshed.body.autoSwitch, false);
  } finally {
    await app.close();
  }
});
