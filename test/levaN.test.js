"use strict";
// LEVA N: barra de uso por conta Cursor — acumulação SDK, período, limite manual, ordenação, auto-troca.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAccountUsage, nextResetAt, LIMITE_NAO_INFORMADO, CUSTO_NAO_INFORMADO } = require("../server/account-usage");
const { createAccountStore, sdkAdapters } = require("../server/accounts");
const { extractSdkUsage } = require("../server/sdk-usage");
const contas = require("../renderer/contas");
const { startServer } = require("../server/index");

const KEY_A = "crsr_chave_falsa_conta_a_levaN001";
const KEY_B = "crsr_chave_falsa_conta_b_levaN002";
const KEY_C = "crsr_chave_falsa_conta_c_levaN003";
const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "helios-levan-"));

test("levaN: acumula tokens e custo por conta; sem inventar custo", () => {
  const dir = tmp();
  let clock = Date.parse("2026-10-31T12:00:00-03:00");
  const au = createAccountUsage(dir, { now: () => clock });
  au.record("acc_a", { usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, cost: { rawCostCents: 12, chargedCents: 10 } });
  au.record("acc_a", { inputTokens: 20, outputTokens: 5, totalTokens: 25 });
  const st = au.status("acc_a");
  assert.equal(st.used.totalTokens, 175);
  assert.equal(st.used.costInformado, true);
  assert.equal(st.used.costCents, 10);
  assert.equal(st.used.runs, 2);

  au.record("acc_b", { inputTokens: 40, outputTokens: 10, totalTokens: 50 });
  const b = au.status("acc_b");
  assert.equal(b.used.totalTokens, 50);
  assert.equal(b.used.costInformado, false);
  assert.equal(b.used.costRotulo, CUSTO_NAO_INFORMADO);
  assert.equal(b.percent, null);
  assert.equal(b.limiteRotulo, LIMITE_NAO_INFORMADO);
  assert.equal(b.showBar, false);
});

test("levaN: período semanal/mensal reseta e limpa o usado", () => {
  const dir = tmp();
  let clock = Date.parse("2026-10-29T10:00:00-03:00"); // quinta
  const au = createAccountUsage(dir, { now: () => clock });
  au.setPeriod("acc_a", { type: "weekly", resetDay: 5 }); // sexta
  au.record("acc_a", { totalTokens: 1000, inputTokens: 1000, outputTokens: 0 });
  assert.equal(au.status("acc_a").used.totalTokens, 1000);
  const next = au.status("acc_a").nextResetAt;
  assert.ok(next);
  clock = new Date(next).getTime() + 1000;
  const after = au.status("acc_a");
  assert.equal(after.used.totalTokens || 0, 0);
  assert.equal(after.used.runs, 0);

  au.setPeriod("acc_b", { type: "monthly", resetDay: 1 });
  au.record("acc_b", { totalTokens: 9, inputTokens: 9, outputTokens: 0 });
  clock = Date.parse("2026-12-01T00:00:01-03:00");
  assert.equal(au.status("acc_b").used.totalTokens || 0, 0);
});

test("levaN: limite manual em US$ ou tokens; sem limite não inventa percentual", () => {
  const dir = tmp();
  const au = createAccountUsage(dir, { now: () => Date.parse("2026-10-31T12:00:00-03:00") });
  au.record("acc_a", { usage: { totalTokens: 500, inputTokens: 500, outputTokens: 0 }, cost: { chargedCents: 250 } });
  assert.equal(au.status("acc_a").percent, null);
  au.setLimit("acc_a", { kind: "tokens", value: 1000 });
  const t = au.status("acc_a");
  assert.equal(t.percent, 50);
  assert.equal(t.remaining.kind, "tokens");
  assert.equal(t.remaining.value, 500);
  assert.equal(t.showBar, true);

  au.setLimit("acc_a", { kind: "usd", value: 5 });
  const u = au.status("acc_a");
  assert.equal(u.percent, 50);
  assert.equal(u.remaining.kind, "usd");
  assert.ok(Math.abs(u.remaining.value - 2.5) < 0.001);

  au.setLimit("acc_a", { clear: true });
  assert.equal(au.status("acc_a").percent, null);
  assert.equal(au.status("acc_a").limiteRotulo, LIMITE_NAO_INFORMADO);
});

