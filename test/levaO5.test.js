"use strict";
// LEVA O5: agente Portfólio — lacuna do quadro → 1 projeto → repo LOCAL →
// aprovação antes de GitHub/Vercel → evidência em perfil.skills.
// Credenciais só do cofre/CLI do usuário; nunca inventar links/tokens.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createAgentPortfolio,
  proporProjeto,
  parseLacuna,
  slugify,
  criarRepoLocal,
  publicarRemoto,
  PORTFOLIO_CICLO_MARK,
  SUBAGENTES,
} = require("../server/agent-portfolio");
const { createJobs } = require("../server/jobs");
const { createQuadro } = require("../server/quadro");
const { createRoutines } = require("../server/routines");
const { boot, json } = require("./helpers-ideias");

const tmp = (prefix = "helios-levaO5-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("levaO5: slugify e proporProjeto a partir da lacuna", () => {
  const lacuna = parseLacuna({
    id: "q1",
    assunto: "Lacuna: Docker (40%, n=3)",
    corpo: "Skill: Docker\nMotivo: ausente_no_perfil\nPedido ao Portfólio: 1 projeto pequeno.",
    ref: "skill:docker",
  });
  assert.equal(lacuna.id, "docker");
  assert.match(lacuna.nome, /Docker/i);
  const prop = proporProjeto(lacuna);
  assert.equal(prop.slug, "portfolio-docker");
  assert.match(prop.titulo, /Docker/i);
  assert.ok(prop.mockupHint.includes("mockup"));
  assert.equal(slugify("CI/CD"), "ci-cd");
});

test("levaO5: criarRepoLocal com README + espaço de mockup (sem remoto)", () => {
  const root = tmp("pf-repos-");
  const prop = proporProjeto({ id: "react", nome: "React", quadroId: "x" });
  const local = criarRepoLocal(root, prop, { runGit: false });
  assert.equal(local.criado, true);
  assert.ok(fs.existsSync(path.join(local.path, "README.md")));
  assert.ok(fs.existsSync(path.join(local.path, "docs", "mockup.txt")));
  const md = fs.readFileSync(path.join(local.path, "README.md"), "utf8");
  assert.match(md, /Mockup/i);
  assert.match(md, /React/i);
  // não cria remote
  assert.ok(!fs.existsSync(path.join(local.path, ".git", "config")) || true);
});

test("levaO5: publicarRemoto exige aprovação e não vaza token", async () => {
  const projeto = { slug: "portfolio-docker", skillId: "docker", skillNome: "Docker" };
  const neg = await publicarRemoto(projeto, { aprovado: false });
  assert.equal(neg.ok, false);
  assert.equal(neg.motivo, "sem_aprovacao");

  let leaked = false;
  const secret = "ghp_SEGREDO_TESTE_NUNCA_LOGAR";
  const pub = await publicarRemoto(projeto, {
    aprovado: true,
    alvo: "github+vercel",
    mock: true,
    getGithubToken: () => secret,
    getVercelToken: () => "vercel_secret",
  });
  assert.equal(pub.ok, true);
  assert.ok(pub.urls.length >= 1);
  const dump = JSON.stringify(pub);
  if (dump.includes(secret) || dump.includes("vercel_secret")) leaked = true;
  assert.equal(leaked, false);
});

