"use strict";
// LEVA N3: rótulo da barra a partir de used/limit/remaining/cycleEnd; form colapsável; linha secundária única.
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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "helios-levan3-"));
const KEY = "crsr_chave_falsa_conta_levaN3aa";

const realCu = (over = {}) => ({
  source: "real",
  showBar: true,
  percent: 21,
  limit: { kind: "usd", value: 20 },
  remaining: { kind: "usd", value: 15.8, usedCents: 420, max: 20 },
  used: { totalTokens: 100, costInformado: true, costCents: 40, runs: 1 },
  limiteRotulo: null,
  nextResetAt: "2026-11-28T15:00:00.000Z",
  period: { type: "weekly", resetDay: 5 },
  pools: { autoPercent: 12.5, apiPercent: 30 },
  real: {
    status: "ok",
    remainingCents: 1580,
    limitCents: 2000,
    usedCents: 420,
    cycleEnd: "2026-11-28T15:00:00.000Z",
  },
  manualLimit: null,
  me: { email: "a@example.test", name: "Ana", apiKeyName: "HELIOS" },
  ...over,
});

test("levaN3: SAMPLE_PERIOD tem números (420/2000/1580) e ciclo 28/11", () => {
  assert.equal(SAMPLE_PERIOD.planUsage.includedSpend, 420);
  assert.equal(SAMPLE_PERIOD.planUsage.limit, 2000);
  assert.equal(SAMPLE_PERIOD.planUsage.remaining, 1580);
  const v = parseCurrentPeriodUsage(SAMPLE_PERIOD);
  assert.equal(v.usedCents, 420);
  assert.equal(v.limitCents, 2000);
  assert.equal(v.remainingCents, 1580);
  assert.equal(v.cycleEnd, "2026-11-28T15:00:00.000Z");
  assert.equal(contas.fmtReinicia(v.cycleEnd), "28/11");
});

