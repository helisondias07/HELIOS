"use strict";
// LEVA O6: agente Oasis — ClickUp (token/conector) → plano → execução no repo
// só com aprovação → comentário/status ClickUp só com aprovação. Isolado de emprego.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createAgentOasis,
  proporPlano,
  resolveRepoPath,
  slugify,
  isEmpregoTask,
  OASIS_CICLO_MARK,
  SUBAGENTES,
} = require("../server/agent-oasis");
const { createQuadro } = require("../server/quadro");
const { createRoutines } = require("../server/routines");
const { boot, json } = require("./helpers-ideias");

const tmp = (prefix = "helios-levaO6-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function mockClient(tasks) {
  const comments = [];
  const statuses = [];
  return {
    listAssigned: async () => tasks.slice(),
    comment: async (taskId, text) => {
      comments.push({ taskId, text });
      return { ok: true, taskId };
    },
    setStatus: async (taskId, status) => {
      statuses.push({ taskId, status });
      return { ok: true, taskId, status };
    },
    _comments: comments,
    _statuses: statuses,
  };
}

test("levaO6: slugify, proporPlano e isolamento emprego", () => {
  assert.equal(slugify("Hero Home Sneakers"), "hero-home-sneakers");
  const plano = proporPlano({
    id: "t1",
    name: "Implementar Hero",
    description: "repo: sneakers\nFigma frame X",
    listName: "Sneakers",
    url: "https://app.clickup.com/t/t1",
  });
  assert.equal(plano.taskId, "t1");
  assert.match(plano.resumo, /Hero/i);
  assert.ok(plano.passos.length >= 3);
  assert.equal(isEmpregoTask({ name: "Candidatura LinkedIn front", description: "" }), true);
  assert.equal(isEmpregoTask({ name: "Hero da home", description: "Wake" }), false);
});

test("levaO6: resolveRepoPath a partir de repo: na descrição", () => {
  const root = tmp("oas-repos-");
  const abs = path.join(root, "sneakers");
  const p = resolveRepoPath({ name: "X", description: `repo: ${abs}` }, root);
  assert.equal(p, path.normalize(abs));
  const rel = resolveRepoPath({ name: "Demo Task", description: "" }, root);
  assert.equal(rel, path.join(root, "demo-task"));
});

test("levaO6: sem ClickUp → configNeeded e alerta no quadro", async () => {
  const dir = tmp();
  const quadro = createQuadro(dir);
  const agent = createAgentOasis(dir, {
    quadro,
    mock: true,
    reposRoot: path.join(dir, "repos"),
    getClickUpToken: () => "",
    hasClickUpConnector: () => false,
  });
  const st0 = agent.status();
  assert.equal(st0.clickupConfigurado, false);
  assert.equal(st0.pausado, true);

  agent.setPausado(false);
  const ciclo = await agent.ciclo({ forcar: true });
  assert.equal(ciclo.ok, false);
  assert.equal(ciclo.motivo, "clickup_nao_configurado");
  assert.equal(ciclo.configNeeded, true);

  const alertas = quadro.ler({ de: "oasis", para: "helison", tipo: "alerta" });
  assert.ok(alertas.some((a) => /Configure o ClickUp/i.test(a.assunto)));
  // não mistura emprego
  assert.ok(!alertas.some((a) => /vaga|emprego/i.test(`${a.assunto} ${a.corpo}`)));
  quadro.close();
});

test("levaO6: ciclo propõe plano, execução e ClickUp só com aprovação", async () => {
  const dir = tmp();
  const repos = path.join(dir, "repos");
  const quadro = createQuadro(dir);
  const client = mockClient([
    {
      id: "cu-100",
      name: "Hero da home",
      description: `repo: ${path.join(repos, "sneakers")}\nImplementar hero igual Figma.`,
      listName: "Sneakers",
      url: "https://app.clickup.com/t/cu-100",
    },
    {
      id: "cu-emprego",
      name: "Candidatura vaga front-end",
      description: "LinkedIn easy apply",
      listName: "Pessoal",
    },
  ]);

  const agent = createAgentOasis(dir, {
    quadro,
    reposRoot: repos,
    mock: true,
    clickupClient: client,
  });
  assert.deepEqual(agent.status().subagentes, [...SUBAGENTES]);

  agent.setPausado(false);
  const ciclo = await agent.ciclo({ forcar: true });
  assert.equal(ciclo.ok, true);
  // emprego filtrado: só 1 processada
  assert.equal(ciclo.processados.length, 1);
  assert.equal(ciclo.processados[0].tarefa.taskId, "cu-100");

  const pend = agent.status().pendencias;
  assert.equal(pend.length, 1);
  assert.equal(pend[0].tipo, "execucao");

  // ainda não escreveu no repo nem no ClickUp
  assert.ok(!fs.existsSync(path.join(repos, "sneakers", ".helios", "oasis-plano.md")));
  assert.equal(client._comments.length, 0);

  const exec = await agent.resolver(pend[0].id, "approve");
  assert.equal(exec.executado, true);
  assert.equal(exec.clickup, false);
  assert.ok(fs.existsSync(exec.arquivoPlano));
  const md = fs.readFileSync(exec.arquivoPlano, "utf8");
  assert.match(md, /Hero da home/);
  assert.match(md, /Passos/);
  assert.equal(client._comments.length, 0);

  const pend2 = agent.status().pendencias;
  assert.equal(pend2.length, 1);
  assert.equal(pend2[0].tipo, "clickup");

  const cu = await agent.resolver(pend2[0].id, "approve");
  assert.equal(cu.clickup, true);
  assert.equal(client._comments.length, 1);
  assert.equal(client._statuses.length, 1);
  assert.ok(!JSON.stringify(cu).includes("pk_"));
  assert.ok(!JSON.stringify(agent.status()).match(/pk_|Bearer /i));

  const resultados = quadro.ler({ de: "oasis", para: "chefe", tipo: "resultado" });
  assert.ok(resultados.some((r) => /ClickUp atualizado|Plano Oasis|Executado local/i.test(r.assunto)));
  // isolamento: nada de emprego no quadro do oasis
  assert.ok(!resultados.some((r) => /candidatura|vaga/i.test(`${r.assunto} ${r.corpo}`)));
  quadro.close();
});