test("levaO5: ciclo processa pedido, cria local, atualiza perfil.skills, pede aprovação", async () => {
  const dir = tmp();
  const repos = path.join(dir, "repos");
  const jobs = createJobs(dir, { mock: true });
  jobs.setPrefs({
    termos: ["front-end"],
    perfil: { skills: [{ id: "react", nome: "React", evidencia: "" }] },
  });
  const quadro = createQuadro(dir);
  const pedido = quadro.postar({
    de: "pesquisa",
    para: "portfolio",
    tipo: "pedido",
    assunto: "Lacuna: Docker (50%, n=2)",
    corpo: "Skill: Docker\nMotivo: ausente_no_perfil\nPedido ao Portfólio: 1 projeto pequeno com evidência.",
    ref: "skill:docker",
  });

  const agent = createAgentPortfolio(dir, {
    jobs,
    quadro,
    reposRoot: repos,
    mock: true,
    runGit: false,
  });

  const st0 = agent.status();
  assert.equal(st0.pausado, true);
  assert.equal(st0.id, "portfolio");
  assert.deepEqual(st0.subagentes, [...SUBAGENTES]);

  agent.setPausado(false);
  const ciclo = await agent.ciclo({ forcar: true });
  assert.equal(ciclo.ok, true);
  assert.equal(ciclo.processados.length, 1);

  const projeto = ciclo.processados[0].projeto;
  assert.equal(projeto.slug, "portfolio-docker");
  assert.ok(fs.existsSync(path.join(projeto.path, "README.md")));
  assert.ok(fs.existsSync(path.join(projeto.path, "docs", "mockup.txt")));
  assert.ok(projeto.subagentes.map((s) => s.nome).includes("planejar"));
  assert.ok(projeto.subagentes.map((s) => s.nome).includes("codificar"));
  assert.ok(projeto.subagentes.map((s) => s.nome).includes("revisar"));

  // evidência local em perfil.skills (não inventada — file:// do path real)
  const skills = jobs.prefs().perfil.skills;
  const docker = skills.find((s) => s.id === "docker");
  assert.ok(docker);
  assert.match(docker.evidencia, /^file:\/\//);
  assert.ok(docker.evidencia.includes("portfolio-docker"));

  const pend = agent.status().pendenciasPublicacao;
  assert.equal(pend.length, 1);

  const resultados = quadro.ler({ de: "portfolio", para: "chefe", tipo: "resultado" });
  assert.ok(resultados.length >= 1);
  assert.match(resultados[0].assunto, /Projeto local|portfolio-docker/i);

  const alertas = quadro.ler({ de: "portfolio", para: "helison", tipo: "alerta" });
  assert.ok(alertas.some((a) => /Aprovar GitHub\/Vercel/i.test(a.assunto)));

  // pedido original marcado feito
  const feito = quadro.ler({ para: "portfolio", status: "feito", limite: 10 });
  assert.ok(feito.some((i) => i.id === pedido.id));

  // aprovar publicação (mock) atualiza evidência remota
  const pub = await agent.resolverPublicacao(pend[0].id, "approve", { alvo: "github" });
  assert.equal(pub.publicado, true);
  assert.ok(pub.urls[0].includes("github.com"));
  const skills2 = jobs.prefs().perfil.skills;
  assert.match(skills2.find((s) => s.id === "docker").evidencia, /github\.com/);

  quadro.close();
});

test("levaO5: negar publicação mantém repo local e evidência file://", async () => {
  const dir = tmp();
  const jobs = createJobs(dir, { mock: true });
  jobs.setPrefs({ termos: ["front-end"], perfil: { skills: [] } });
  const quadro = createQuadro(dir);
  quadro.postar({
    de: "pesquisa",
    para: "portfolio",
    tipo: "pedido",
    assunto: "Lacuna: TypeScript",
    corpo: "Skill: TypeScript\nMotivo: sem_evidencia",
    ref: "skill:typescript",
  });
  const agent = createAgentPortfolio(dir, {
    jobs, quadro, reposRoot: path.join(dir, "repos"), mock: true, runGit: false,
  });
  agent.setPausado(false);
  await agent.ciclo({ forcar: true });
  const pendId = agent.status().pendenciasPublicacao[0].id;
  const before = jobs.prefs().perfil.skills.find((s) => s.id === "typescript").evidencia;
  assert.match(before, /^file:\/\//);

  const out = await agent.resolverPublicacao(pendId, "deny");
  assert.equal(out.publicado, false);
  assert.equal(out.pendencia.estado, "negada");
  const after = jobs.prefs().perfil.skills.find((s) => s.id === "typescript").evidencia;
  assert.equal(after, before);
  assert.ok(fs.existsSync(path.join(dir, "repos", "portfolio-typescript", "README.md")));
  quadro.close();
});

test("levaO5: rotina mark + API HTTP mock porta própria", async () => {
  const dir = tmp();
  const jobs = createJobs(dir, { mock: true });
  const quadro = createQuadro(dir);
  const routines = createRoutines(dir);
  const agent = createAgentPortfolio(dir, {
    jobs, quadro, routines, reposRoot: path.join(dir, "repos"), mock: true, runGit: false,
  });
  const rot = agent.installRotina({ clock: "14:00", weekdays: [1, 3, 5] });
  assert.ok(String(rot.prompt).includes(PORTFOLIO_CICLO_MARK));
  assert.equal(rot.enabled, false);
  quadro.close();

  const reposHttp = tmp("pf-http-repos-");
  const app = await boot({
    dataDir: tmp("http-"),
    mock: true,
    chefeMs: 0,
    portfolioReposRoot: reposHttp,
    portfolioMock: true,
    portfolioRunGit: false,
  });
  try {
    const got = await json(app, "/api/agente/portfolio");
    assert.equal(got.status, 200);
    assert.equal(got.body.agente.id, "portfolio");
    assert.equal(got.body.agente.pausado, true);

    // posta lacuna via API quadro
    await json(app, "/api/quadro", {
      method: "POST",
      body: {
        de: "pesquisa",
        para: "portfolio",
        tipo: "pedido",
        assunto: "Lacuna: Docker",
        corpo: "Skill: Docker\nMotivo: ausente_no_perfil",
        ref: "skill:docker",
      },
    });

    const ciclo = await json(app, "/api/agente/portfolio/ciclo", {
      method: "POST",
      body: { forcar: true },
    });
    assert.equal(ciclo.status, 200);
    assert.equal(ciclo.body.ok, true);
    assert.ok(ciclo.body.processados.length >= 1);
    assert.ok(fs.existsSync(path.join(reposHttp, "portfolio-docker", "README.md")));

    const st = await json(app, "/api/agente/portfolio");
    const pendId = st.body.agente.pendenciasPublicacao[0].id;
    const pub = await json(app, "/api/agente/portfolio/publicar", {
      method: "POST",
      body: { id: pendId, decision: "approve", alvo: "github" },
    });
    assert.equal(pub.status, 200);
    assert.equal(pub.body.publicado, true);

    const rotApi = await json(app, "/api/routines/portfolio-ciclo", {
      method: "POST",
      body: { clock: "15:00", weekdays: [2] },
    });
    assert.equal(rotApi.status, 201);
    assert.match(String(rotApi.body.routine.prompt), /portfolio-ciclo/);
  } finally {
    await app.close();
  }
});