test("levaN: ordenação — ativa no topo; mais restante quando há limite manual", () => {
  const dir = tmp();
  const au = createAccountUsage(dir, { now: () => Date.parse("2026-10-31T12:00:00-03:00") });
  au.setLimit("a", { kind: "tokens", value: 1000 });
  au.setLimit("b", { kind: "tokens", value: 1000 });
  au.setLimit("c", { kind: "tokens", value: 1000 });
  au.record("a", { totalTokens: 800, inputTokens: 800, outputTokens: 0 });
  au.record("b", { totalTokens: 100, inputTokens: 100, outputTokens: 0 });
  au.record("c", { totalTokens: 400, inputTokens: 400, outputTokens: 0 });
  const decorated = au.decorateList([
    { id: "a", label: "Conta A", active: true, hasKey: true },
    { id: "b", label: "Conta B", active: false, hasKey: true },
    { id: "c", label: "Conta C", active: false, hasKey: true },
  ]);
  assert.equal(decorated.accounts[0].id, "a");
  assert.equal(decorated.maisRestanteId, "b");
  assert.equal(decorated.accounts[1].id, "b");
  assert.equal(decorated.autoSwitch, false);
});

test("levaN: auto-troca desligada por padrão; liga e troca para mais restante", () => {
  const dir = tmp();
  const logs = [];
  const saved = [];
  const accounts = createAccountStore({
    adapters: sdkAdapters({ mock: true }),
    persist: (snap) => saved.push(snap),
    log: (line) => logs.push(line),
    dataDir: dir,
  });
  const au = createAccountUsage(dir, { now: () => Date.parse("2026-10-31T12:00:00-03:00"), log: (l) => logs.push(l) });
  assert.equal(au.getAutoSwitch(), false);

  // addApiKey is async
  return (async () => {
    const a = await accounts.addApiKey({ apiKey: KEY_A, label: "Conta A" });
    const b = await accounts.addApiKey({ apiKey: KEY_B, label: "Conta B" });
    accounts.setActive(a.id);
    au.setLimit(a.id, { kind: "tokens", value: 100 });
    au.setLimit(b.id, { kind: "tokens", value: 1000 });
    au.record(a.id, { totalTokens: 100, inputTokens: 100, outputTokens: 0 });
    au.record(b.id, { totalTokens: 10, inputTokens: 10, outputTokens: 0 });

    assert.equal(au.tryAutoSwitch({ accountsApi: accounts, fromId: a.id, reason: "teste" }), null);

    au.setAutoSwitch(true);
    const sw = au.tryAutoSwitch({ accountsApi: accounts, fromId: a.id, reason: "limite manual" });
    assert.ok(sw);
    assert.equal(sw.toId, b.id);
    assert.equal(accounts.active().id, b.id);
    assert.ok(au.recentSwitches().some((x) => x.toId === b.id));
    assert.ok(logs.some((l) => /auto-troca/i.test(l)));

    // erro 429/quota com auto ligada
    accounts.setActive(a.id);
    au.record(a.id, { totalTokens: 1, inputTokens: 1, outputTokens: 0 });
    const again = au.tryAutoSwitch({ accountsApi: accounts, fromId: a.id, reason: "limite/quota Cursor" });
    assert.ok(again);
    assert.equal(accounts.active().id, b.id);
  })();
});

