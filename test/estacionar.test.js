"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { boot, json, idle, say, inbox, runRoutine } = require("./helpers-ideias");

const PARK = "estacione a tarefa: Candidatar nas vagas da Gupy | feito: li 3 vagas; separei 2 | falta: enviar o currículo | pergunta: Posso enviar o currículo para a vaga da Acme? | motivo: aprovacao";
const readParked = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "estacionadas.json"), "utf8")).items;

test("estacionar: grava o estado em disco, abre a pergunta com Retomar, termina livre e sobrevive a reiniciar", async () => {
  const dataDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "helios-park-"));
  let app = await boot({ dataDir });
  let convId;
  try {
    const conv = await say(app, PARK);
    convId = conv.id;
    assert.equal(conv.busy, false, "a conversa termina e não fica ocupada");
    const box = await inbox(app);
    assert.equal(box.count, 1);
    const item = box.items[0];
    assert.equal(item.kind, "question");
    assert.equal(item.summary, "Posso enviar o currículo para a vaga da Acme?");
    assert.deepEqual(item.options, ["Retomar"]);
    assert.equal(item.parked.objetivo, "Candidatar nas vagas da Gupy");
    assert.deepEqual(item.parked.feito, ["li 3 vagas", "separei 2"]);
    assert.deepEqual(item.parked.falta, ["enviar o currículo"]);
    assert.equal(item.parked.motivo, "aprovacao");
    const saved = readParked(dataDir);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].state, "estacionada");
    assert.equal(saved[0].convId, convId);
    assert.equal(saved[0].questionId, item.id);

    // O mesmo objetivo estacionado de novo atualiza, não duplica.
    await say(app, PARK.replace("li 3 vagas", "li 4 vagas"), convId);
    assert.equal((await inbox(app)).count, 1);
    assert.deepEqual(readParked(dataDir)[0].feito, ["li 4 vagas", "separei 2"]);
  } finally {
    await app.close();
  }

  // Reinício do app: o estado e o item da Caixa de entrada continuam lá.
  app = await boot({ dataDir });
  try {
    const box = await inbox(app);
    assert.equal(box.count, 1);
    assert.equal(box.items[0].parked.objetivo, "Candidatar nas vagas da Gupy");
    assert.equal((await json(app, "/api/estacionadas")).body.items.length, 1);

    // "Retomar" sem texto: continua do estado salvo.
    const res = await json(app, `/api/conversations/${box.items[0].convId}/questions/${box.items[0].id}`, { method: "POST", body: { answer: "" } });
    assert.equal(res.status, 200);
    const conv = await idle(app, box.items[0].convId);
    const resume = conv.messages.filter((message) => message.role === "user").pop().text;
    assert.match(resume, /^Resposta à sua pergunta/);
    assert.match(resume, /TAREFA ESTACIONADA/);
    assert.match(resume, /Candidatar nas vagas da Gupy/);
    assert.match(resume, /li 4 vagas/);
    assert.match(resume, /enviar o currículo/);
    assert.match(resume, /continuam passando por cartão de aprovação/);
    assert.equal((await inbox(app)).count, 0);
    assert.equal(readParked(dataDir)[0].state, "retomada");
    assert.equal((await json(app, "/api/estacionadas")).body.items.length, 0);
  } finally {
    await app.close();
  }
});

test("estacionar: texto com cara de segredo é recusado e descartar tira da Caixa de entrada", async () => {
  const app = await boot();
  try {
    const conv = await say(app, "estacione a tarefa: Entrar no site do banco | feito: nada | falta: logar | pergunta: Use senha: abc12345 para entrar? | motivo: informacao");
    assert.equal(conv.busy, false);
    assert.equal((await inbox(app)).count, 0, "nada foi estacionado");
    assert.equal((await json(app, "/api/estacionadas")).body.items.length, 0);
    assert.match(conv.messages.filter((message) => message.role === "assistant").pop().text, /Não guardo isso/);

    await say(app, PARK);
    const box = await inbox(app);
    assert.equal(box.count, 1);
    const res = await json(app, `/api/conversations/${box.items[0].convId}/questions/${box.items[0].id}`, { method: "POST", body: { dismiss: true } });
    assert.equal(res.status, 200);
    assert.equal((await inbox(app)).count, 0);
    assert.equal((await json(app, "/api/estacionadas")).body.items.length, 0, "descartada não volta");
  } finally {
    await app.close();
  }
});

