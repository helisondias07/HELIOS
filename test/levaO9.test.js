"use strict";
// LEVA O9: polimento UI Chefe — dedupe feed, textos curtos, painel sem AGENTES duplicados,
// estado Chefe ativo/pausado, uso muted, idempotência semanal. Porta prompt 48081+.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createQuadro } = require("../server/quadro");
const { createAgentPesquisa, weekKey } = require("../server/agent-pesquisa");
const { createJobs } = require("../server/jobs");
const { boot, json } = require("./helpers-ideias");

const tmp = (prefix = "helios-levaO9-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const R = (f) => fs.readFileSync(path.join(__dirname, "..", "renderer", f), "utf8");
const ROOT = path.join(__dirname, "..");

test("levaO9: quadro idempotente por ref (semana)", () => {
  const dir = tmp();
  const quadro = createQuadro(dir);
  const a = quadro.postar({
    de: "pesquisa",
    para: "helison",
    tipo: "resultado",
    assunto: "Lacunas da semana",
    corpo: "3 lacuna(s) em 12 vaga(s) lidas.",
    ref: "semana:2026-W44:helison",
    idempotente: true,
  });
  const b = quadro.postar({
    de: "pesquisa",
    para: "helison",
    tipo: "resultado",
    assunto: "Lacunas da semana",
    corpo: "duplicata que não deve criar outro id",
    ref: "semana:2026-W44:helison",
    idempotente: true,
  });
  assert.equal(a.id, b.id);
  const itens = quadro.ler({ para: "helison", tipo: "resultado", limite: 20 });
  assert.equal(itens.filter((i) => i.assunto === "Lacunas da semana").length, 1);
  assert.equal(quadro.porRef("semana:2026-W44:helison").length, 1);
  quadro.close();
});

test("levaO9: pesquisa sem vagas — Sem vagas lidas ainda e não posta vazio", async () => {
  const dir = tmp();
  const jobs = createJobs(dir, { mock: true });
  const quadro = createQuadro(dir);
  const agent = createAgentPesquisa(dir, {
    jobs,
    quadro,
    now: () => Date.parse("2026-11-02T12:00:00.000Z"),
    rng: () => 0.2,
  });
  agent.setPausado(false);
  const ciclo = await agent.ciclo({ forcar: true, vagas: [] });
  assert.equal(ciclo.ok, true);
  assert.equal(ciclo.n, 0);
  assert.equal(ciclo.postado, false);
  assert.equal(ciclo.aviso, "Sem vagas lidas ainda");
  assert.equal(agent.status().ultimoResumo, "Sem vagas lidas ainda");
  assert.equal(quadro.ler({ de: "pesquisa", limite: 20 }).length, 0);
  quadro.close();
});

test("levaO9: pesquisa ciclo idempotente na mesma semana", async () => {
  const dir = tmp();
  const jobs = createJobs(dir, { mock: true });
  for (let i = 0; i < 6; i++) {
    jobs.ingestParsedJobs([{
      extId: `o9-${i}`,
      title: `Dev pleno React Docker ${i}`,
      company: "Acme",
      location: "Remoto",
      url: `https://example.invalid/o9/${i}`,
      description: "React TypeScript Docker Node.js pleno",
    }], { platform: "linkedin" });
  }
  const quadro = createQuadro(dir);
  const at = Date.parse("2026-11-02T12:00:00.000Z");
  const agent = createAgentPesquisa(dir, {
    jobs,
    quadro,
    now: () => at,
    rng: () => 0.41,
  });
  agent.setPausado(false);
  const c1 = await agent.ciclo({ forcar: true });
  assert.equal(c1.ok, true);
  assert.ok(c1.n >= 1);
  const helison1 = quadro.ler({ para: "helison", de: "pesquisa", tipo: "resultado" });
  const chefe1 = quadro.ler({ para: "chefe", de: "pesquisa", tipo: "resultado" });
  assert.ok(helison1.length >= 1 || chefe1.length >= 1);

  const c2 = await agent.ciclo({ forcar: true });
  assert.equal(c2.ok, true);
  const helison2 = quadro.ler({ para: "helison", de: "pesquisa", tipo: "resultado", limite: 50 });
  const chefe2 = quadro.ler({ para: "chefe", de: "pesquisa", tipo: "resultado", limite: 50 });
  // Mesma ref semana → um resultado por destino
  assert.equal(helison2.filter((i) => /Lacunas da semana|Sem lacunas/i.test(i.assunto)).length, helison1.length);
  assert.equal(chefe2.filter((i) => /Lacunas da semana|Sem lacunas/i.test(i.assunto)).length, chefe1.length);
  assert.ok(weekKey(at));
  for (const item of [...helison2, ...chefe2]) {
    assert.doesNotMatch(String(item.corpo || ""), /sem inventar/i);
  }
  quadro.close();
});

test("levaO9: UI — estado Chefe, uso muted, dedupe, sem AGENTES no Chefe, sem $", () => {
  const chefe = R("chefe.js");
  const layout = R("layout.js");
  const css = R("layout.css");
  const html = R("index.html");

  assert.match(chefe, /Chefe pausado/);
  assert.match(chefe, /Chefe ativo/);
  // P3: usoHtml só com % real (sem string de uso vazio no return).
  assert.ok(!/return `[^`]*Uso: sem dados/.test(chefe));
  assert.match(chefe, /usoHtml/);
  assert.match(chefe, /dedupeFeed/);
  assert.match(chefe, /corpoUsuario/);
  assert.match(chefe, /sem inventar/i);
  assert.doesNotMatch(chefe, /R\$|US\$/);

  assert.match(layout, /state\.view !== "chefe"/);

  assert.match(css, /\.hx-chefe-estado/);

  // Ajustes › Avançado presente (limite US$ só lá, via contas)
  assert.match(html, /id="lfAdv"/);
  assert.match(html, />Avançado</);

  // LinkedIn: agente vagas nunca posta
  const vagas = fs.readFileSync(path.join(ROOT, "server", "agent-vagas.js"), "utf8");
  assert.match(vagas, /NUNCA postar|nunca posta/i);
  assert.match(vagas, /assertNuncaPostar/);

  // CPF só no cofre (não na tela do Chefe)
  assert.doesNotMatch(chefe, /\bCPF\b/i);
  assert.doesNotMatch(layout, /\bCPF\b/i);
});

