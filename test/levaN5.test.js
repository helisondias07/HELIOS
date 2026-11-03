"use strict";
// LEVA N5: uso com % sem limitCents; motivo curto sob "Uso indisponível agora".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAccountUsage } = require("../server/account-usage");
const { createCursorUsage, EXCHANGE_PATH, USAGE_PATH } = require("../server/cursor-usage");
const contas = require("../renderer/contas");

const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "helios-levan5-"));

/** Resposta real vista nas contas login do HELIOS: % sem limit/includedSpend. */
const PCT_ONLY = {
  billingCycleStart: "1761852761384",
  billingCycleEnd: "1762457561384",
  planUsage: {
    autoPercentUsed: 60.3,
    apiPercentUsed: 0,
    totalPercentUsed: 60.3,
  },
};

test("levaN5: % sem limitCents → source real + barra (não 'indisponível')", async () => {
  const dir = tmp();
  const au = createAccountUsage(dir, {
    cursorUsage: {
      async get() {
        return {
          status: "ok",
          percent: 60.3,
          autoPercent: 60.3,
          apiPercent: 0,
          usedCents: null,
          limitCents: null,
          remainingCents: null,
          cycleStart: new Date(1761852761384).toISOString(),
          cycleEnd: new Date(1762457561384).toISOString(),
          fetchedAt: new Date().toISOString(),
        };
      },
    },
  });
  await au.refreshMe("acc_login", "crsr_fake_key_levaN5_aaaaaaaa", { force: true });
  const st = au.status("acc_login");
  assert.equal(st.source, "real");
  assert.equal(st.showBar, true);
  assert.equal(st.percent, 60);
  assert.equal(st.pools.autoPercent, 60.3);
  assert.equal(st.pools.apiPercent, 0);
  assert.equal(st.limit, null);
  assert.equal(st.remaining, null);
  assert.ok(st.nextResetAt);
  assert.equal(st.exhausted, false);

  // 100% sem centavos → esgotada
  au.setRealView("acc_full", {
    status: "ok",
    percent: 100,
    autoPercent: 100,
    apiPercent: 0,
    limitCents: null,
    usedCents: null,
    remainingCents: null,
  });
  assert.equal(au.status("acc_full").exhausted, true);
  assert.equal(au.status("acc_full").percent, 100);
});

test("levaN5: parse + exchange devolve % sem limit e account-usage aceita", async () => {
  const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
  const fetchImpl = async (url) => {
    const p = new URL(url).pathname;
    if (p === EXCHANGE_PATH) {
      return new Response(JSON.stringify({ accessToken: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (p === USAGE_PATH) {
      return new Response(JSON.stringify(PCT_ONLY), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  const usage = createCursorUsage({ fetchImpl, ttlMs: 0, minForceMs: 0 });
  const view = await usage.get({ id: "a", apiKey: "crsr_key_pct_only_levaN5xx" }, { force: true });
  assert.equal(view.status, "ok");
  assert.equal(view.percent, 60.3);
  assert.equal(view.limitCents, null);

  const dir = tmp();
  const au = createAccountUsage(dir, { cursorUsage: usage });
  await au.refreshMe("acc_a", "crsr_key_pct_only_levaN5xx", { force: true });
  assert.equal(au.status("acc_a").source, "real");
  assert.equal(au.status("acc_a").showBar, true);
});

test("levaN5: motivo curto em status.reason e no HTML do card", () => {
  const dir = tmp();
  const au = createAccountUsage(dir, { cursorUsage: { async get() { return { status: "error", error: "HTTP 500" }; } } });
  au.setRealView("acc_e", { status: "error", error: "HTTP 500", fetchedAt: new Date().toISOString() });
  const st = au.status("acc_e");
  assert.equal(st.source, "indisponivel");
  assert.equal(st.reason, "HTTP 500");

  au.setRealView("acc_auth", { status: "auth", error: "chave recusada (401)" });
  assert.equal(au.status("acc_auth").source, "auth");
  assert.match(au.status("acc_auth").reason || au.status("acc_auth").real.error, /chave recusada \(401\)/);

  au.setRealView("acc_net", { status: "error", error: "sem conexão com o Cursor (tempo esgotado)" });
  assert.equal(au.status("acc_net").reason, "sem conexão");

  const htmlFail = contas.cursorBarHtml({
    id: "acc_1",
    active: false,
    cursorUsage: {
      source: "indisponivel",
      showBar: false,
      percent: null,
      reason: "chave recusada (401)",
      limiteRotulo: "chave recusada (401)",
      real: { status: "error", error: "chave recusada (401)" },
      period: { type: "weekly" },
      me: null,
    },
  }, null, esc);
  assert.match(htmlFail, /Uso indisponível agora/);
  assert.match(htmlFail, /chave recusada \(401\)/);
  assert.match(htmlFail, /acct-uso-fail-reason/);

  const htmlOk = contas.cursorBarHtml({
    id: "acc_2",
    active: true,
    cursorUsage: {
      source: "real",
      showBar: true,
      percent: 60,
      pools: { autoPercent: 60.3, apiPercent: 0 },
      real: {
        status: "ok",
        percent: 60.3,
        autoPercent: 60.3,
        apiPercent: 0,
        cycleStart: new Date(Date.now() - 86400000).toISOString(),
        cycleEnd: new Date(Date.now() + 6 * 86400000).toISOString(),
      },
      nextResetAt: new Date(Date.now() + 6 * 86400000).toISOString(),
      period: { type: "weekly" },
      me: { name: "Helison Dias" },
    },
  }, null, esc, false, Date.now());
  assert.match(htmlOk, /60%/);
  assert.match(htmlOk, /usado/);
  assert.doesNotMatch(htmlOk, /Uso indisponível agora/);
});

test("levaN5: mais restante por % quando não há centavos", () => {
  const dir = tmp();
  const au = createAccountUsage(dir, {});
  au.setRealView("acc_low", {
    status: "ok", percent: 20, autoPercent: 20, apiPercent: 0, limitCents: null, remainingCents: null,
  });
  au.setRealView("acc_high", {
    status: "ok", percent: 90, autoPercent: 90, apiPercent: 0, limitCents: null, remainingCents: null,
  });
  const decorated = au.decorateList([
    { id: "acc_high", label: "Alta", active: false },
    { id: "acc_low", label: "Baixa", active: true },
  ]);
  assert.equal(decorated.maisRestanteId, "acc_low");
});
