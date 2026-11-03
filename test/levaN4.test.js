"use strict";
// LEVA N4: card de uso igual oasis (%, Renova em N dias, sem US$/baldes no display).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SAMPLE_PERIOD, parseCurrentPeriodUsage, createMockCursorUsage } = require("../server/cursor-usage");
const { createAccountUsage } = require("../server/account-usage");
const contas = require("../renderer/contas");
const { startServer } = require("../server/index");

const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "helios-levan4-"));
const KEY = "crsr_chave_falsa_conta_levaN4aa";
const NOW = Date.parse("2026-10-31T15:00:00.000Z");

function weeklyFixture(nowMs = Date.now()) {
  const end = nowMs + 6 * 86400000;
  const start = end - 7 * 86400000;
  return {
    billingCycleStart: String(start),
    billingCycleEnd: String(end),
    planUsage: {
      totalSpend: 420,
      includedSpend: 420,
      bonusSpend: 0,
      remaining: 1580,
      limit: 2000,
      autoPercentUsed: 57,
      apiPercentUsed: 20,
      totalPercentUsed: 57,
    },
    spendLimitUsage: {
      totalSpend: 0,
      individualLimit: 10000,
      individualUsed: 0,
      individualRemaining: 10000,
      limitType: "user",
    },
    enabled: true,
    displayMessage: "fixture",
    autoModelSelectedDisplayMessage: "fixture included",
  };
}

const realCu = (over = {}) => ({
  source: "real",
  showBar: true,
  percent: 57,
  limit: { kind: "usd", value: 20 },
  remaining: { kind: "usd", value: 15.8, usedCents: 420, max: 20 },
  used: { totalTokens: 100, costInformado: true, costCents: 40, runs: 1 },
  limiteRotulo: null,
  nextResetAt: new Date(NOW + 6 * 86400000).toISOString(),
  period: { type: "weekly", resetDay: 5 },
  pools: { autoPercent: 57, apiPercent: 20 },
  real: {
    status: "ok",
    remainingCents: 1580,
    limitCents: 2000,
    usedCents: 420,
    cycleStart: new Date(NOW - 1 * 86400000).toISOString(),
    cycleEnd: new Date(NOW + 6 * 86400000).toISOString(),
  },
  manualLimit: null,
  me: { email: "a@example.test", name: "Ana", apiKeyName: "HELIOS" },
  ...over,
});

test("levaN4: pct() e daysLeft iguais ao oasis", () => {
  assert.equal(contas.pct(0.4), "<1%");
  assert.equal(contas.pct(5.5), "5,5%");
  assert.equal(contas.pct(57), "57%");
  // oasis: n≥10 → 0 casas (12,5 vira 13%)
  assert.equal(contas.pct(12.5), "13%");
  assert.equal(contas.pct(9.2), "9,2%");
  assert.equal(contas.daysLeft(new Date(NOW + 6 * 86400000).toISOString(), NOW), 6);
  assert.equal(contas.daysLeft(new Date(NOW + 0.5 * 86400000).toISOString(), NOW), 1);
  assert.equal(contas.daysLeft(new Date(NOW - 1000).toISOString(), NOW), 0);
  assert.equal(contas.renewLabel(new Date(NOW + 6 * 86400000).toISOString(), NOW), "Renova em 6 dias");
  assert.equal(contas.renewLabel(new Date(NOW + 1 * 86400000).toISOString(), NOW), "Renova amanhã");
  assert.equal(contas.renewLabel(new Date(NOW).toISOString(), NOW), "Renova hoje");
});

test("levaN4: usageTopPercent = max(auto, api); senao used/limit; senao percent", () => {
  assert.equal(contas.usageTopPercent(realCu()), 57);
  assert.equal(contas.usageTopPercent(realCu({ pools: { autoPercent: 12.5, apiPercent: 30 } })), 30);
  assert.equal(contas.usageTopPercent(realCu({
    pools: null,
    percent: null,
    real: { status: "ok", usedCents: 500, limitCents: 2000, remainingCents: 1500 },
  })), 25);
  assert.equal(contas.usageTopPercent(realCu({
    pools: { autoPercent: null, apiPercent: null },
    percent: 41,
    remaining: null,
    limit: null,
    real: { status: "ok", usedCents: null, limitCents: null },
  })), 41);
});

test("levaN4: periodKind semanal se ciclo ≤ 10 dias", () => {
  assert.equal(contas.periodKind(realCu()), "weekly");
  assert.equal(contas.periodKind(realCu({
    real: {
      status: "ok",
      usedCents: 1,
      limitCents: 100,
      cycleStart: "2026-10-01T00:00:00.000Z",
      cycleEnd: "2026-10-31T00:00:00.000Z",
    },
  })), "monthly");
  assert.equal(contas.periodKind({ period: { type: "monthly" }, real: {} }), "monthly");
});