test("levaN: UI mostra rótulo honesto, barra só com limite, auto-troca e Atualizar", () => {
  const withLimit = {
    id: "acc_1",
    label: "Conta A",
    active: true,
    hasKey: true,
    kind: "apiKey",
    kindLabel: "Chave de API",
    localUsage: { today: { chamadas: 0, tokens: 0 }, week: { chamadas: 0, tokens: 0 } },
    cursorUsage: {
      showBar: true,
      percent: 40,
      limit: { kind: "usd", value: 10 },
      remaining: { kind: "usd", value: 6, usedCents: 400, max: 10 },
      used: { totalTokens: 200, costInformado: true, costCents: 400, runs: 2 },
      limiteRotulo: null,
      nextResetAt: "2026-11-07T03:00:00.000Z",
      period: { type: "weekly", resetDay: 5 },
      me: { email: "a@example.test", name: "Ana", apiKeyName: "HELIOS" },
    },
  };
  const noLimit = {
    id: "acc_2",
    label: "Conta B",
    active: false,
    hasKey: true,
    kind: "apiKey",
    kindLabel: "Chave de API",
    localUsage: { today: { chamadas: 1, tokens: 0 }, week: { chamadas: 1, tokens: 0 } },
    cursorUsage: {
      showBar: false,
      percent: null,
      limit: null,
      remaining: null,
      used: { totalTokens: 50, costInformado: false, costRotulo: CUSTO_NAO_INFORMADO, runs: 1 },
      limiteRotulo: LIMITE_NAO_INFORMADO,
      nextResetAt: "2026-11-07T03:00:00.000Z",
      period: { type: "weekly", resetDay: 5 },
      me: null,
    },
  };
  const html = contas.accountsHtml(
    { accounts: [withLimit, noLimit], max: 3, slotNames: ["Conta A", "Conta B", "Conta C"], autoSwitch: false, maisRestanteId: "acc_1", demo: true, usage: { note: "x", realLimitUrl: "https://cursor.com/dashboard" } },
    { mock: true, auto: { label: "demo", level: "padrao", reason: "teste" }, estimates: [] },
    null,
    esc,
  );
  assert.match(html, /acct-bar-active/);
  assert.match(html, /class="acct-uso"/);
  assert.match(html, /Uso indisponível agora/);
  assert.match(html, /custo não informado pelo SDK/);
  assert.match(html, /acctAutoSwitch/);
  assert.match(html, /acctRefresh/);
  assert.match(html, /mais restante/);
  assert.match(html, /Trocar automaticamente/);
  assert.doesNotMatch(html, /😀|🎉|🚀/);
});

test("levaN: API accounts expõe cursorUsage, autoSwitch off e refresh", async () => {
  const dataDir = tmp();
  const app = await startServer({ dataDir, projectsDir: path.join(dataDir, "projetos"), port: 0, mock: true, routineMs: 0 });
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
    await json("/api/accounts/key", { method: "POST", body: { apiKey: KEY_B, label: "Conta B" } });
    await json("/api/accounts/key", { method: "POST", body: { apiKey: KEY_C, label: "Conta C" } });
    const list = await json("/api/accounts");
    assert.equal(list.status, 200);
    assert.equal(list.body.autoSwitch, false);
    assert.ok(Array.isArray(list.body.accounts));
    assert.ok(list.body.accounts[0].cursorUsage);
    assert.equal(list.body.accounts[0].cursorUsage.limiteRotulo, LIMITE_NAO_INFORMADO);

    const id = list.body.accounts[0].id;
    const lim = await json(`/api/accounts/${encodeURIComponent(id)}/limite`, { method: "POST", body: { kind: "tokens", value: 5000 } });
    assert.equal(lim.status, 200);
    assert.equal(lim.body.status.limit.kind, "tokens");

    app.accountUsage.record(id, { totalTokens: 100, inputTokens: 100, outputTokens: 0 });
    const refreshed = await json("/api/accounts/usage/refresh", { method: "POST", body: {} });
    assert.equal(refreshed.status, 200);
    const row = refreshed.body.accounts.find((a) => a.id === id);
    assert.ok(row.cursorUsage.used.totalTokens >= 100);

    const off = await json("/api/accounts/auto-switch", { method: "POST", body: { enabled: false } });
    assert.equal(off.body.autoSwitch, false);
    const on = await json("/api/accounts/auto-switch", { method: "POST", body: { enabled: true } });
    assert.equal(on.body.autoSwitch, true);

    const act = await json("/api/atividade");
    assert.ok(Array.isArray(act.body.contaTrocas));
  } finally {
    await app.close();
  }
});

test("levaN: extractSdkUsage e nextResetAt auxiliares", () => {
  const bare = extractSdkUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  assert.equal(bare.costInformado, false);
  assert.equal(bare.rotulo, CUSTO_NAO_INFORMADO);
  const withCost = extractSdkUsage({ totalTokens: 3, cost: { chargedCents: 7 } });
  assert.equal(withCost.costInformado, true);
  const iso = nextResetAt({ type: "weekly", resetDay: 1 }, Date.parse("2026-10-31T15:00:00-03:00"));
  assert.ok(iso);
});
