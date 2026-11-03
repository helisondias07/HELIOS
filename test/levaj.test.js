"use strict";
// LEVA J: kit de design do Helison (design/DESIGN.md).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");
const R = (f) => fs.readFileSync(path.join(ROOT, "renderer", f), "utf8");

test("levaJ: kit copiado para design/ e regra para agentes de código", () => {
  for (const f of ["DESIGN.md", "tokens.css", "tailwind.helios.js", "helios-mark.svg"]) assert.ok(fs.existsSync(path.join(ROOT, "design", f)), f);
  assert.match(fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8"), /design\/DESIGN\.md/);
  assert.match(fs.readFileSync(path.join(ROOT, ".cursor", "rules", "design.mdc"), "utf8"), /design\/DESIGN\.md/);
});

test("levaJ: claro é o tema principal, com migração única", () => {
  const boot = R("theme-boot.js");
  assert.match(boot, /var theme = "light"/);
  assert.match(boot, /helios-theme-migr-levaJ/);
});

test("levaJ: tokens do kit no escuro, exatos", () => {
  const t = R("tokens.css");
  for (const v of ["#0B0B0D", "#131316", "#1C1C21", "#2A2A31", "#9A968C", "#F4EEE2", "#E8B23A", "#FFD878", "#C98A22", "#6E4B16"]) assert.ok(t.includes(v), v);
  assert.match(t, /--helios-marfim: #2A1D08/);
  assert.match(t, /--helios-marca: #9A6A14/);
});

test("levaJ: símbolo sempre de helios-mark.svg, sem PNG antigo nem emoji", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "renderer", "assets", "helios-mark.svg")));
  assert.match(R("tokens.css"), /mask: url\("assets\/helios-mark\.svg"\)/);
  for (const f of ["index.html", "app.js", "agents.js", "layout.js", "meeting/index.html"]) {
    const s = R(f);
    assert.doesNotMatch(s, /logo-mark/, f);
    assert.doesNotMatch(s, /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2B50\u2605]/u, f);
  }
  assert.match(R("meeting/index.html"), /class="mark hx-mark"/);
});

test("levaJ: componentes do kit", () => {
  const k = R("kit.css");
  assert.match(R("index.html"), /href="kit\.css"/);
  assert.match(k, /min-height: 44px/);
  assert.match(k, /min-height: 48px; border-radius: var\(--helios-raio-campo\)/);
  assert.match(k, /border-radius: 14px 14px 4px 14px/);
  assert.match(k, /width: 3px/);
  assert.match(k, /2\.4s/);
  assert.match(k, /prefers-reduced-motion/);
  assert.match(R("meeting/style.css"), /prefers-reduced-motion/);
});