test("estacionar: ajudante estaciona, sai sem ficar ocupado e Retomar volta para a conversa que o criou", async () => {
  const app = await boot();
  try {
    const conv = await say(app, "crie um ajudante para estacionar a tarefa: Revisar propostas | feito: abri o painel | falta: confirmar o valor | pergunta: Qual o valor máximo? | motivo: informacao");
    assert.equal(conv.busy, false);
    const activity = (await json(app, "/api/atividade")).body;
    assert.equal(activity.active, 0, "nenhum ajudante fica ativo esperando");
    const box = await inbox(app);
    assert.equal(box.count, 1);
    assert.equal(box.items[0].origin, "ajudante");
    assert.match(box.items[0].originLabel, /ajudante de/);
    assert.equal(box.items[0].parked.objetivo, "Revisar propostas");

    const res = await json(app, `/api/conversations/${box.items[0].convId}/questions/${box.items[0].id}`, { method: "POST", body: { answer: "No máximo R$ 500" } });
    assert.equal(res.status, 200);
    const parent = await idle(app, conv.id);
    const resume = parent.messages.filter((message) => message.role === "user").pop().text;
    assert.match(resume, /No máximo R\$ 500/);
    assert.match(resume, /TAREFA ESTACIONADA/);
    assert.match(resume, /abri o painel/);
    assert.equal((await inbox(app)).count, 0);
    assert.equal((await json(app, `/api/conversations/${box.items[0].convId}`)).status, 404, "a conversa descartável do ajudante some");
  } finally {
    await app.close();
  }
});

test("estacionar: ajudante que estoura o tempo máximo estaciona sozinho (limite) e dá para retomar", async () => {
  process.env.HELIOS_MOCK_DELAY = "300";
  const app = await boot({ helperTimeoutMs: 40 });
  try {
    const conv = await say(app, "crie um ajudante para olhar a Gupy");
    assert.match(conv.messages.filter((message) => message.role === "assistant").pop().text, /tempo esgotado/);
    const box = await inbox(app);
    assert.equal(box.count, 1);
    assert.equal(box.items[0].parked.motivo, "limite");
    assert.match(box.items[0].summary, /passou do tempo máximo/);
    assert.match(box.items[0].parked.objetivo, /olhar a Gupy/);
    process.env.HELIOS_MOCK_DELAY = "0";
    const res = await json(app, `/api/conversations/${box.items[0].convId}/questions/${box.items[0].id}`, { method: "POST", body: { answer: "Pode tentar de novo" } });
    assert.equal(res.status, 200);
    const parent = await idle(app, conv.id);
    assert.match(parent.messages.filter((message) => message.role === "user").pop().text, /TAREFA ESTACIONADA/);
  } finally {
    await app.close();
    delete process.env.HELIOS_MOCK_DELAY;
  }
});

test("estacionar: rotina estaciona na própria conversa e Retomar continua nela", async () => {
  const app = await boot();
  try {
    const out = await runRoutine(app, "Vagas da manhã", PARK);
    assert.equal(out.status, "pendente");
    const box = await inbox(app);
    assert.equal(box.count, 1);
    assert.equal(box.items[0].origin, "rotina");
    assert.equal(box.items[0].parked.objetivo, "Candidatar nas vagas da Gupy");
    const res = await json(app, `/api/conversations/${box.items[0].convId}/questions/${box.items[0].id}`, { method: "POST", body: { answer: "Sim, pode" } });
    assert.equal(res.status, 200);
    const conv = await idle(app, box.items[0].convId);
    assert.equal(conv.title, "Rotina: Vagas da manhã");
    assert.match(conv.messages.filter((message) => message.role === "user").pop().text, /Sim, pode[\s\S]*TAREFA ESTACIONADA/);
  } finally {
    await app.close();
  }
});