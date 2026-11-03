"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createFreeLlm, providerFor, FREE_MODELS, chainFor } = require("../server/free-llm");
const { planFillLlm, buildFillMessages } = require("../server/fill-privacy");

const KEYS = { nvidia: "nvapi-FAKE-test-key", gemini: "gm-FAKE-test-key" };
const reply = (status, body, headers = {}) => ({ status, ok: status < 300, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) });
const msg = (m) => ({ choices: [{ message: m }] });

test("Vagas e Pesquisa no gratis; Oasis e Portfolio no Cursor", () => {
  assert.equal(providerFor("Vagas"), "gratis");
  assert.equal(providerFor("pesquisa"), "gratis");
  assert.equal(providerFor("Oasis"), "cursor");
  assert.equal(providerFor("Portfólio"), "cursor");
});

test("IDs dos modelos NIM conferidos (Leva R2)", () => {
  const ids = FREE_MODELS.map((m) => m.model);
  for (const id of ["nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3.5-lightning-30b-a3b", "deepseek-ai/deepseek-v4.1-flash", "nvidia/nemotron-3.5-super-vl-120b-a12b", "z-ai/glm-5.3-flash", "minimaxai/minimax-m3.1-flash", "moonshotai/kimi-k2.6", "gemini-3.8-flash"]) assert.ok(ids.includes(id), id);
  assert.equal(chainFor("vagas")[0].model, "nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(chainFor("chefe")[0].model, "nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(chainFor("x", { role: "dificil" })[0].model, "nvidia/nemotron-3-ultra-550b-a55b");
  const chefeChain = chainFor("chefe").map((m) => m.model);
  assert.deepEqual(chefeChain, [
    "nvidia/nemotron-3-ultra-550b-a55b",
    "minimaxai/minimax-m3.1-flash",
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "z-ai/glm-5.3-flash",
    "deepseek-ai/deepseek-v4.1-flash",
    "moonshotai/kimi-k2.6",
    "gemini-3.8-flash",
  ]);
  assert.equal(new Set(chefeChain).size, chefeChain.length, "sem duplicatas na cadeia");
});

test("429: espera, troca de modelo e cai no Cursor por ultimo", async () => {
  const calls = []; const waits = [];
  const llm = createFreeLlm({
    getKey: (k) => KEYS[k], sleep: async (ms) => { waits.push(ms); },
    fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body).model); return reply(429, {}, { "retry-after": "1" }); },
    cursorFallback: async () => "resposta do cursor",
  });
  const r = await llm.chat({ agent: "vagas", messages: [{ role: "user", content: "oi" }] });
  assert.equal(r.provider, "cursor");
  assert.equal(r.message.content, "resposta do cursor");
  assert.equal(calls.length, chainFor("vagas").length * 2);
  assert.ok(waits.every((w) => w === 1000));
});

test("429 no primeiro modelo -> segundo responde", async () => {
  let n = 0;
  const llm = createFreeLlm({ getKey: (k) => KEYS[k], sleep: async () => {}, fetchImpl: async () => (++n <= 2 ? reply(429, {}) : reply(200, msg({ role: "assistant", content: "ok" }))) });
  const r = await llm.chat({ agent: "pesquisa", messages: [{ role: "user", content: "x" }] });
  assert.equal(r.model, chainFor("pesquisa")[1].model);
});

test("sem chave pula o provedor, e a chave nunca aparece no erro", async () => {
  const llm = createFreeLlm({ getKey: () => "", fetchImpl: async () => { throw new Error("nao deveria chamar"); } });
  await assert.rejects(llm.chat({ messages: [] }), /Nenhum modelo/);
  const llm2 = createFreeLlm({ getKey: (k) => KEYS[k], sleep: async () => {}, fetchImpl: async (u, i) => reply(500, { echo: i.headers.authorization }) });
  const err = await llm2.chat({ messages: [] }).catch((e) => e);
  assert.ok(!JSON.stringify(err.tentativas).includes("FAKE-test-key"));
});

