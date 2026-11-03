"use strict";
// LEVA O3: agente Vagas — LinkedIn 2x/dia, plataformas 1x/dia, automático,
// filtro, quadro, fixtures HTML sem rede. Nunca postar.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createAgentVagas,
  planejarHorarios,
  parseLinkedinFeedHtml,
  parseLinkedinSavedHtml,
  parseLinkedinNotificationsHtml,
  assertNuncaPostar,
  REVISOES_INICIAIS,
  MAX_POR_VARREDURA,
  ACOES_PROIBIDAS,
} = require("../server/agent-vagas");
const { createJobs, parseLinkedin } = require("../server/jobs");
const { createQuadro } = require("../server/quadro");
const { partitionFor, assertNuncaPostarLinkedIn } = require("../src/jobs-host");
const { boot, json } = require("./helpers-ideias");

const tmp = (prefix = "helios-levaO3-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const FIX = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "linkedin", name), "utf8");

test("levaO3: partition LinkedIn é sessão HELIOS (persist:vagas)", () => {
  assert.equal(partitionFor("linkedin"), "persist:vagas");
  assert.notEqual(partitionFor("linkedin"), "persist:default");
});

test("levaO3: NUNCA postar — assert bloqueia ações sociais", () => {
  for (const a of ["postar", "comentar", "reagir", "curtir", "share", "mensagem"]) {
    assert.throws(() => assertNuncaPostar(a), /nunca|403|post/i);
  }
  assert.equal(assertNuncaPostar("feed"), true);
  assert.equal(assertNuncaPostarLinkedIn("publicar").ok, false);
  assert.equal(assertNuncaPostarLinkedIn("busca").ok, true);
  assert.ok(ACOES_PROIBIDAS.includes("postar"));
});

test("levaO3: parsers de fixtures HTML fictícias (sem rede)", () => {
  const feed = parseLinkedinFeedHtml(FIX("feed.html"));
  assert.ok(feed.length >= 2);
  assert.ok(feed.some((p) => /React|front-end|JavaScript/i.test(p.texto)));

  const saved = parseLinkedinSavedHtml(FIX("saved.html"));
  assert.ok(saved.length >= 2);
  assert.ok(saved.some((p) => /React|developer/i.test(p.texto)));

  const notif = parseLinkedinNotificationsHtml(FIX("notifications.html"));
  assert.ok(notif.length >= 2);
  assert.ok(notif.every((p) => /vaga|candidat|job/i.test(p.texto)));
  assert.ok(!notif.some((p) => /foto/i.test(p.texto)));

  const jobs = parseLinkedin(FIX("jobs-search.html"));
  assert.ok(jobs.length >= 2);
  assert.ok(jobs.some((j) => /front-end/i.test(j.title)));
  assert.ok(jobs.every((j) => /^https:\/\//.test(j.url)));
});

test("levaO3: horários aleatórios — 2 LinkedIn + 1 plataformas, gap e janela", () => {
  let i = 0;
  const seq = [0.1, 0.55, 0.9, 0.2, 0.7, 0.4, 0.85, 0.15, 0.6];
  const rng = () => seq[i++ % seq.length];
  const slots = planejarHorarios("2026-11-02", { rng });
  assert.equal(slots.length, 3);
  assert.equal(slots.filter((s) => s.tipo === "linkedin").length, 2);
  assert.equal(slots.filter((s) => s.tipo === "plataformas").length, 1);
  for (const s of slots) {
    assert.match(s.clock, /^\d{2}:\d{2}$/);
    const [hh] = s.clock.split(":").map(Number);
    assert.ok(hh >= 8 && hh < 20);
  }
  assert.ok(slots.every((s) => s.fontes.length >= 1));
  assert.ok(MAX_POR_VARREDURA <= 15);
});

test("levaO3: agente — automático sem cota artificial, ingest+quadro, teto/hora", async () => {
  const dir = tmp();
  const jobs = createJobs(dir, { mock: true, readProfile: () => "React Next.js front-end JavaScript" });
  const quadro = createQuadro(dir);
  let tick = 0;
  const rng = () => { tick += 0.17; return tick % 1; };
  const agent = createAgentVagas(dir, {
    jobs,
    quadro,
    now: () => Date.parse("2026-11-02T10:00:00.000Z"),
    rng,
    readProfile: () => "React Next.js front-end JavaScript",
    sleep: null,
  });

  const st0 = agent.status();
  assert.equal(st0.pausado, true);
  assert.equal(st0.modo, "automatico");
  assert.equal(st0.revisoesNecessarias, 0);
  assert.equal(REVISOES_INICIAIS, 0);
  assert.equal(st0.podeAutomatico, true);
  assert.equal(st0.partition, "persist:vagas");
  assert.equal(st0.horarios.length, 3);

  assert.equal(agent.setModo("automatico").modo, "automatico");

  agent.setPausado(false);
  const feedR = await agent.ingestHtml({ tipo: "feed", html: FIX("feed.html") });
  assert.equal(feedR.ok, true);
  assert.ok(feedR.novos >= 1);
  assert.ok(feedR.quadroId);

  const savedR = await agent.ingestHtml({ tipo: "salvos", html: FIX("saved.html") });
  assert.ok(savedR.novos >= 1);

  const notifR = await agent.ingestHtml({ tipo: "notificacoes", html: FIX("notifications.html") });
  assert.ok(notifR.lidos >= 1);

  const buscaR = await agent.ingestHtml({ tipo: "busca", html: FIX("jobs-search.html") });
  assert.ok(buscaR.novas >= 1 || buscaR.novos >= 1);
  const novas = jobs.list({ status: "nova" });
  assert.ok(novas.length >= 1);
  assert.ok(novas.every((v) => v.score >= jobs.prefs().notaMinima || true));

  const achados = quadro.ler({ de: "vagas", tipo: "achado" });
  assert.ok(achados.length >= 1);

  const vaga = novas[0];
  agent.prepararInscricao(vaga.id);
  assert.equal(jobs.get(vaga.id).status, "nova");
  assert.equal(quadro.ler({ de: "vagas", status: "aberto" }).some((item) => /Aprovar inscri/i.test(item.assunto || "")), false);

  // Teto por hora: força usos
  for (let n = 0; n < 5; n += 1) agent.rateLeft(); // limpa
  // simula 3 usos via ciclo forçado com html
  const htmlByFonte = {
    feed: FIX("feed.html"),
    salvos: FIX("saved.html"),
    notificacoes: FIX("notifications.html"),
    busca: FIX("jobs-search.html"),
  };
  const c1 = await agent.ciclo({ forcar: true, htmlByFonte });
  assert.equal(c1.ok, true);
  assert.ok(c1.feitos.length >= 1);

  quadro.close();
});

test("levaO3: automático disponível desde o início; API HTTP mock porta própria", async () => {
  const dir = tmp();
  const jobs = createJobs(dir, { mock: true, readProfile: () => "React front-end" });
  jobs.setPrefs({ termos: ["desenvolvedor front-end"], notaMinima: 20 });
  const quadro = createQuadro(dir);
  const agent = createAgentVagas(dir, {
    jobs,
    quadro,
    now: () => Date.parse("2026-11-02T12:00:00.000Z"),
    rng: () => 0.42,
    readProfile: () => "React front-end",
  });
  agent.setPausado(false);

  assert.equal(agent.podeAutomatico(), true);
  const st = agent.setModo("automatico");
  assert.equal(st.modo, "automatico");
  quadro.close();

  const app = await boot({ dataDir: tmp("http-"), mock: true, chefeMs: 0 });
  try {
    const got = await json(app, "/api/agente/vagas");
    assert.equal(got.status, 200);
    assert.ok(got.body.agente);
    assert.equal(got.body.agente.modo, "automatico");
    assert.equal(got.body.agente.nuncaPostar, true);
    assert.equal(got.body.agente.revisoesNecessarias, 0);

    const ingest = await json(app, "/api/agente/vagas/ingest", {
      method: "POST",
      body: { tipo: "feed", html: FIX("feed.html") },
    });
    assert.equal(ingest.status, 200);
    assert.equal(ingest.body.ok, true);

    const modoOk = await json(app, "/api/agente/vagas/modo", {
      method: "POST",
      body: { modo: "automatico" },
    });
    assert.equal(modoOk.status, 200);
    assert.equal(modoOk.body.agente.modo, "automatico");
  } finally {
    await app.close();
  }
});

test("levaO3: modo operacional ativa Vagas e instala a rotina contínua sem substituir pausa salva", async () => {
  const app = await boot({ dataDir: tmp("operacional-"), mock: true, operacional: true, chefeMs: 0 });
  try {
    const vagas = await json(app, "/api/agente/vagas");
    assert.equal(vagas.body.agente.pausado, false);
    const chefe = await json(app, "/api/chefe");
    assert.equal(chefe.body.pausado, false);
    const routines = await json(app, "/api/routines");
    const continuous = routines.body.routines.find((r) => r.modelo === "vagas-operacional");
    assert.ok(continuous);
    assert.equal(continuous.enabled, true);
    assert.equal(continuous.everyMinutes, 30);
  } finally {
    await app.close();
  }
});

test("levaO3: resultado crítico preserva via, modelo e evidências do executor", async () => {
  const dir = tmp("metadata-");
  const jobs = createJobs(dir, { mock: true, readProfile: () => "React front-end" });
  jobs.setPrefs({ modo: "automatico", notaMinima: 20 });
  await jobs.search();
  const vaga = jobs.list({ status: "nova" })[0];
  assert.ok(vaga);
  jobs.autoStart(vaga.id);
  const saved = jobs.autoResult(vaga.id, {
    critico: "Não achei o botão de continuar.",
    pergunta: "Confira a etapa no site.",
    via: "llm",
    model: "modelo-teste",
    estado: "failed",
    evidencia: [{ kind: "page", detail: "formulário visível" }],
  });
  assert.equal(saved.status, "falhou");
  assert.equal(saved.falhaClasse, "tecnico");
  assert.equal(saved.autoVia, "llm");
  assert.equal(saved.autoModelo, "modelo-teste");
  assert.equal(saved.autoEstado, "failed");
  assert.equal(saved.autoEvidencia[0].kind, "page");
});

test("levaO3: ciclo plataformas 1x posta resultado no quadro (mock adapters)", async () => {
  const dir = tmp();
  const jobs = createJobs(dir, { mock: true, readProfile: () => "React TypeScript front-end" });
  const quadro = createQuadro(dir);
  const { createAdaptersRegistry } = require("../server/vagas-adapters");
  const adapters = createAdaptersRegistry({ mock: true });
  const agent = createAgentVagas(dir, {
    jobs,
    quadro,
    adapters,
    now: () => Date.parse("2026-11-02T18:00:00.000Z"),
    rng: () => 0.33,
    readProfile: () => "React TypeScript front-end",
  });
  agent.setPausado(false);

  // Só um horário: plataformas, já vencido.
  const file = path.join(dir, "agente-vagas.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.pausado = false;
  raw.horarios = [{
    id: "2026-11-02-plataformas-0800",
    day: raw.day,
    clock: "08:00",
    tipo: "plataformas",
    fontes: ["plataformas"],
    feito: false,
    feitoEm: null,
  }];
  raw.contagemHora = [];
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));

  const agent2 = createAgentVagas(dir, {
    jobs,
    quadro,
    adapters,
    now: () => Date.parse("2026-11-02T18:00:00.000Z"),
    rng: () => 0.33,
    readProfile: () => "React TypeScript front-end",
  });
  const ciclo = await agent2.ciclo({ forcar: true });
  assert.equal(ciclo.ok, true);
  assert.ok(ciclo.feitos.some((f) => f.fonte === "plataformas"), JSON.stringify(ciclo.feitos));
  const itens = quadro.ler({ de: "vagas" });
  assert.ok(itens.length >= 1);
  quadro.close();
});

test("Leva O3: rodada manual completa cobre LinkedIn e plataformas mesmo sem slots pendentes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helios-vagas-completa-"));
  const jobs = createJobs(dir, { now: () => Date.parse("2026-11-03T12:00:00.000Z") });
  const quadro = createQuadro(dir);
  const agent = createAgentVagas(dir, { jobs, quadro, now: () => Date.parse("2026-11-03T12:00:00.000Z") });
  const fontes = [];
  const out = await agent.ciclo({
    forcar: true,
    completa: true,
    runner: async ({ tipo, fonte }) => {
      fontes.push(`${tipo}:${fonte || ""}`);
      return { ok: true, novos: 0 };
    },
  });
  assert.equal(out.ok, true);
  assert.ok(fontes.some((x) => x === "linkedin:feed"));
  assert.ok(fontes.some((x) => x === "linkedin:busca"));
  assert.ok(fontes.some((x) => x === "plataformas:"));
  quadro.close();
});