test("levaN4: card HTML — 57% usado, Renova em 6 dias, caption, sem US$ no corpo", () => {
  const html = contas.cursorBarHtml(
    {
      id: "acc_1",
      active: true,
      localUsage: { today: { chamadas: 1, tokens: 5 }, week: { chamadas: 3, tokens: 15 } },
      cursorUsage: realCu(),
    },
    "acc_1",
    esc,
    true,
    NOW,
  );
  assert.match(html, /class="acct-uso"/);
  assert.match(html, /Limite de uso semanal/);
  assert.match(html, /<strong>57%<\/strong>\s*<span class="muted">usado<\/span>/);
  assert.match(html, /acct-bar-active/);
  assert.match(html, /style="width:57%"/);
  assert.match(html, /Renova em 6 dias/);
  assert.match(html, /Uso incluído na sua assinatura\. Renova toda semana\./);
  assert.match(html, /Definir limite manual/);
  assert.match(html, /<details class="acct-limit-wrap">/);
  assert.doesNotMatch(html, /acct-uso-pct[\s\S]{0,80}US\$/);
  assert.doesNotMatch(html, /class="muted acct-pools"/);
  assert.match(html, /title="[^"]*US\$/);
  // N4b: chips saem do card; ficam no acct-head (teste em levaN4b).
  assert.doesNotMatch(html, /acct-uso[\s\S]*?mais restante/);
  assert.doesNotMatch(html, /acct-uso[\s\S]*?dados de teste/);
  assert.match(html, /Definir limite manual[\s\S]*acct-secondary/);
});

test("levaN4: fallback — Uso indisponível agora, sem %, form expandido", () => {
  const html = contas.cursorBarHtml(
    {
      id: "acc_2",
      active: false,
      localUsage: { today: { chamadas: 0, tokens: 0 }, week: { chamadas: 0, tokens: 0 } },
      cursorUsage: {
        source: "indisponivel",
        showBar: false,
        percent: null,
        limit: null,
        remaining: null,
        used: { totalTokens: 0, costInformado: false, costRotulo: "custo não informado pelo SDK", runs: 0 },
        limiteRotulo: "Uso indisponível agora: fixture",
        nextResetAt: null,
        period: { type: "weekly", resetDay: 5 },
        pools: null,
        real: { status: "error", error: "Uso indisponível agora: fixture" },
        manualLimit: null,
        me: null,
      },
    },
    null,
    esc,
    false,
    NOW,
  );
  assert.match(html, /acct-uso-fail/);
  assert.match(html, /Limite de uso semanal/);
  assert.match(html, /Uso indisponível agora/);
  assert.doesNotMatch(html, /<strong>\d/);
  assert.doesNotMatch(html, /usado<\/span>/);
  assert.doesNotMatch(html, /acct-bar/);
  assert.match(html, /acct-limit-open/);
  assert.doesNotMatch(html, /<details class="acct-limit-wrap"/);
  assert.doesNotMatch(html, /Definir limite manual/);
});

test("levaN4: tidy em layout.js isenta bloco de conta / acct-uso", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "layout.js"), "utf8");
  assert.match(src, /\.acct,\s*#accountList/);
  assert.match(src, /acct-uso/);
  assert.match(src, /acct-uso-cap/);
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "style.css"), "utf8");
  assert.match(css, /\.acct-uso\s*\{/);
  assert.match(css, /height:\s*4px/);
  assert.match(css, /\.acct-bar-active\s*>\s*span\s*\{\s*background:\s*var\(--helios-ouro\)/);
});

test("levaN4: SAMPLE_PERIOD 57/20; account-usage usa max(auto,api)", async () => {
  assert.equal(SAMPLE_PERIOD.planUsage.autoPercentUsed, 57);
  assert.equal(SAMPLE_PERIOD.planUsage.apiPercentUsed, 20);
  const v = parseCurrentPeriodUsage(SAMPLE_PERIOD);
  assert.equal(v.autoPercent, 57);
  assert.equal(v.apiPercent, 20);

  const dir = tmp();
  const cursorUsage = createMockCursorUsage({ default: weeklyFixture(NOW) });
  const au = createAccountUsage(dir, { now: () => NOW, cursorUsage });
  await au.refreshMe("acc_a", KEY, { force: true });
  const st = au.status("acc_a");
  assert.equal(st.source, "real");
  assert.equal(st.percent, 57);
  assert.equal(st.pools.autoPercent, 57);
  assert.equal(st.pools.apiPercent, 20);
});

test("levaN4: servidor mock — card 57% e Renova em 6 dias", async () => {
  const dataDir = tmp();
  const fix = weeklyFixture(Date.now());
  const app = await startServer({
    dataDir,
    projectsDir: path.join(dataDir, "projetos"),
    port: 0,
    mock: true,
    routineMs: 0,
    mockUsage: { default: fix, byKey: {} },
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
    await json("/api/accounts/key", { method: "POST", body: { apiKey: KEY, label: "Conta A" } });
    const refreshed = await json("/api/accounts/usage/refresh", { method: "POST", body: {} });
    assert.equal(refreshed.status, 200);
    const row = refreshed.body.accounts.find((a) => a.label === "Conta A") || refreshed.body.accounts[0];
    assert.equal(row.cursorUsage.source, "real");
    assert.equal(row.cursorUsage.percent, 57);
    assert.equal(row.cursorUsage.pools.autoPercent, 57);
    assert.equal(contas.daysLeft(row.cursorUsage.real.cycleEnd), 6);

    const html = contas.accountsHtml(
      { ...refreshed.body, demo: true, usage: { note: "x" }, slotNames: ["Conta A", "Conta B", "Conta C"], max: 3 },
      { mock: true, auto: { label: "x", level: "padrao", reason: "t" }, estimates: [] },
      null,
      esc,
    );
    assert.match(html, /<strong>57%<\/strong>/);
    assert.match(html, /Renova em 6 dias/);
    assert.match(html, /Limite de uso semanal/);
    assert.match(html, /Renova toda semana/);
    assert.doesNotMatch(html, /You've used/);
  } finally {
    await app.close();
  }
});