test("levaO9: API Chefe status + feed sem duplicata", async () => {
  const dir = tmp();
  const app = await boot({ dataDir: dir, chefeMs: 0, mock: true });
  try {
    const tok = null; // helpers usam token interno
    void tok;
    const week = "2026-W44";
    for (let i = 0; i < 3; i++) {
      await json(app, "/api/quadro", {
        method: "POST",
        body: {
          de: "pesquisa",
          para: "helison",
          tipo: "resultado",
          assunto: "Lacunas da semana",
          corpo: i === 0
            ? "Skills pedidas nas vagas lidas — sem inventar percentuais sem contagem."
            : `dup ${i}`,
          ref: `semana:${week}:helison`,
          idempotente: true,
        },
      });
    }
    const q = await json(app, "/api/quadro?para=helison&limite=24");
    assert.equal(q.status, 200);
    const lacunas = (q.body.itens || []).filter((i) => i.assunto === "Lacunas da semana");
    assert.equal(lacunas.length, 1);

    const st = await json(app, "/api/chefe");
    assert.equal(st.status, 200);
    assert.ok("pausado" in st.body);
    assert.equal(st.body.agentes.length, 4);
    for (const a of st.body.agentes) {
      assert.ok("usoPct" in a);
      // nunca inventa: null ou número finito
      assert.ok(a.usoPct == null || Number.isFinite(a.usoPct));
    }
  } finally {
    await app.close();
  }
});

test("levaO9: docs e política de arquivo", () => {
  const root = path.join(ROOT, "docs", "operacao");
  for (const f of ["CHANGELOG.md", "HANDOFF.md", "estado-atual.md", "historico.md"]) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
  assert.equal(fs.existsSync(path.join(ROOT, ".backup-levaO9")), false);
  assert.match(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"), /\.backup-\*\//);
});
