"use strict";
// LEVA N3b: rótulo da barra visível (tidy não esconde); falha sem barra animada; % pt-BR.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const contas = require("../renderer/contas");

const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

const realCu = () => ({
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
});

/** Replica tidy() de layout.js (pós-N3b). */
function applyTidy(rootEl) {
  rootEl.querySelectorAll("p.muted:not([id]), p.hint:not([id]), .lead:not([id])").forEach((p) => {
    if (p.dataset.lfTidy) return;
    const text = p.textContent.trim();
    if (text.length < 70 || p.closest(".msg, .message, .bubble, .status-line, .connect-account, form, .acct, #accountList")) return;
    if (p.classList.contains("acct-bar-label") || p.classList.contains("acct-secondary") || p.classList.contains("acct-pools") || p.classList.contains("acct-me")) return;
    p.dataset.lfTidy = "1";
    p.classList.add("lf-explain");
  });
}

function loadDom() {
  try {
    const { JSDOM } = require("jsdom");
    return (html) => {
      const dom = new JSDOM(`<!doctype html><html><head><style>
        .lf-explain{display:none!important}
        body{background:#fffdf8;color:#171717}
        .muted{color:#525252;background:#fffdf8}
        .acct-bar-label,.acct-secondary,.acct-pools,.acct-me{display:block!important;color:#525252;min-height:16px}
      </style></head><body>${html}</body></html>`);
      return { document: dom.window.document, getComputedStyle: (el) => dom.window.getComputedStyle(el) };
    };
  } catch { /* optional */ }
  try {
    const { Window } = require("happy-dom");
    return (html) => {
      const w = new Window({ url: "https://helios.local/" });
      w.document.head.innerHTML = `<style>
        .lf-explain{display:none!important}
        body{background:#fffdf8}
        .acct-bar-label,.acct-secondary{display:block!important;color:#525252;min-height:16px;background:#fffdf8}
      </style>`;
      w.document.body.innerHTML = html;
      return { document: w.document, getComputedStyle: (el) => w.getComputedStyle(el) };
    };
  } catch { /* optional */ }
  return null;
}

test("levaN3b: tidy em layout.js isenta .acct / rótulo da barra", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "layout.js"), "utf8");
  assert.match(src, /\.acct,\s*#accountList/);
  assert.match(src, /acct-bar-label/);
  assert.match(src, /acct-secondary/);
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "style.css"), "utf8");
  assert.match(css, /\.acct-bar-label[\s\S]*display:\s*block\s*!important/);
  assert.match(css, /\.acct-limit-wrap\[open\]\s*>\s*summary\.acct-limit-toggle\s*\{\s*display:\s*none/);
});

test("levaN3b: rótulo com fixture permanece visível após tidy (DOM)", () => {
  const label = contas.fmtBarLabel(realCu());
  assert.equal(label, "US$ 4,20 de US$ 20,00 usados · restam US$ 15,80 · reinicia 28/11");

  const html = contas.accountRowHtml(
    {
      id: "acc_1",
      label: "Conta A",
      active: true,
      hasKey: true,
      kind: "apiKey",
      kindLabel: "Chave de API",
      localUsage: { today: { chamadas: 2, tokens: 10 }, week: { chamadas: 5, tokens: 50 } },
      cursorUsage: realCu(),
    },
    esc,
    "acc_1",
    true,
  );

  assert.match(html, /class="acct-uso"/);
  assert.match(html, /Limite de uso semanal/);
  assert.match(html, /<strong>30%<\/strong>/);
  assert.match(html, /title="[^"]*US\$ 4,20 de US\$ 20,00 usados/);
  assert.match(html, /dados de teste/);
  assert.match(html, /acct-secondary/);
  assert.match(html, /acct-uso-cap/);
  assert.doesNotMatch(html, /class="muted acct-pools"/);

  const make = loadDom();
  if (!make) {
    const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.match(plain, /30%[\s\S]*?usado/);
    assert.match(plain, /Uso no HELIOS/);
    return;
  }

  const env = make(`<div id="view"><div id="accountList">${html}</div></div>`);
  applyTidy(env.document.getElementById("view"));

  const el = env.document.querySelector(".acct-uso");
  assert.ok(el, "card de uso no DOM");
  assert.equal(el.classList.contains("lf-explain"), false);
  assert.match(el.textContent, /30%/);
  assert.match(el.textContent, /usado/);
  assert.doesNotMatch(el.textContent, /dados de teste/);
  const head = env.document.querySelector(".acct-head");
  assert.ok(head);
  assert.match(head.textContent, /dados de teste/);

  const cap = env.document.querySelector(".acct-uso-cap");
  assert.ok(cap);
  assert.equal(cap.classList.contains("lf-explain"), false);

  const secondary = env.document.querySelector(".acct-secondary");
  assert.ok(secondary);
  assert.equal(secondary.classList.contains("lf-explain"), false);
});

test("levaN3b: falha — mensagem curta, form aberto sem link (N4b: sem barra/details)", () => {
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
        limiteRotulo: "Uso indisponível agora: fixture longa demais",
        nextResetAt: "2026-11-07T03:00:00.000Z",
        period: { type: "weekly", resetDay: 5 },
        pools: null,
        real: { status: "error", error: "Uso indisponível agora: fixture longa demais" },
        manualLimit: null,
        me: null,
      },
    },
    null,
    esc,
    false,
  );
  assert.match(html, /Uso indisponível agora/);
  assert.doesNotMatch(html, /Uso indisponível agora: fixture/);
  assert.doesNotMatch(html, /acct-bar/);
  assert.doesNotMatch(html, /acct-bar-indeterminate/);
  assert.match(html, /acct-limit-open/);
  assert.doesNotMatch(html, /<details class="acct-limit-wrap"/);
  assert.doesNotMatch(html, /Definir limite manual/);
  assert.equal(contas.fmtPct(12.5), "12,5");
});
