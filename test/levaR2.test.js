"use strict";

/**
 * LEVA R2: cadeia ultra+reservas; Chefe via roteador gratis com fallback;
 * fill-privacy no jobs-host (sem PII no prompt; para antes de enviar).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFreeLlm, chainFor, ROLE_MODELS } = require("../server/free-llm");
const { createChefe, scrubPii } = require("../server/chefe");
const { createQuadro } = require("../server/quadro");
const { createAssistants } = require("../server/assistants");
const { createMissions } = require("../server/missions");
const { registerJobs } = require("../src/jobs-host");
const { buildFillMessages } = require("../server/fill-privacy");

const tmp = (prefix = "helios-levaR2-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const KEYS = { nvidia: "nvapi-FAKE-levaR2", gemini: "gm-FAKE-levaR2" };
const reply = (status, body, headers = {}) => ({
  status,
  ok: status < 300,
  headers: { get: (h) => headers[h.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const msg = (m) => ({ choices: [{ message: m }] });

const CADEIA_ESPERADA = [
  "nvidia/nemotron-3-ultra-550b-a55b",
  "minimaxai/minimax-m3.1-flash",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "z-ai/glm-5.3-flash",
  "deepseek-ai/deepseek-v4.1-flash",
  "moonshotai/kimi-k2.6",
  "gemini-3.8-flash",
];

test("levaR2: cadeia chefe/vagas na ordem (ultra → reservas → gemini), sem duplicatas", () => {
  assert.deepEqual(ROLE_MODELS.chefe, ["nvidia/nemotron-3-ultra-550b-a55b"]);
  assert.deepEqual(ROLE_MODELS.vagas, ["nvidia/nemotron-3-ultra-550b-a55b"]);
  assert.deepEqual(ROLE_MODELS.reservas, [
    "minimaxai/minimax-m3.1-flash",
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "z-ai/glm-5.3-flash",
    "deepseek-ai/deepseek-v4.1-flash",
    "moonshotai/kimi-k2.6",
  ]);
  for (const agent of ["chefe", "vagas"]) {
    const models = chainFor(agent).map((m) => m.model);
    assert.deepEqual(models, CADEIA_ESPERADA, agent);
    assert.equal(new Set(models).size, models.length, `${agent}: sem duplicatas`);
  }
});

test("levaR2: Chefe usa o roteador gratis com fallback da cadeia; sem chave mantém regras", async () => {
  const dir = tmp();
  const assistants = createAssistants(dir);
  assistants.seedBuiltins();
  const missions = createMissions(dir);
  const quadro = createQuadro(dir);

  const called = [];
  const llm = createFreeLlm({
    getKey: (k) => KEYS[k],
    sleep: async () => {},
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      called.push(body.model);
      // primeiro modelo falha; segundo responde com destino
      if (body.model === CADEIA_ESPERADA[0]) return reply(404, { error: "Function not found for account" });
      return reply(200, msg({ role: "assistant", content: JSON.stringify({ destino: "vagas" }) }));
    },
  });

  const chefe = createChefe(dir, { quadro, missions, assistants, llm });
  quadro.postar({
    de: "helison",
    para: "chefe",
    tipo: "pedido",
    assunto: "Priorizar front-end",
    corpo: "Quero candidatura em vagas React junior remoto.",
  });
  const ciclo = await chefe.ciclo({ forcar: true });
  assert.equal(ciclo.ok, true);
  assert.ok(ciclo.delegados.some((d) => d.destino === "vagas"), JSON.stringify(ciclo));
  assert.ok(called.includes(CADEIA_ESPERADA[0]), "tentou ultra primeiro");
  assert.ok(called.includes(CADEIA_ESPERADA[1]), "caiu na reserva minimax");
  assert.ok(!scrubPii("CPF 123.456.789-09 e teste@exemplo.invalid").includes("123.456.789-09"));
  assert.ok(!scrubPii("fone +55 11 90000-0000").includes("90000"));

  // Sem llm: comportamento atual (regras) não quebra
  const quadro2 = createQuadro(tmp());
  const chefe2 = createChefe(tmp(), {
    quadro: quadro2,
    missions: createMissions(tmp()),
    assistants: createAssistants(tmp()),
  });
  quadro2.postar({
    de: "helison",
    para: "chefe",
    tipo: "pedido",
    assunto: "Buscar vagas LinkedIn",
    corpo: "Inscrição em vaga de emprego front-end.",
  });
  const c2 = await chefe2.ciclo({ forcar: true });
  assert.equal(c2.ok, true);
  assert.ok(c2.delegados.some((d) => d.destino === "vagas"));
  quadro.close();
  quadro2.close();
});

test("levaR2: Chefe nao manda CPF/telefone/email/endereco no prompt do modelo", async () => {
  const dir = tmp();
  const bodies = [];
  const llm = createFreeLlm({
    getKey: (k) => KEYS[k],
    fetchImpl: async (_u, init) => {
      bodies.push(init.body);
      return reply(200, msg({ role: "assistant", content: JSON.stringify({ destino: "pesquisa" }) }));
    },
  });
  const quadro = createQuadro(dir);
  const chefe = createChefe(dir, {
    quadro,
    missions: createMissions(dir),
    assistants: createAssistants(dir),
    llm,
  });
  const secrets = {
    cpf: "12345678909",
    telefone: "+55 11 98888-7777",
    email: "helison@exemplo.invalid",
    endereco: "Rua Ficticia 100, Recife",
  };
  quadro.postar({
    de: "helison",
    para: "chefe",
    tipo: "pedido",
    assunto: `Skill Docker CPF ${secrets.cpf}`,
    corpo: `Telefone ${secrets.telefone} e-mail ${secrets.email} endereco ${secrets.endereco}. Estudar lacuna Docker.`,
  });
  await chefe.ciclo({ forcar: true });
  const prompt = bodies.join("\n");
  for (const v of Object.values(secrets)) {
    assert.ok(!prompt.includes(v), `vazou no prompt do Chefe: ${v}`);
  }
  quadro.close();
});

test("levaR2: fill nao manda CPF/e-mail/telefone ao modelo e para antes de enviar", async () => {
  const secrets = {
    cpf: "98765432100",
    telefone: "+55 21 97777-6666",
    email: "candidato@exemplo.invalid",
    nome: "Fulano Teste R2",
    endereco: "Av Teste 42",
  };
  const bodies = [];
  let submitClicks = 0;
  const llm = createFreeLlm({
    getKey: (k) => KEYS[k],
    fetchImpl: async (_u, init) => {
      bodies.push(init.body);
      return reply(200, msg({
        role: "assistant",
        content: JSON.stringify({
          respostas: [
            { i: 0, valor: "{{CPF}}" },
            { i: 1, valor: "{{TELEFONE}}" },
            { i: 2, valor: "{{EMAIL}}" },
            { i: 3, valor: "Gosto de front-end." },
          ],
        }),
      }));
    },
  });

  const ipcMain = { handle() {} };
  const vault = {
    getKey: (k) => (k === "cpf" ? secrets.cpf : ""),
    platforms: () => [],
    index: () => [],
  };
  const host = registerJobs({
    ipcMain,
    BrowserWindow: class {},
    vault,
    serverUrl: () => "http://127.0.0.1:1",
    getApiToken: () => "token-teste",
    mock: true,
    freeLlm: llm,
    readProfile: () => "",
  });

  const vaga = {
    id: "vg_r2_1",
    status: "aprovada",
    title: "Dev Front-end",
    company: "ACME R2",
    description: "Vaga ficticia React",
    platform: "linkedin",
    url: "https://example.invalid/job/1",
    mockFields: [
      { sel: "#cpf", type: "text", label: "CPF", required: true },
      { sel: "#tel", type: "text", label: "Telefone celular", required: true },
      { sel: "#mail", type: "email", label: "E-mail", required: true },
      { sel: "#pq", type: "text", label: "Por que voce quer a vaga?", required: true },
    ],
  };

  const profile = {
    nome: secrets.nome,
    email: secrets.email,
    telefone: secrets.telefone,
    endereco: secrets.endereco,
  };

  const out = await host.preencherAprovada(vaga, { profile, respostas: {} });
  assert.equal(out.ok, true);
  assert.equal(out.paradoAntesDeEnviar, true);
  assert.equal(out.enviado, false);
  assert.equal(out.via, "llm");
  assert.ok(Array.isArray(out.acoes));
  const bySel = Object.fromEntries(out.acoes.map((a) => [a.sel, a.valor]));
  assert.equal(bySel["#cpf"], secrets.cpf);
  assert.equal(bySel["#tel"], secrets.telefone);
  assert.equal(bySel["#mail"], secrets.email);
  assert.equal(bySel["#pq"], "Gosto de front-end.");

  const prompt = bodies.join("\n") + JSON.stringify(buildFillMessages(vaga, vaga.mockFields));
  for (const v of [secrets.cpf, secrets.telefone, secrets.email, secrets.endereco]) {
    assert.ok(!prompt.includes(v), `vazou no prompt do fill: ${v}`);
  }
  assert.equal(submitClicks, 0, "nada foi submetido");

  // Sem aprovacao: recusa
  const neg = await host.preencherAprovada({ ...vaga, status: "nova" }, { profile });
  assert.equal(neg.ok, false);
  assert.match(String(neg.error || ""), /aprovad/i);

  // LLM falha → cai no planFill atual, ainda para antes de enviar
  const llmFail = createFreeLlm({
    getKey: () => "",
    fetchImpl: async () => { throw new Error("sem rede"); },
  });
  const host2 = registerJobs({
    ipcMain: { handle() {} },
    BrowserWindow: class {},
    vault,
    serverUrl: () => "http://127.0.0.1:1",
    getApiToken: () => "t",
    mock: true,
    freeLlm: llmFail,
    readProfile: () => "",
  });
  const vagaSimples = {
    ...vaga,
    mockFields: [
      { sel: "#nome", type: "text", label: "Nome completo", required: true },
      { sel: "#mail", type: "email", label: "E-mail", required: true },
    ],
  };
  const fallback = await host2.preencherAprovada(vagaSimples, { profile });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.paradoAntesDeEnviar, true);
  assert.equal(fallback.via, "rules");
  assert.equal(fallback.enviado, false);
});
