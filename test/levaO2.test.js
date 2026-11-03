"use strict";
// LEVA O2: interface clean (Chefe + 4 cartões + aprovações) e uso % sem inventar.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createQuadro } = require("../server/quadro");
const { createChefe, usoPctDe } = require("../server/chefe");
const { createAssistants } = require("../server/assistants");
const { createMissions } = require("../server/missions");
const { createUsage } = require("../server/usage");
const { boot, json } = require("./helpers-ideias");

const tmp = (prefix = "helios-levaO2-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const R = (f) => fs.readFileSync(path.join(__dirname, "..", "renderer", f), "utf8");

test("levaO2: usoPctDe nunca inventa — null sem tokens; % = fatia da conta (O7)", () => {
  assert.equal(usoPctDe(null, "vagas"), null);
  assert.equal(usoPctDe({}, "vagas"), null);
  const dir = tmp();
  const usage = createUsage(dir);
  assert.equal(usoPctDe(usage, "vagas"), null); // sem tokens → sem %
  usage.record("vagas", { kind: "mensagem" }); // sem usage.tokens → ainda null
  assert.equal(usoPctDe(usage, "vagas"), null);
  usage.record("vagas", { kind: "mensagem", usage: { totalTokens: 100 } });
  usage.record("pesquisa", { kind: "mensagem", usage: { totalTokens: 300 } });
  assert.equal(usoPctDe(usage, "vagas"), 25); // 100/400
  assert.equal(usoPctDe(usage, "pesquisa"), 75);
});

test("levaO2: painel agentes com status, ultimoResultado, usoPct e pausar/retomar", async () => {
  const dir = tmp();
  const assistants = createAssistants(dir);
  assistants.seedBuiltins();
  const missions = createMissions(dir);
  const quadro = createQuadro(dir);
  const usage = createUsage(dir);
  usage.record("pesquisa", { kind: "mensagem", usage: { totalTokens: 50 } });
  const chefe = createChefe(dir, { quadro, missions, assistants, usage });
  chefe.seedPapeis();

  quadro.postar({
    de: "pesquisa",
    para: "chefe",
    tipo: "resultado",
    assunto: "Lacuna Docker 40%",
    corpo: "Contagem real das vagas lidas.",
  });

  const st = chefe.status();
  assert.equal(st.agentes.length, 4);
  for (const a of st.agentes) {
    assert.ok(["vagas", "pesquisa", "oasis", "portfolio"].includes(a.id));
    assert.ok("usoPct" in a);
    assert.ok("pausado" in a);
    assert.ok("status" in a);
    assert.ok("ultimoResultado" in a);
  }
  const pesquisa = st.agentes.find((a) => a.id === "pesquisa");
  assert.equal(pesquisa.usoPct, 100); // único com tokens
  assert.ok(pesquisa.ultimoResultado);
  assert.match(pesquisa.ultimoResultado.assunto, /Docker/);

  const vagas = st.agentes.find((a) => a.id === "vagas");
  assert.equal(vagas.usoPct, 0); // total > 0, este agente 0 tokens → 0%

  const paused = chefe.setAgentePausado("vagas", true);
  assert.equal(paused.pausado, true);
  assert.equal(paused.status, "pausado");

  // Ordem que iria para vagas: com agente pausado, não delega.
  quadro.postar({
    de: "helison",
    para: "chefe",
    tipo: "pedido",
    assunto: "Buscar vagas React",
    corpo: "Quero inscrição em vagas React junior.",
  });
  const ciclo = await chefe.ciclo({ forcar: true });
  assert.ok(ciclo.ignorados.some((i) => i.motivo === "agente_pausado" && i.destino === "vagas"));

  const resumed = chefe.setAgentePausado("vagas", false);
  assert.equal(resumed.pausado, false);
  quadro.close();
});

test("levaO2: aprovação do Chefe resolve pendência; API HTTP", async () => {
  const dir = tmp();
  const app = await boot({ dataDir: dir, chefeMs: 0 });
  try {
    const critico = await json(app, "/api/quadro", {
      method: "POST",
      body: {
        de: "helison",
        para: "chefe",
        tipo: "pedido",
        assunto: "Pagar boost LinkedIn",
        corpo: "Quero pagar anúncio e publicar.",
      },
    });
    assert.equal(critico.status, 201);
    const ciclo = await json(app, "/api/chefe/ciclo", { method: "POST", body: { forcar: true } });
    assert.equal(ciclo.status, 200);
    assert.ok(ciclo.body.aprovacoes.length >= 1);

    const st = await json(app, "/api/chefe");
    assert.ok(st.body.agentes.length === 4);
    assert.ok(st.body.pendenciasAprovacao.length >= 1);
    const pend = st.body.pendenciasAprovacao[0];

    const deny = await json(app, `/api/chefe/aprovacao/${pend.id}`, {
      method: "POST",
      body: { decision: "deny" },
    });
    assert.equal(deny.status, 200);
    assert.equal(deny.body.pendencia.estado, "negada");

    const pause = await json(app, "/api/chefe/agente/oasis/pausar", {
      method: "POST",
      body: { pausado: true },
    });
    assert.equal(pause.status, 200);
    assert.equal(pause.body.agente.pausado, true);
    assert.equal(pause.body.agente.usoPct, null);
  } finally {
    await app.close();
  }
});

test("levaO2: UI — Chefe padrão, 4 cartões, Avançado, reunião fora, sem inventar %", () => {
  const html = R("index.html");
  const app = R("app.js");
  const layout = R("layout.js");
  const chefe = R("chefe.js");
  const css = R("layout.css");

  assert.match(html, /data-view="chefe"/);
  assert.match(html, /chefe\.js/);
  assert.match(html, /id="lfAdv"/);
  assert.match(html, />Avançado</);
  // Básico visível; detalhado dentro de Avançado
  assert.match(html, /data-set="account"/);
  assert.match(html, /data-set="aparencia"/);
  const advBlock = html.slice(html.indexOf('id="lfAdv"'), html.indexOf("</details>", html.indexOf('id="lfAdv"')));
  assert.match(advBlock, /data-set="context"/);
  assert.match(advBlock, /data-set="routines"/);
  assert.match(advBlock, /data-set="vault"/);
  assert.match(advBlock, /data-set="reuniao"/);

  // Reunião continua no rodapé (fora da tela principal do Chefe)
  const foot = html.slice(html.indexOf('class="lf-foot"'));
  assert.ok(foot.indexOf('id="openMeeting"') > -1);
  assert.ok(foot.indexOf('data-view="chefe"') > -1 && foot.indexOf('data-view="chefe"') < foot.indexOf('id="openMeeting"'));

  assert.match(app, /view: "chefe"/);
  assert.match(app, /chefe: \["Chefe"/);
  assert.doesNotMatch(app, /Quem entra no gabinete/);

  assert.match(layout, /SETTINGS_ADV/);
  assert.match(layout, /lastMain = "chefe"/);

  assert.match(chefe, /usoLabel/);
  assert.match(chefe, /\/api\/chefe\/ordem/);
  assert.doesNotMatch(chefe, /R\$|US\$|\$\{.*cents/);
  // P3: agentes na lateral (lf-dot); sem cartões / sem "sem dados"
  assert.match(chefe, /lf-dot|lfChefeAgents/);
  assert.ok(!/return `[^`]*Uso: sem dados/.test(chefe));

  assert.match(css, /\.hx-chefe/);
  assert.match(css, /\.hx-uso-bar|\.lf-adv/);
  assert.match(css, /\.lf-adv/);
});

test("levaO2: docs de operação mencionam O2", () => {
  const root = path.join(__dirname, "..", "docs", "operacao");
  for (const f of ["CHANGELOG.md", "HANDOFF.md", "estado-atual.md", "proximos-passos.md"]) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});
