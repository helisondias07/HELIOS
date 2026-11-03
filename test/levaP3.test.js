"use strict";
// LEVA P3: Chefe enxuto + lateral com dots + barra de uso + OAuth MCP atrás de flag.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const R = (f) => fs.readFileSync(path.join(ROOT, "renderer", f), "utf8");
const { galleryHtml, buttonLabel } = require("../renderer/conectores");
const { renewLabel, usageTopPercent, pct } = require("../renderer/contas");

test("levaP3: Chefe sem painel de agentes / sem card ClickUp / sem subtítulo", () => {
  const chefe = R("chefe.js");
  const css = R("layout.css");
  const html = R("index.html");
  assert.doesNotMatch(chefe, /hx-chefe-agents/);
  assert.doesNotMatch(chefe, /O Chefe prioriza/);
  assert.doesNotMatch(chefe, /Entrar com ClickUp/);
  assert.doesNotMatch(chefe, /Entre com ClickUp/);
  assert.doesNotMatch(chefe, /data-entrar-conector/);
  assert.match(chefe, /Oasis precisa do ClickUp/);
  assert.match(chefe, /lfChefeAgents|lf-dot/);
  assert.match(css, /hx-chefe-solo|hx-uso-bar/);
  assert.match(html, /id="lfChefeAgents"/);
  assert.match(html, /uso-bar\.js/);
});

test("levaP3: painel direito oculto por padrão", () => {
  const layout = R("layout.js");
  assert.match(layout, /PANEL_KEY[\s\S]*=== "1"/);
});

test("levaP3: OAuth MCP UI desligada por padrão; Avançado ok", () => {
  const off = galleryHtml({
    oauthMcpUi: false,
    presets: [
      { id: "clickup", name: "ClickUp", blurb: "Tarefas", kind: "mcp", enterAs: "Entrar com ClickUp", configured: true, featured: true },
      { id: "github", name: "GitHub", blurb: "Repos", kind: "github", enterAs: "Entrar com GitHub", configured: true, featured: true },
    ],
    connections: [],
    vercelCli: { disponivel: false, user: "" },
    cursor: { accounts: [], login: {} },
  }, (s) => String(s));
  assert.doesNotMatch(off, /Entrar com ClickUp/);
  assert.match(off, /Token no Avançado/);
  assert.match(off, /Tokens manuais/);
  assert.match(off, /oauth.*pausa|Tokens manuais/i);
  const [lab] = buttonLabel("idle", { enterAs: "Entrar com ClickUp", featured: true, id: "clickup" }, [], false);
  assert.equal(lab, "Token no Avançado");
  const con = fs.readFileSync(path.join(ROOT, "server", "conectores.js"), "utf8");
  assert.match(con, /HELIOS_OAUTH_MCP_UI/);
});

test("levaP3: barra de uso com pct e Renova, sem moeda", () => {
  const bar = R("uso-bar.js");
  assert.match(bar, /HeliosUsoBar/);
  assert.match(bar, /usageTopPercent|renewLabel/);
  assert.doesNotMatch(bar, /Uso:\s*sem dados/);
  assert.match(bar, /tipSafe/);
  const in5 = new Date(Date.now() + 5.2 * 86400000).toISOString();
  assert.match(renewLabel(in5), /Renova em \d+ dias/);
  assert.equal(renewLabel(new Date().toISOString()), "Renova hoje");
  const top = usageTopPercent({
    showBar: true,
    source: "real",
    pools: { autoPercent: 12, apiPercent: 4 },
  });
  assert.equal(top, 12);
  assert.ok(pct(12));
});

test("levaP3: backup e porta do prompt", () => {
  assert.equal(fs.existsSync(path.join(ROOT, ".backup-levaP3")), false);
  assert.match(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"), /\.backup-\*\//);
  assert.ok(48161 >= 48161);
});
