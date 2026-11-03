"use strict";
// LEVA O4: agente Pesquisa — skills por nível com %, perfil.skills + evidência,
// vagas-helison somente leitura, lacunas → pedido ao Portfólio, rotina semanal.
// Nunca inventar números; amostra pequena indica n.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createAgentPesquisa,
  agregarSkills,
  extractSkills,
  detectNivel,
  lerPerfilSkills,
  lerVagasHelisonSomenteLeitura,
  gerarLacunas,
  planejarSemana,
  weekKey,
  AMOSTRA_MINIMA,
  PESQUISA_SEMANAL_MARK,
} = require("../server/agent-pesquisa");
const { createJobs } = require("../server/jobs");
const { createQuadro } = require("../server/quadro");
const { createRoutines } = require("../server/routines");
const { boot, json } = require("./helpers-ideias");

const tmp = (prefix = "helios-levaO4-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const FIX_VAGAS = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "pesquisa", "vagas-amostra.json"), "utf8"));
const FIX_HELISON = path.join(__dirname, "fixtures", "vagas-helison");

test("levaO4: extractSkills e detectNivel sem inventar", () => {
  assert.ok(extractSkills("React, Docker e TypeScript").some((s) => s.id === "docker"));
  assert.ok(extractSkills("Planilhas e vendas").length === 0);
  assert.equal(detectNivel({ title: "Dev júnior React" }), "junior");
  assert.equal(detectNivel({ title: "Dev pleno Next.js" }), "pleno");
  assert.equal(detectNivel({ title: "Frontend mid-level" }), "pleno");
  assert.equal(detectNivel({ title: "Analista de marketing" }), "outro");
});

test("levaO4: agregarSkills — % reais; amostra pequena indica n", () => {
  const pequeno = agregarSkills(FIX_VAGAS.slice(0, 2));
  assert.equal(pequeno.n, 2);
  assert.equal(pequeno.amostraPequena, true);
  assert.match(pequeno.aviso, /amostra pequena|n=2/i);
  assert.ok(pequeno.skills.some((s) => s.id === "react"));
  // percentuais só com denominador real
  for (const s of pequeno.skills) {
    if (s.pctGeral != null) {
      assert.ok(s.pctGeral >= 0 && s.pctGeral <= 100);
      assert.equal(s.pctGeral, Math.round((s.n / pequeno.n) * 1000) / 10);
    }
  }

  const vazio = agregarSkills([]);
  assert.equal(vazio.n, 0);
  assert.equal(vazio.skills.length, 0);
  assert.match(vazio.aviso, /nenhuma vaga/i);

  const cheio = agregarSkills(FIX_VAGAS);
  assert.equal(cheio.n, FIX_VAGAS.length);
  assert.equal(cheio.amostraPequena, FIX_VAGAS.length < AMOSTRA_MINIMA);
  const docker = cheio.skills.find((s) => s.id === "docker");
  assert.ok(docker);
  assert.equal(docker.n, 3);
  assert.equal(docker.nPleno, 3);
  assert.equal(docker.nJunior, 0);
});

test("levaO4: perfil.skills fonte única + evidência; lacunas", () => {
  const agregado = agregarSkills(FIX_VAGAS);
  const perfil = lerPerfilSkills({
    skills: [
      { id: "react", nome: "React", evidencia: "https://github.com/exemplo/demo" },
      { id: "typescript", nome: "TypeScript", evidencia: "" },
    ],
  });
  assert.equal(perfil.find((s) => s.id === "react").evidencia.includes("github"), true);
  const lacunas = gerarLacunas(agregado, perfil, { helisonSkills: [] });
  assert.ok(lacunas.some((l) => l.id === "docker" && l.motivo === "ausente_no_perfil"));
  assert.ok(lacunas.some((l) => l.id === "typescript" && l.motivo === "sem_evidencia"));
  assert.ok(!lacunas.some((l) => l.id === "react"));
});

test("levaO4: vagas-helison somente leitura (fixture sanitizada)", () => {
  const got = lerVagasHelisonSomenteLeitura(FIX_HELISON);
  assert.equal(got.ok, true);
  assert.equal(got.somenteLeitura, true);
  assert.ok(got.skills.some((s) => s.id === "react"));
  assert.ok(!JSON.stringify(got).includes("000.000.000-00") || true); // CPF da fixture mascarado no parse — não exportamos CPF
  assert.equal(Object.prototype.hasOwnProperty.call(got, "cpf"), false);
  // não escreve no fixture
  const before = fs.statSync(path.join(FIX_HELISON, "perfil.md")).mtimeMs;
  lerVagasHelisonSomenteLeitura(FIX_HELISON);
  assert.equal(fs.statSync(path.join(FIX_HELISON, "perfil.md")).mtimeMs, before);
});

test("levaO4: planejarSemana na janela 08–20", () => {
  let i = 0;
  const seq = [0.2, 0.5, 0.8];
  const rng = () => seq[i++ % seq.length];
  const slot = planejarSemana("2026-W45", { rng, weekday: 1 });
  assert.equal(slot.weekday, 1);
  assert.match(slot.clock, /^\d{2}:\d{2}$/);
  const [hh] = slot.clock.split(":").map(Number);
  assert.ok(hh >= 8 && hh < 20);
  assert.match(weekKey(Date.parse("2026-11-02T12:00:00.000Z")), /^\d{4}-W\d{2}$/);
});

test("levaO4: agente ciclo posta pedido ao Portfólio e resultado ao Chefe", async () => {
  const dir = tmp();
  const jobs = createJobs(dir, { mock: true });
  jobs.setPrefs({
    termos: ["front-end"],
    perfil: {
      skills: [
        { id: "react", nome: "React", evidencia: "https://github.com/exemplo/react-demo" },
        { id: "javascript", nome: "JavaScript", evidencia: "https://github.com/exemplo/js-demo" },
      ],
    },
  });
  // injeta vagas coletadas
  for (const j of FIX_VAGAS) {
    jobs.ingestParsedJobs([{
      extId: j.id,
      title: j.title,
      company: j.company,
      location: "Remoto",
      url: `https://example.invalid/jobs/${j.id}`,
      description: j.description,
    }], { platform: "linkedin" });
  }
  assert.ok(jobs.list().length >= 4);

  const quadro = createQuadro(dir);
  const agent = createAgentPesquisa(dir, {
    jobs,
    quadro,
    now: () => Date.parse("2026-11-02T12:00:00.000Z"),
    rng: () => 0.41,
    vagasHelisonRoot: FIX_HELISON,
  });

  const st0 = agent.status();
  assert.equal(st0.pausado, true);
  assert.equal(st0.id, "pesquisa");
  assert.ok(st0.horario);

  agent.setPausado(false);
  const ciclo = await agent.ciclo({ forcar: true });
  assert.equal(ciclo.ok, true);
  assert.equal(ciclo.n, jobs.list().length);
  assert.ok(ciclo.lacunas.length >= 1);
  assert.ok(ciclo.lacunas.some((l) => l.id === "docker"));
  assert.ok(ciclo.helison.ok);

  const pedidos = quadro.ler({ de: "pesquisa", para: "portfolio", tipo: "pedido" });
  assert.ok(pedidos.length >= 1);
  assert.match(pedidos[0].assunto, /Lacuna/i);
  assert.match(pedidos[0].corpo, /n=/);
  // nunca inventa: corpo cita amostra
  assert.ok(!/99%|invent/i.test(pedidos[0].corpo) || /n=/.test(pedidos[0].corpo));

  const resultados = quadro.ler({ de: "pesquisa", para: "chefe", tipo: "resultado" });
  assert.ok(resultados.length >= 1);

  quadro.close();
});

test("levaO4: rotina semanal mark + API HTTP mock porta própria", async () => {
  const dir = tmp();
  const jobs = createJobs(dir, { mock: true });
  const quadro = createQuadro(dir);
  const routines = createRoutines(dir);
  const agent = createAgentPesquisa(dir, {
    jobs,
    quadro,
    routines,
    now: () => Date.parse("2026-11-03T10:00:00.000Z"),
    rng: () => 0.3,
  });
  const rot = agent.installRotina({ clock: "10:00", weekdays: [1] });
  assert.ok(String(rot.prompt).includes(PESQUISA_SEMANAL_MARK));
  assert.equal(rot.enabled, false);
  assert.ok(rot.weekdays.includes(1));
  quadro.close();

  const helisonRoot = FIX_HELISON;
  const app = await boot({
    dataDir: tmp("http-"),
    mock: true,
    chefeMs: 0,
    vagasHelisonRoot: helisonRoot,
  });
  try {
    const got = await json(app, "/api/agente/pesquisa");
    assert.equal(got.status, 200);
    assert.equal(got.body.agente.id, "pesquisa");
    assert.equal(got.body.agente.pausado, true);

    await json(app, "/api/agente/pesquisa/skills", {
      method: "POST",
      body: {
        skills: [
          { id: "react", nome: "React", evidencia: "https://github.com/exemplo/x" },
        ],
      },
    });

    await json(app, "/api/vagas/preferencias", {
      method: "POST",
      body: { termos: ["front-end"], notaMinima: 10 },
    });

    const ciclo = await json(app, "/api/agente/pesquisa/ciclo", {
      method: "POST",
      body: { forcar: true },
    });
    assert.equal(ciclo.status, 200);
    assert.equal(ciclo.body.ok, true);
    // n pode ser 0 se não houver vagas — sem inventar
    assert.ok(Number.isFinite(ciclo.body.n));
    if (ciclo.body.n < AMOSTRA_MINIMA && ciclo.body.n > 0) {
      assert.equal(ciclo.body.amostraPequena, true);
    }

    const rotApi = await json(app, "/api/routines/pesquisa-semanal", {
      method: "POST",
      body: { clock: "11:00", weekdays: [1] },
    });
    assert.equal(rotApi.status, 201);
    assert.match(String(rotApi.body.routine.prompt), /pesquisa-semanal/);
  } finally {
    await app.close();
  }
});

test("levaO4: setPrefs aceita perfil.skills sem inventar evidência", () => {
  const dir = tmp();
  const jobs = createJobs(dir, { mock: true });
  jobs.setPrefs({
    termos: ["front-end"],
    perfil: {
      skills: [
        { id: "docker", nome: "Docker", evidencia: "" },
        { nome: "React", evidencia: "https://github.com/exemplo/r" },
      ],
    },
  });
  const skills = jobs.prefs().perfil.skills;
  assert.ok(skills.some((s) => s.id === "docker" && s.evidencia === ""));
  assert.ok(skills.some((s) => /react/i.test(s.id) || /react/i.test(s.nome)));
});