test("levaO6: negar execução não grava repo nem ClickUp", async () => {
  const dir = tmp();
  const repos = path.join(dir, "repos");
  const quadro = createQuadro(dir);
  const client = mockClient([
    { id: "cu-2", name: "Banner promo", description: `repo: ${path.join(repos, "loja")}`, listName: "Wake" },
  ]);
  const agent = createAgentOasis(dir, { quadro, reposRoot: repos, mock: true, clickupClient: client });
  agent.setPausado(false);
  await agent.ciclo({ forcar: true });
  const id = agent.status().pendencias[0].id;
  const out = await agent.resolver(id, "deny");
  assert.equal(out.executado, false);
  assert.ok(!fs.existsSync(path.join(repos, "loja", ".helios", "oasis-plano.md")));
  assert.equal(client._comments.length, 0);
  quadro.close();
});

test("levaO6: rotina mark + API HTTP mock porta própria", async () => {
  const dir = tmp();
  const quadro = createQuadro(dir);
  const routines = createRoutines(dir);
  const agent = createAgentOasis(dir, {
    quadro, routines, reposRoot: path.join(dir, "repos"), mock: true,
    clickupClient: mockClient([]),
  });
  const rot = agent.installRotina({ clock: "09:30", weekdays: [1, 3, 5] });
  assert.ok(String(rot.prompt).includes(OASIS_CICLO_MARK));
  assert.equal(rot.enabled, false);
  quadro.close();

  const reposHttp = tmp("oas-http-repos-");
  const tasks = [
    {
      id: "http-1",
      name: "Ajuste CSS header",
      description: `repo: ${path.join(reposHttp, "sneakers")}`,
      listName: "Sneakers",
    },
  ];
  const client = mockClient(tasks);
  const app = await boot({
    dataDir: tmp("http-"),
    mock: true,
    chefeMs: 0,
    oasisReposRoot: reposHttp,
    oasisMock: true,
    clickupClient: client,
  });
  try {
    const got = await json(app, "/api/agente/oasis");
    assert.equal(got.status, 200);
    assert.equal(got.body.agente.id, "oasis");
    assert.equal(got.body.agente.pausado, true);
    assert.equal(got.body.agente.clickupConfigurado, true);

    const ciclo = await json(app, "/api/agente/oasis/ciclo", {
      method: "POST",
      body: { forcar: true },
    });
    assert.equal(ciclo.status, 200);
    assert.equal(ciclo.body.ok, true);
    assert.ok(ciclo.body.processados.length >= 1);

    const st = await json(app, "/api/agente/oasis");
    const pendId = st.body.agente.pendencias[0].id;
    const exec = await json(app, "/api/agente/oasis/aprovar", {
      method: "POST",
      body: { id: pendId, decision: "approve" },
    });
    assert.equal(exec.status, 200);
    assert.equal(exec.body.executado, true);
    assert.ok(fs.existsSync(path.join(reposHttp, "sneakers", ".helios", "oasis-plano.md")));

    const st2 = await json(app, "/api/agente/oasis");
    const cuId = st2.body.agente.pendencias.find((p) => p.tipo === "clickup").id;
    const cu = await json(app, "/api/agente/oasis/aprovar", {
      method: "POST",
      body: { id: cuId, decision: "approve" },
    });
    assert.equal(cu.status, 200);
    assert.equal(cu.body.clickup, true);
    assert.equal(client._comments.length, 1);

    const rotApi = await json(app, "/api/routines/oasis-ciclo", {
      method: "POST",
      body: { clock: "10:00", weekdays: [2] },
    });
    assert.equal(rotApi.status, 201);
    assert.match(String(rotApi.body.routine.prompt), /oasis-ciclo/);
  } finally {
    await app.close();
  }
});