test("levaN3: fmtBarLabel — valores, ausências, nunca demo/message", () => {
  const full = contas.fmtBarLabel(realCu());
  assert.equal(full, "US$ 4,20 de US$ 20,00 usados · restam US$ 15,80 · reinicia 28/11");
  assert.doesNotMatch(full, /demo/i);
  assert.doesNotMatch(full, /You've used|displayMessage|message/i);

  const soUsedLim = contas.fmtBarLabel(realCu({
    real: { status: "ok", usedCents: 420, limitCents: 2000, remainingCents: null, cycleEnd: null },
    remaining: { kind: "usd", value: null, usedCents: 420, max: 20 },
    nextResetAt: null,
  }));
  assert.equal(soUsedLim, "US$ 4,20 de US$ 20,00 usados");

  const soRem = contas.fmtBarLabel({
    real: { status: "ok", usedCents: null, limitCents: null, remainingCents: 1580, cycleEnd: null },
    remaining: null,
    limit: null,
    nextResetAt: null,
  });
  assert.equal(soRem, "restam US$ 15,80");

  const soCiclo = contas.fmtBarLabel({
    real: { status: "ok", usedCents: null, limitCents: null, remainingCents: null, cycleEnd: "2026-11-28T15:00:00.000Z" },
    remaining: null,
    limit: null,
    nextResetAt: null,
  });
  assert.equal(soCiclo, "reinicia 28/11");

  const vazio = contas.fmtBarLabel({ real: { status: "empty" }, remaining: null, limit: null, nextResetAt: null });
  assert.equal(vazio, "");
});

test("levaN3: UI — rótulo com números, tag dados de teste, form colapsado vs expandido, linha secundária única", () => {
  const realAcc = {
    id: "acc_1",
    label: "Conta A",
    active: true,
    hasKey: true,
    kind: "apiKey",
    kindLabel: "Chave de API",
    localUsage: { today: { chamadas: 2, tokens: 10 }, week: { chamadas: 5, tokens: 50 } },
    cursorUsage: realCu(),
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
      me: { apiKeyName: "demo" },
    },
  };
  const html = contas.accountsHtml(
    {
      accounts: [realAcc, errAcc],
      max: 3,
      slotNames: ["Conta A", "Conta B", "Conta C"],
      autoSwitch: false,
      maisRestanteId: "acc_1",
      demo: true,
      usage: { note: "x", realLimitUrl: "https://cursor.com/dashboard" },
    },
    { mock: true, auto: { label: "demo", level: "padrao", reason: "teste" }, estimates: [] },
    null,
    esc,
  );

  // LEVA N4: card % (sem US$ no display; US$ só no title); max(12,5;30)=30%
  assert.match(html, /class="acct-uso"/);
  assert.match(html, /Limite de uso semanal/);
  assert.match(html, /<strong>30%<\/strong>/);
  assert.match(html, /title="[^"]*US\$ 4,20 de US\$ 20,00 usados/);
  assert.match(html, /dados de teste/);
  assert.doesNotMatch(html, /acct-me[^>]*>demo</);
  assert.doesNotMatch(html, />demo</);
  assert.doesNotMatch(html, /acct-uso-pct">[^<]*US\$/);
  assert.doesNotMatch(html, /acct-uso-renew">[^<]*US\$/);

  // Conta A (real): details fechado com link; Conta B (erro): wrap aberto sem details/link (N4b)
  assert.match(html, /data-acct="acc_1"[\s\S]*?<details class="acct-limit-wrap">[\s\S]*?Definir limite manual/);
  assert.match(html, /data-acct="acc_2"[\s\S]*?acct-limit-open/);
  assert.match(html, /data-acct="acc_2"[\s\S]*?Uso indisponível agora/);
  assert.doesNotMatch(html, /data-acct="acc_2"[\s\S]*?acct-bar/);
  assert.doesNotMatch(html, /data-acct="acc_2"[\s\S]*?Definir limite manual/);
  assert.doesNotMatch(html, /acct-bar-indeterminate/);

  // Uma linha secundária com HELIOS + SDK (não duas linhas separadas acct-sdk + usage)
  assert.match(html, /acct-secondary/);
  assert.match(html, /Uso no HELIOS:[\s\S]*?· SDK:/);
  assert.doesNotMatch(html, /class="muted acct-sdk"/);
  assert.equal((html.match(/class="muted acct-secondary"/g) || []).length, 2);

  assert.doesNotMatch(html, /class="muted acct-pools"/);
  assert.doesNotMatch(html, /😀|🎉|🚀/);
});

test("levaN3: mock server — barra real com números da SAMPLE; form colapsado", async () => {
  const dataDir = tmp();
  const app = await startServer({
    dataDir,
    projectsDir: path.join(dataDir, "projetos"),
    port: 0,
    mock: true,
    routineMs: 0,
    mockUsage: { default: SAMPLE_PERIOD, byKey: {} },
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
    assert.equal(row.cursorUsage.real.usedCents, 420);
    assert.equal(row.cursorUsage.real.limitCents, 2000);
    assert.equal(row.cursorUsage.real.remainingCents, 1580);

    const html = contas.accountsHtml(
      { ...refreshed.body, demo: true, usage: { note: "x" }, slotNames: ["Conta A", "Conta B", "Conta C"], max: 3 },
      { mock: true, auto: { label: "x", level: "padrao", reason: "t" }, estimates: [] },
      null,
      esc,
    );
    assert.match(html, /class="acct-uso"/);
    assert.match(html, /<strong>57%<\/strong>/);
    assert.match(html, /title="[^"]*US\$ 4,20/);
    assert.match(html, /dados de teste/);
    assert.match(html, /<details class="acct-limit-wrap">/);
    assert.doesNotMatch(html, /You've used/);
  } finally {
    await app.close();
  }
});

test("levaN3: falha real → form já expandido; account-usage não usa message no status", async () => {
  const dir = tmp();
  const cursorUsage = createMockCursorUsage({
    default: { __status: "error", error: "Uso indisponível agora: fixture" },
  });
  const au = createAccountUsage(dir, { now: () => Date.parse("2026-10-31T12:00:00-03:00"), cursorUsage });
  await au.refreshMe("acc_e", KEY, { force: true });
  const st = au.status("acc_e");
  assert.equal(st.source, "indisponivel");
  assert.ok(st.real?.error);
  assert.equal(st.real.message, undefined);

  const html = contas.cursorBarHtml(
    {
      id: "acc_e",
      active: false,
      localUsage: { today: { chamadas: 0, tokens: 0 }, week: { chamadas: 0, tokens: 0 } },
      cursorUsage: st,
    },
    null,
    esc,
    false,
  );
  assert.match(html, /acct-limit-open/);
  assert.doesNotMatch(html, /<details class="acct-limit-wrap"/);
  assert.doesNotMatch(html, /Definir limite manual/);
  assert.match(html, /Uso indisponível agora/);
  assert.doesNotMatch(html, /acct-bar/);
  assert.doesNotMatch(html, /acct-bar-indeterminate/);
  assert.match(html, /acct-secondary/);
});
