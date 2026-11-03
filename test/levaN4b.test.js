"use strict";
// LEVA N4b: chips fora do card; zero "Saiba mais" em .acct; fallback sem barra/details.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const contas = require("../renderer/contas");

const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const NOW = Date.parse("2026-10-31T15:00:00.000Z");

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

const failCu = () => ({
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
});

/** Replica tidy() N4b de layout.js. */
function applyTidy(rootEl) {
  rootEl.querySelectorAll("p.muted:not([id]), p.hint:not([id]), .lead:not([id])").forEach((p) => {
    if (p.dataset.lfTidy) return;
    const text = p.textContent.trim();
    if (text.length < 70 || p.closest(".msg, .message, .bubble, .status-line, .connect-account, form, .acct, #accountList, #keyForm, .acct-uso, .acct-limit-wrap, .acct-head")) return;
    if (p.classList.contains("acct-bar-label") || p.classList.contains("acct-secondary") || p.classList.contains("acct-pools") || p.classList.contains("acct-me") || p.classList.contains("acct-uso-cap") || p.classList.contains("acct-uso-renew") || p.classList.contains("acct-uso-title") || p.classList.contains("acct-uso-fail-msg")) return;
    p.dataset.lfTidy = "1";
    p.classList.add("lf-explain");
  });
  rootEl.querySelectorAll(".acct details, #accountList details").forEach((d) => {
    const sum = d.querySelector(":scope > summary");
    if (!sum) { d.replaceWith(...d.childNodes); return; }
    if (/^\s*▼?\s*Saiba mais\s*$/i.test(sum.textContent || "")) {
      sum.remove();
      d.replaceWith(...d.childNodes);
    }
  });
}

function loadDom() {
  try {
    const { JSDOM } = require("jsdom");
    return (html) => {
      const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
      return dom.window.document;
    };
  } catch { /* optional */ }
  try {
    const { Window } = require("happy-dom");
    return (html) => {
      const w = new Window({ url: "https://helios.local/" });
      w.document.body.innerHTML = html;
      return w.document;
    };
  } catch { /* optional */ }
  return null;
}

test("levaN4b: chips mais restante / dados de teste na linha do nome, não no card", () => {
  const html = contas.accountRowHtml(
    {
      id: "acc_1",
      label: "Conta A",
      active: true,
      hasKey: true,
      kind: "apiKey",
      kindLabel: "Chave de API",
      localUsage: { today: { chamadas: 1, tokens: 5 }, week: { chamadas: 3, tokens: 15 } },
      cursorUsage: realCu(),
    },
    esc,
    "acc_1",
    true,
  );
  assert.match(html, /acct-head[\s\S]*?mais restante/);
  assert.match(html, /acct-head[\s\S]*?dados de teste/);
  assert.match(html, /acct-uso-title">Limite de uso semanal</);
  assert.doesNotMatch(html, /acct-uso[\s\S]*?chip[\s\S]*?mais restante/);
  assert.doesNotMatch(html, /acct-uso[\s\S]*?dados de teste/);
});

test("levaN4b: fallback — título semanal, sem barra, sem details, secondary no wrap", () => {
  const html = contas.cursorBarHtml(
    {
      id: "acc_2",
      active: false,
      localUsage: { today: { chamadas: 0, tokens: 0 }, week: { chamadas: 0, tokens: 0 } },
      cursorUsage: failCu(),
    },
    null,
    esc,
    false,
    NOW,
  );
  assert.match(html, /Limite de uso semanal/);
  assert.match(html, /Uso indisponível agora/);
  assert.doesNotMatch(html, /acct-bar/);
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /acct-limit-open/);
  assert.match(html, /acct-secondary/);
  assert.doesNotMatch(html, /Definir limite manual/);
  assert.doesNotMatch(html, /Saiba mais/);
});

test("levaN4b: real — secondary atrás de Definir limite manual", () => {
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
  assert.match(html, /<details class="acct-limit-wrap"><summary class="acct-limit-toggle">Definir limite manual<\/summary>[\s\S]*acct-secondary/);
  assert.doesNotMatch(html, /acct-uso-cap[\s\S]*?acct-secondary[\s\S]*?<details/);
});

test("levaN4b: zero Saiba mais dentro de .acct (real e fallback) após tidy", () => {
  const makeDom = loadDom();
  const realHtml = contas.accountRowHtml(
    {
      id: "acc_1",
      label: "Conta A",
      active: true,
      hasKey: true,
      kind: "apiKey",
      kindLabel: "Chave de API",
      localUsage: { today: { chamadas: 1, tokens: 5 }, week: { chamadas: 3, tokens: 15 } },
      cursorUsage: realCu(),
    },
    esc,
    "acc_1",
    true,
  );
  const failHtml = contas.accountRowHtml(
    {
      id: "acc_2",
      label: "Conta B",
      active: false,
      hasKey: true,
      kind: "apiKey",
      kindLabel: "Chave de API",
      localUsage: { today: { chamadas: 0, tokens: 0 }, week: { chamadas: 0, tokens: 0 } },
      cursorUsage: failCu(),
    },
    esc,
    null,
    true,
  );
  assert.doesNotMatch(realHtml, /Saiba mais/);
  assert.doesNotMatch(failHtml, /Saiba mais/);
  assert.doesNotMatch(failHtml, /<details class="acct-limit-wrap"/);

  if (makeDom) {
    const doc = makeDom(`<div id="accountList">${realHtml}${failHtml}</div>`);
    applyTidy(doc.body);
    for (const acct of doc.querySelectorAll(".acct")) {
      assert.doesNotMatch(acct.textContent || "", /Saiba mais/);
      const bad = [...acct.querySelectorAll("summary")].filter((s) => /Saiba mais/i.test(s.textContent || ""));
      assert.equal(bad.length, 0);
      // Fallback não usa details de limite.
      if (acct.querySelector(".acct-uso-fail")) {
        assert.equal(acct.querySelectorAll("details.acct-limit-wrap").length, 0);
        assert.ok(acct.querySelector(".acct-limit-open"));
      }
    }
  }

  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "layout.js"), "utf8");
  assert.match(src, /Saiba mais/);
  assert.match(src, /acct-limit-wrap/);
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "style.css"), "utf8");
  assert.match(css, /\.acct-uso\s+\.chip\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /\.acct-limit-open/);
});