test("loop de agente com tool calling chama ferramenta do HELIOS", async () => {
  let step = 0; const seen = [];
  const llm = createFreeLlm({ getKey: (k) => KEYS[k], fetchImpl: async () => {
    step++;
    if (step === 1) return reply(200, msg({ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "helios_listar_tarefas", arguments: "{\"status\":\"aberta\"}" } }] }));
    return reply(200, msg({ role: "assistant", content: "feito" }));
  } });
  const r = await llm.runAgent({ agent: "vagas", user: "liste", tools: [{ name: "helios_listar_tarefas", handler: async (a) => { seen.push(a); return "[]"; } }] });
  assert.equal(r.text, "feito");
  assert.deepEqual(seen, [{ status: "aberta" }]);
  assert.equal(r.chamadas[0].name, "helios_listar_tarefas");
});

test("loop de agente para na primeira pendência humana", async () => {
  let calls = 0;
  const llm = createFreeLlm({
    getKey: () => "gsk_testkey1234",
    roleModels: { chefe: ["modelo-teste"], reservas: [] },
    fetchImpl: async () => {
      calls += 1;
      return reply(200, { choices: [{ message: { role: "assistant", content: "", tool_calls: [
        { id: "a", type: "function", function: { name: "aprovar", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "nao_deveria_rodar", arguments: "{}" } },
      ] } }] });
    },
  });
  let executed = 0;
  const out = await llm.runAgent({
    agent: "chefe", user: "Faça a ação", tools: [
      { name: "aprovar", description: "Pede aprovação", parameters: { type: "object" }, handler: async () => { executed += 1; return "PENDENTE — cartão apr_1 na Caixa de entrada"; } },
      { name: "nao_deveria_rodar", description: "Não executar", parameters: { type: "object" }, handler: async () => { executed += 10; return "não"; } },
    ],
  });
  assert.equal(calls, 1);
  assert.equal(executed, 1);
  assert.equal(out.interrompido, true);
  assert.match(out.text, /PENDENTE/);
});

test("privacidade: CPF, telefone, endereco e CV nunca entram no prompt; codigo preenche do cofre", async () => {
  const secrets = { cpf: "12345678909", telefone: "+55 11 90000-0000", endereco: "Rua Ficticia 123, Cidade Teste", cvPath: "C:\\ficticio\\cv-teste.pdf", email: "teste@exemplo.invalid", nome: "Fulano Teste" };
  const fields = [
    { sel: "#cpf", label: "CPF", required: true }, { sel: "#tel", label: "Telefone celular", required: true },
    { sel: "#end", label: "Endereço", required: true }, { sel: "#cv", label: "Currículo", type: "file", required: true },
    { sel: "#mail", label: "E-mail" }, { sel: "#pq", label: "Por que voce quer a vaga?", required: true },
  ];
  const bodies = [];
  const llm = createFreeLlm({ getKey: (k) => KEYS[k], fetchImpl: async (u, init) => {
    bodies.push(init.body);
    return reply(200, msg({ role: "assistant", content: JSON.stringify({ respostas: [{ i: 0, valor: "99999999999" }, { i: 1, valor: "{{TELEFONE}}" }, { i: 5, valor: "Gosto de dados." }] }) }));
  } });
  const plan = await planFillLlm(llm, { title: "Dev", company: "ACME", description: "Vaga ficticia" }, fields, secrets);
  const prompt = bodies.join("\n") + JSON.stringify(buildFillMessages({}, fields));
  for (const v of Object.values(secrets)) assert.ok(!prompt.includes(v), `vazou no prompt: ${v}`);
  assert.ok(!prompt.includes("cv-teste.pdf"));
  const by = Object.fromEntries(plan.acoes.map((a) => [a.sel, a]));
  assert.equal(by["#cpf"].valor, "12345678909");
  assert.equal(by["#tel"].valor, secrets.telefone);
  assert.equal(by["#end"].valor, secrets.endereco);
  assert.equal(by["#cv"].kind, "file");
  assert.equal(by["#pq"].valor, "Gosto de dados.");
});
