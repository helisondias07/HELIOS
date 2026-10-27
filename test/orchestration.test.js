"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Captura os prompts que chegam aos agentes (conversa, ajudante, consulta). Precisa vir antes do servidor.
const mockAgent = require("../server/mock-agent");
const prompts = [];
const realCreate = mockAgent.createMockAgent;
mockAgent.createMockAgent = (opts) => {
  const agent = realCreate(opts);
  const realSend = agent.send;
  agent.send = (message, extra) => {
    prompts.push({ text: typeof message === "string" ? message : message?.text || "", tools: Object.keys(opts.tools || {}) });
    return realSend.call(agent, message, extra);
  };
  return agent;
};

const { startServer } = require("../server/index");
const { createOrchestration, LIMIT_SPECS } = require("../server/orchestration");
const { createContexts } = require("../server/context");
const { createAssistants } = require("../server/assistants");
const { createDelegation } = require("../server/delegation");
const { planSummary, extractiveSummary } = require("../server/summary");
const { TOOLS } = require("../server/mcp-server");

const TOKEN = "token-de-teste-orquestracao";
const tmp = (prefix = "helios-orq-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

async function boot(extra = {}) {
  const dataDir = extra.dataDir || tmp();
  return startServer({
    dataDir,
    projectsDir: path.join(dataDir, "projetos"),
    port: 0,
    mock: true,
    routineMs: 0,
    getMcpToken: () => TOKEN,
    getVaultIndex: () => [{ id: "login_1", tipo: "login", nome: "GitHub", senha: "senha-super-secreta" }],
    onFillLogin: async () => ({ ok: true }),
    ...extra,
  });
}

async function json(app, pathname, opts = {}) {
  const res = await fetch(`${app.url}${pathname}`, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${app.apiToken()}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function chat(app, text, convId) {
  const id = convId || (await json(app, "/api/conversations", { method: "POST", body: {} })).body.conversation.id;
  await json(app, `/api/conversations/${id}/messages`, { method: "POST", body: { text } });
  for (let i = 0; i < 200; i += 1) {
    const { body } = await json(app, `/api/conversations/${id}`);
    if (!body.conversation.busy) return body.conversation;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("a conversa não ficou pronta");
}

const lastText = (conv) => [...conv.messages].reverse().find((message) => message.role === "assistant").text;
const pendingOf = (conv) => conv.messages.filter((message) => message.state === "pending");
const activity = async (app) => (await json(app, "/api/atividade")).body;
const inbox = async (app) => (await json(app, "/api/inbox")).body;

test("limites: padrões conservadores, pisos e tetos, e persistência", () => {
  const dir = tmp();
  const orch = createOrchestration(dir);
  assert.deepEqual(
    { a: orch.limits().maxSimultaneos, b: orch.limits().profundidade, c: orch.limits().ajudantesPorConversa, d: orch.limits().assistentesCriadosPorBots, e: orch.limits().contextoMaxCaracteres },
    { a: 3, b: 1, c: 10, d: 5, e: 6000 },
  );
  orch.setLimits({ maxSimultaneos: 99, profundidade: 9, tempoAjudanteSeg: 1 });
  assert.equal(orch.limits().maxSimultaneos, 20);
  assert.equal(orch.limits().profundidade, 2);
  assert.equal(orch.limits().tempoAjudanteSeg, LIMIT_SPECS.tempoAjudanteSeg.min);
  assert.throws(() => orch.setLimits({ maxSimultaneos: "abc" }), /inválido/);
  assert.equal(createOrchestration(dir).limits().maxSimultaneos, 20);
  fs.writeFileSync(path.join(dir, "orquestracao.json"), "{ quebrado");
  assert.equal(createOrchestration(dir).limits().maxSimultaneos, 3);
});

test("registro: simultâneos, profundidade e limite por conversa devolvem erro claro em português", async () => {
  const orch = createOrchestration(tmp());
  orch.setLimits({ maxSimultaneos: 2, ajudantesPorConversa: 3 });
  const base = { assistantId: "default", assistantName: "HELIOS", rootConvId: "conv_a", task: "tarefa" };
  const one = orch.start(base);
  const two = orch.start(base);
  assert.ok(one.helper && two.helper);
  const third = orch.start(base);
  assert.match(third.error, /2 ajudantes ativos \(limite: 2\)/);
  assert.match(orch.start({ ...base, depth: 2 }).error, /não cria outros ajudantes/);
  orch.finish(one.helper.id, "done", "FEITO: x");
  assert.ok(orch.start(base).helper);
  orch.finish(two.helper.id, "done", "ok");
  assert.match(orch.start(base).error, /já criou 3 ajudantes \(limite: 3\)/);
  assert.ok(orch.start({ ...base, rootConvId: "conv_b" }).helper, "outra conversa tem a própria cota");
  orch.setLimits({ profundidade: 2, maxSimultaneos: 5 });
  assert.ok(orch.start({ ...base, rootConvId: "conv_c", depth: 2 }).helper);
});

test("registro: contadores, encerramento, interrompidos e nada de segredo no relatório gravado", async () => {
  const dir = tmp();
  const orch = createOrchestration(dir);
  let cancelled = false;
  const { helper } = orch.start({ assistantId: "ast_x", assistantName: "X", rootConvId: "c", task: "vagas", cancel: async () => { cancelled = true; } });
  assert.equal(orch.helpers()[0].active, true);
  assert.equal(await orch.stop(helper.id), true);
  assert.equal(cancelled, true);
  assert.equal(orch.wasStopped(helper.id), true);
  const fake = `gsk_${"abcdefghijklmnop1234"}`;
  const done = orch.finish(helper.id, "done", `FEITO: chave ${fake}`);
  assert.equal(done.state, "encerrado");
  assert.equal(done.summary.includes(fake), false);
  assert.equal(await orch.stop(helper.id), false);
  orch.bump("ast_x", "consultas");
  assert.equal(orch.stats().total.ajudantesCriados, 1);
  assert.equal(orch.stats().total.consultas, 1);
  assert.equal(orch.statsFor("ast_x").ajudantesCriados, 1);
  // Tokens só entram quando o SDK informa.
  assert.equal(orch.addUsage("ast_x", "ajudantes", null), false);
  assert.equal(orch.addUsage("ast_x", "ajudantes", { totalTokens: 1234 }), true);
  assert.equal(orch.stats().total.tokens.ajudantes, 1234);
  // Um "rodando" que ficou no disco (queda) volta como interrompido.
  const file = path.join(dir, "orquestracao.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.recent.push({ id: "ajd_velho", task: "x", assistantId: "default", assistantName: "HELIOS", depth: 1, state: "rodando", startedAt: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(createOrchestration(dir).helpers().find((item) => item.id === "ajd_velho").state, "interrompido");
});

test("contexto: itens ativos, arquivar, buscar só sob demanda e compactar até caber", () => {
  const dir = tmp();
  let limit = 6000;
  const contexts = createContexts(dir, { getLimit: () => limit });
  const own = contexts.for("ast_vagas");
  const gupy = own.add("Vaga Dev Front-end na Gupy: aberta, enviar currículo").item;
  own.add("Vaga React na Catho: aberta, aguardando retorno");
  assert.match(own.promptText(), /Contexto ativo/);
  assert.match(own.promptText(), /Gupy/);
  assert.throws(() => own.add("minha senha: abc12345678"), /senha/);
  assert.throws(() => own.add("token ghp_abcdefghijklmnop1234"), /chave|token/);
  own.archiveItem(gupy.id, "vaga fechada");
  assert.equal(own.promptText().includes("Gupy"), false, "o arquivo morto não entra no prompt");
  assert.equal(own.view().archived, 1);
  assert.match(own.searchArchive("gupy currículo")[0].motivo, /fechada/);
  assert.equal(own.searchArchive("assunto sem relação").length, 0);
  assert.throws(() => own.archiveItem("não existe"), /Não achei/);
  // Compactação: o mais antigo sai primeiro até caber.
  const small = contexts.for("ast_pequeno");
  limit = 200;
  for (let i = 0; i < 6; i += 1) small.add(`Item numero ${i} com texto suficiente para ocupar espaço no contexto ${"x".repeat(30)}`);
  assert.ok(small.chars() <= 200);
  assert.ok(small.view().archived >= 3);
  limit = 6000;
  const before = small.view().archived;
  assert.equal(small.compact().moved, 0);
  assert.equal(small.view().archived, before);
  // Persistência e remoção.
  assert.equal(createContexts(dir, { getLimit: () => limit }).for("ast_vagas").view().archived, 1);
  contexts.drop("ast_vagas");
  assert.equal(fs.existsSync(path.join(dir, "contexto-ast_vagas.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "arquivo-ast_vagas.json")), false);
});

test("resumo: só em lotes, cobre o antigo e deixa as últimas mensagens", () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", status: "done", text: `mensagem ${i}` }));
  const none = planSummary({ messages, summary: null, keep: 4, afterMessages: 30, afterChars: 99999 });
  assert.equal(none.triggered, false);
  assert.equal(none.update, false);
  const first = planSummary({ messages, summary: null, keep: 4, afterMessages: 6, afterChars: 99999 });
  assert.equal(first.update, true);
  assert.equal(first.older.length, 8);
  assert.deepEqual(first.recent.map((m) => m.id), ["m8", "m9", "m10", "m11"]);
  const text = extractiveSummary("", first.fresh);
  assert.match(text, /Helison: mensagem 0/);
  const summary = { text, upTo: "m7" };
  const more = [...messages, { id: "m12", role: "user", text: "mensagem 12" }];
  const wait = planSummary({ messages: more, summary, keep: 4, afterMessages: 6, afterChars: 99999 });
  assert.equal(wait.update, false, "menos de um lote novo: reaproveita o resumo");
  assert.equal(wait.recent[0].id, "m8", "o que o resumo não cobre continua como mensagem");
  const big = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, role: "user", text: "palavra ".repeat(60) }));
  assert.ok(extractiveSummary("", big).length <= 1200);
  assert.match(extractiveSummary("", big), /^\(…\)/);
});

test("consulta entre assistentes: sozinho, desconhecido, ciclo A→B→A e profundidade bloqueados", async () => {
  const dir = tmp();
  const assistants = createAssistants(dir);
  const a = assistants.create({ name: "Alfa" });
  const b = assistants.create({ name: "Beta" });
  const c = assistants.create({ name: "Gama" });
  const d = assistants.create({ name: "Delta" });
  const orch = createOrchestration(dir);
  let runs = 0;
  const delegation = createDelegation({
    store: { get: () => null },
    assistants,
    memories: { for: () => ({ context: () => ({ text: "" }) }) },
    contexts: createContexts(dir),
    orchestration: orch,
    autonomy: { mode: () => "pedir" },
    openEphemeral: async () => {
      runs += 1;
      return mockAgent.createMockAgent({ tools: {} });
    },
    resolveAuth: () => null,
    catalogFor: async () => null,
    makeBaseTools: () => ({ tools: {} }),
  });
  const ctx = (assistantId, chain) => ({ kind: "conversa", assistantId, rootConvId: "conv_x", depth: 0, chain, allowed: null });
  assert.match(await delegation.runConsult(ctx(a.id, [a.id]), { assistente: "Alfa", pergunta: "oi?" }), /consultar a si mesmo/);
  assert.match(await delegation.runConsult(ctx(a.id, [a.id]), { assistente: "Zeta", pergunta: "oi?" }), /Não achei o assistente.*Beta/);
  assert.match(await delegation.runConsult(ctx(b.id, [a.id, b.id]), { assistente: "Alfa", pergunta: "volta?" }), /circular bloqueada \(Alfa → Beta → Alfa\)/);
  assert.equal(runs, 0, "nada rodou nos casos bloqueados");
  assert.match(await delegation.runConsult(ctx(c.id, [a.id, b.id, c.id]), { assistente: "Delta", pergunta: "e agora?" }), /Limite de consultas encadeadas \(2\)/);
  assert.match(await delegation.runConsult(ctx(a.id, [a.id]), { assistente: "Beta", pergunta: "tudo bem?" }), /^Resposta de Beta:/);
  assert.equal(runs, 1);
  assert.equal(orch.statsFor(a.id).consultas, 2 - 1, "só consulta que rodou conta");
  assert.equal(d.name, "Delta");
});

test("ajudante: contexto mínimo, relatório curto, sessão descartada e contadores", async () => {
  prompts.length = 0;
  const app = await boot();
  try {
    await json(app, "/api/memory", { method: "POST", body: { text: "O Helison mora em Fortaleza e prefere respostas curtas", kind: "fato" } });
    const first = await chat(app, "lembra que o Helison mora em Fortaleza");
    assert.ok(first);
    const before = prompts.length;
    const conv = await chat(app, "crie um ajudante para olhar vagas na Gupy");
    assert.match(lastText(conv), /^RELATÓRIO DO AJUDANTE \(concluído\):/);
    assert.match(lastText(conv), /FEITO:.*ACHEI: nada encontrado/s);
    assert.ok(lastText(conv).length <= 1700);
    const helperPrompt = prompts.slice(before).map((item) => item.text).find((text) => text.includes("## Tarefa do ajudante"));
    assert.ok(helperPrompt, "o ajudante recebeu o prompt de ajudante");
    assert.match(helperPrompt, /Seja breve/);
    assert.equal(helperPrompt.includes("Conversa recente"), false, "sem o histórico do pai");
    assert.equal(helperPrompt.includes("Fortaleza"), false, "sem a memória do pai");
    assert.equal(helperPrompt.includes("senha-super-secreta"), false);
    assert.ok(helperPrompt.length < 2500, `prompt do ajudante pequeno (${helperPrompt.length})`);
    const data = await activity(app);
    assert.equal(data.helpers.length, 1);
    assert.equal(data.helpers[0].state, "concluído");
    assert.equal(data.helpers[0].assistantName, "HELIOS");
    assert.equal(data.active, 0);
    assert.equal(data.stats.total.ajudantesCriados, 1);
    assert.match(data.tokens.note, /só contagens/);
    // A conversa descartável do ajudante não aparece na lista nem fica gravada.
    const list = (await json(app, "/api/conversations")).body.conversations;
    assert.equal(list.some((item) => String(item.title).startsWith("Ajudante:")), false);
    const stored = JSON.parse(fs.readFileSync(path.join(app.dataDir, "conversations.json"), "utf8"));
    assert.equal(stored.items.some((item) => item.helper), false);
  } finally {
    await app.close();
  }
});

test("ajudante: ferramentas não passam das permitidas e da lista de ajudante", async () => {
  prompts.length = 0;
  const app = await boot();
  try {
    const conv = await chat(app, "crie um ajudante para pesquisar vagas ferramentas: pesquisar_web, memory_save, criar_assistente");
    assert.match(lastText(conv), /Ferramentas ignoradas.*memory_save.*criar_assistente/);
    const helperCall = prompts.find((item) => item.text.includes("## Tarefa do ajudante"));
    assert.deepEqual(helperCall.tools, ["pesquisar_web"]);
    const padrao = await chat(app, "crie um ajudante para resumir o dia");
    assert.ok(padrao);
    const second = prompts.filter((item) => item.text.includes("## Tarefa do ajudante"))[1];
    for (const proibida of ["memory_save", "memory_forget", "agendar_rotina", "iniciar_livecoding", "criar_assistente", "arquivar_item", "criar_ajudante", "consultar_assistente"]) {
      assert.equal(second.tools.includes(proibida), false, `ajudante não recebe ${proibida}`);
    }
    assert.ok(second.tools.includes("helios_acao"));
    const only = await chat(app, "crie um ajudante para olhar vagas ferramentas: memory_save");
    assert.match(lastText(only), /Nenhuma das ferramentas pedidas/);
  } finally {
    await app.close();
  }
});

test("ajudante: aprovações aparecem na Caixa de entrada como “ajudante de …” e pagar continua travado", async () => {
  const app = await boot();
  try {
    await json(app, "/api/autonomy", { method: "POST", body: { modes: { enviar: "pedir" } } });
    const conv = await chat(app, "crie um ajudante para enviar um e-mail de status ao cliente");
    assert.match(lastText(conv), /1 item\(ns\) esperam o Helison na Caixa de entrada/);
    const box = await inbox(app);
    assert.equal(box.count, 1);
    assert.equal(box.items[0].origin, "ajudante");
    assert.equal(box.items[0].originLabel, "ajudante de HELIOS");
    assert.equal(box.items[0].tipo, "enviar");
    const helperConv = box.items[0].convId;
    assert.notEqual(helperConv, conv.id);
    const decided = await json(app, `/api/conversations/${helperConv}/approvals/${box.items[0].id}`, { method: "POST", body: { decision: "approve" } });
    assert.equal(decided.status, 200);
    assert.equal((await inbox(app)).count, 0);
    assert.equal((await json(app, `/api/conversations/${helperConv}`)).status, 404, "a conversa do ajudante some depois da decisão");

    // Pagar e preencher login pedem antes mesmo dentro de um ajudante.
    const pay = await chat(app, "crie um ajudante para pagar a conta de luz");
    assert.ok(pay);
    const fill = await chat(app, "crie um ajudante para preencher login GitHub");
    assert.ok(fill);
    const pending = (await inbox(app)).items;
    assert.deepEqual(pending.map((item) => item.tipo).sort(), ["pagar", "preencher"]);
    assert.ok(pending.every((item) => item.origin === "ajudante"));
    assert.equal(JSON.stringify(pending).includes("senha-super-secreta"), false);
  } finally {
    await app.close();
  }
});

test("ajudante herda no máximo a autonomia do pai: ‘pedir’ do assistente vale para o ajudante", async () => {
  const app = await boot();
  try {
    await json(app, "/api/autonomy", { method: "POST", body: { modes: { enviar: "sozinho" } } });
    const pai = (await json(app, "/api/assistants", { method: "POST", body: { name: "Pai", autonomy: { enviar: "pedir" } } })).body.assistant;
    const convPai = (await json(app, "/api/conversations", { method: "POST", body: { assistantId: pai.id } })).body.conversation.id;
    await chat(app, "crie um ajudante para enviar o relatório", convPai);
    assert.equal((await inbox(app)).count, 1, "assistente com ‘pedir’: o ajudante também pede");
    const geral = await chat(app, "crie um ajudante para enviar o relatório de novo");
    assert.ok(geral);
    // Ajudantes e rotinas sempre pedem para enviar/apagar/publicar, mesmo com 'sozinho' liberado (automaticoPede, ligado por padrão).
    assert.equal((await inbox(app)).count, 2, "'sozinho' geral não vale dentro de ajudante: ele abre o cartão");
    // Quem desliga a trava em Autonomia volta ao comportamento antigo: 'sozinho' vale para o ajudante.
    await json(app, "/api/autonomy", { method: "POST", body: { automaticoPede: false } });
    await chat(app, "crie um ajudante para enviar o relatório mais uma vez");
    assert.equal((await inbox(app)).count, 2, "com a trava desligada, 'sozinho' liberado: o ajudante não abre outro cartão");
  } finally {
    await app.close();
  }
});

test("profundidade: por padrão ajudante não cria ajudante; com 2, cria um nível a mais", async () => {
  const app = await boot();
  try {
    await chat(app, "crie um ajudante para crie um ajudante para olhar a Catho");
    assert.equal((await activity(app)).stats.total.ajudantesCriados, 1);
    await json(app, "/api/atividade/limites", { method: "POST", body: { profundidade: 2 } });
    await chat(app, "crie um ajudante para crie um ajudante para olhar a Catho");
    const data = await activity(app);
    assert.equal(data.stats.total.ajudantesCriados, 3);
    assert.deepEqual(data.helpers.map((item) => item.depth).sort(), [1, 1, 2]);
  } finally {
    await app.close();
  }
});

test("limite de ajudantes por conversa devolve erro em português ao agente", async () => {
  const app = await boot();
  try {
    await json(app, "/api/atividade/limites", { method: "POST", body: { ajudantesPorConversa: 1 } });
    const conv = await chat(app, "crie um ajudante para olhar a Gupy");
    const again = await chat(app, "crie um ajudante para olhar a Catho", conv.id);
    assert.match(lastText(again), /já criou 1 ajudantes \(limite: 1\)/);
    assert.equal((await activity(app)).stats.total.ajudantesCriados, 1);
  } finally {
    await app.close();
  }
});

test("botão Encerrar interrompe um ajudante ativo e o tempo máximo também", async () => {
  process.env.HELIOS_MOCK_DELAY = "250";
  const app = await boot();
  try {
    const id = (await json(app, "/api/conversations", { method: "POST", body: {} })).body.conversation.id;
    await json(app, `/api/conversations/${id}/messages`, { method: "POST", body: { text: "crie um ajudante para olhar a Gupy" } });
    let live = null;
    for (let i = 0; i < 100 && !live; i += 1) {
      live = (await activity(app)).helpers.find((item) => item.active);
      if (!live) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(live, "ajudante ativo aparece na lista");
    assert.equal(live.state, "rodando");
    assert.equal((await json(app, `/api/atividade/ajudantes/${live.id}/encerrar`, { method: "POST", body: {} })).status, 200);
    let conv;
    for (let i = 0; i < 100; i += 1) {
      conv = (await json(app, `/api/conversations/${id}`)).body.conversation;
      if (!conv.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(lastText(conv), /encerrado pelo Helison/);
    const done = (await activity(app)).helpers.find((item) => item.id === live.id);
    assert.equal(done.state, "encerrado");
    assert.equal((await json(app, `/api/atividade/ajudantes/${live.id}/encerrar`, { method: "POST", body: {} })).status, 404);
  } finally {
    await app.close();
    delete process.env.HELIOS_MOCK_DELAY;
  }

  process.env.HELIOS_MOCK_DELAY = "300";
  const slow = await boot({ helperTimeoutMs: 40 });
  try {
    const conv = await chat(slow, "crie um ajudante para olhar a Gupy");
    assert.match(lastText(conv), /tempo esgotado/);
    assert.equal((await activity(slow)).helpers[0].state, "tempo esgotado");
  } finally {
    await slow.close();
    delete process.env.HELIOS_MOCK_DELAY;
  }
});

test("consultar_assistente: roda no contexto do outro assistente, sem vazar o do chamador", async () => {
  prompts.length = 0;
  const app = await boot();
  try {
    const estudos = (await json(app, "/api/assistants", { method: "POST", body: { template: "estudos" } })).body.assistant;
    await json(app, "/api/memory", { method: "POST", body: { assistantId: estudos.id, text: "Plano de estudos: React na terça e inglês na quinta", kind: "fato" } });
    await json(app, "/api/memory", { method: "POST", body: { text: "O Helison guarda segredo de estado sobre Fortaleza", kind: "fato" } });
    const conv = await chat(app, "consulte Estudos: o que estudar na terça?");
    assert.match(lastText(conv), /^Resposta de Estudos:/);
    const consult = prompts.find((item) => item.text.includes("## Pergunta de outro assistente"));
    assert.ok(consult);
    assert.match(consult.text, /tutor do Helison/);
    assert.match(consult.text, /React na terça/);
    assert.equal(consult.text.includes("Fortaleza"), false);
    assert.ok(consult.text.length < 3500);
    const stats = (await activity(app)).stats;
    assert.equal(stats.total.consultas, 1);
    assert.equal(stats.byAssistant.default.consultas, 1);
    const missing = await chat(app, "consulte Fantasma: oi?");
    assert.match(lastText(missing), /Não achei o assistente “Fantasma”/);
  } finally {
    await app.close();
  }
});

test("criar_assistente: pede aprovação, nasce pendente, nunca herda mais e respeita os limites", async () => {
  const app = await boot();
  try {
    await json(app, "/api/autonomy", { method: "POST", body: { modes: { enviar: "sozinho" } } });
    const pai = (await json(app, "/api/assistants", { method: "POST", body: { name: "Pai", mcp: ["gmail"], autonomy: { enviar: "pedir", ler: "pedir" } } })).body.assistant;
    const convPai = (await json(app, "/api/conversations", { method: "POST", body: { assistantId: pai.id } })).body.conversation.id;
    const conv = await chat(app, "crie o assistente Vagas: Busca de vagas de emprego", convPai);
    const card = pendingOf(conv)[0];
    assert.equal(card.kind, "assistente");
    assert.match(card.summary, /Criar o assistente “Vagas”/);
    assert.match(card.detail, /Pedido por Pai/);
    const listed = (await json(app, "/api/assistants")).body;
    assert.equal(listed.assistants.some((item) => item.name === "Vagas"), false, "pendente não existe ainda");
    assert.equal(listed.pending[0].createdBy.name, "Pai");
    assert.equal((await inbox(app)).items[0].kind, "approval");

    // Nega: nunca chega a existir.
    await json(app, `/api/conversations/${convPai}/approvals/${card.id}`, { method: "POST", body: { decision: "deny" } });
    assert.equal((await json(app, "/api/assistants")).body.pending.length, 0);

    // Aprova: passa a existir, marcado “criado por Pai”, com autonomia e conectores dentro do pai.
    const again = await chat(app, "crie o assistente Vagas: Busca de vagas de emprego", convPai);
    const card2 = pendingOf(again)[0];
    const approved = await json(app, `/api/conversations/${convPai}/approvals/${card2.id}`, { method: "POST", body: { decision: "approve" } });
    assert.equal(approved.status, 200);
    const final = (await json(app, "/api/assistants")).body;
    const filho = final.assistants.find((item) => item.name === "Vagas");
    assert.ok(filho);
    assert.deepEqual(filho.createdBy, { assistantId: pai.id, name: "Pai" });
    assert.deepEqual(filho.mcp, ["gmail"]);
    assert.equal(filho.autonomy.enviar, "pedir", "não herda o ‘sozinho’ geral: fica no do pai");
    assert.equal(filho.autonomy.ler, "pedir");
    assert.equal("pagar" in filho.autonomy || "preencher" in filho.autonomy, false);
    assert.equal(final.pending.length, 0);

    // Profundidade 1: assistente criado por bot não cria outro.
    const convFilho = (await json(app, "/api/conversations", { method: "POST", body: { assistantId: filho.id } })).body.conversation.id;
    const nope = await chat(app, "crie o assistente Neto: teste", convFilho);
    assert.equal(pendingOf(nope).length, 0);

    // Limite de assistentes criados por bots.
    await json(app, "/api/atividade/limites", { method: "POST", body: { assistentesCriadosPorBots: 1 } });
    const over = await chat(app, "crie o assistente Outro: teste", convPai);
    assert.equal(pendingOf(over).length, 0);
    assert.equal((await activity(app)).stats.total.assistentesCriados, 2);
  } finally {
    await app.close();
  }
});

test("criar_assistente: o assistente padrão não pode ser sobrescrito e nome repetido é recusado", async () => {
  const app = await boot();
  try {
    const conv = await chat(app, "crie o assistente HELIOS: tentando repetir o nome");
    assert.equal(pendingOf(conv).length, 0);
    assert.equal((await json(app, "/api/assistants")).body.pending.length, 0);
  } finally {
    await app.close();
  }
});

test("contexto: registrar, arquivar e buscar pelo agente; só o ativo entra no prompt", async () => {
  prompts.length = 0;
  const app = await boot();
  try {
    const conv = await chat(app, "registre no contexto: Vaga Dev Front-end na Gupy está aberta");
    assert.match(lastText(conv), /Registrei no contexto \(ctx_/);
    await chat(app, "registre no contexto: Vaga React na Catho está aberta", conv.id);
    const view = (await json(app, "/api/contexto/default")).body;
    assert.equal(view.items.length, 2);
    const archived = await chat(app, "arquive Gupy", conv.id);
    assert.match(lastText(archived), /Arquivei ctx_/);
    const after = (await json(app, "/api/contexto/default")).body;
    assert.equal(after.context.items, 1);
    assert.equal(after.context.archived, 1);
    prompts.length = 0;
    await chat(app, "bom dia", conv.id);
    const normal = prompts.map((item) => item.text).find((text) => text.includes("## Mensagem do Helison"));
    assert.match(normal, /Contexto ativo/);
    assert.match(normal, /Catho/);
    assert.equal(normal.includes("Dev Front-end na Gupy"), false, "o arquivo morto não é injetado");
    const found = await chat(app, "busque no arquivo Gupy", conv.id);
    assert.match(lastText(found), /Dev Front-end na Gupy/);
    assert.match(lastText(found), /concluído/);
    assert.equal(prompts.map((item) => item.text).join("\n").includes("arquivado:"), false);
  } finally {
    await app.close();
  }
});

test("contexto: compactar agora mantém o ativo abaixo do limite e mostra tamanhos na Atividade", async () => {
  const dataDir = tmp();
  const items = Array.from({ length: 8 }, (_, i) => ({
    id: `ctx_seed${i}`,
    text: `Item antigo numero ${i} ${"y".repeat(150)}`,
    createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
    updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
  }));
  fs.writeFileSync(path.join(dataDir, "contexto.json"), JSON.stringify({ version: 1, items }));
  const app = await boot({ dataDir });
  try {
    await json(app, "/api/atividade/limites", { method: "POST", body: { contextoMaxCaracteres: 1000 } });
    const before = (await activity(app)).assistants.find((item) => item.id === "default").context;
    assert.ok(before.chars > 1000);
    assert.equal(before.limit, 1000);
    const res = await json(app, "/api/contexto/default/compactar", { method: "POST", body: {} });
    assert.equal(res.status, 200);
    assert.ok(res.body.moved >= 1);
    assert.ok(res.body.context.chars <= 1000);
    const kept = (await json(app, "/api/contexto/default")).body.items.map((item) => item.id);
    assert.equal(kept.includes("ctx_seed0"), false, "o mais antigo foi arquivado");
    assert.equal(kept.includes("ctx_seed7"), true, "o mais novo ficou");
    assert.equal((await json(app, "/api/contexto/nao_existe/compactar", { method: "POST", body: {} })).status, 404);
  } finally {
    await app.close();
  }
});

test("resumo corrido: depois do limite a conversa vira ‘resumo + últimas mensagens’ e abre sessão nova", async () => {
  prompts.length = 0;
  const app = await boot();
  try {
    await json(app, "/api/atividade/limites", { method: "POST", body: { resumoAposMensagens: 6 } });
    let conv = await chat(app, "primeira pergunta sobre vagas");
    assert.equal(conv.summary, null);
    const firstAgent = JSON.parse(fs.readFileSync(path.join(app.dataDir, "conversations.json"), "utf8")).items[0].agentId;
    for (let i = 2; i <= 9; i += 1) conv = await chat(app, `pergunta numero ${i} sobre vagas`, conv.id);
    assert.ok(conv.summary && conv.summary.active, "indicador de contexto resumido");
    assert.ok(conv.summary.chars > 0 && conv.summary.chars <= 1200);
    assert.ok(conv.summary.covered >= 1);
    assert.match(conv.summary.text, /primeira pergunta sobre vagas/);
    const last = prompts[prompts.length - 1].text;
    assert.match(last, /## Resumo da conversa até aqui/);
    assert.match(last, /pergunta numero 9/);
    const history = last.split("Conversa recente:")[1] || "";
    assert.equal(history.includes("primeira pergunta"), false, "o antigo só está no resumo");
    const stored = JSON.parse(fs.readFileSync(path.join(app.dataDir, "conversations.json"), "utf8")).items[0];
    assert.ok(stored.summary.rollovers >= 1);
    assert.notEqual(stored.agentId, firstAgent, "sessão nova do agente depois de resumir");
    // A conversa curta não ganha resumo.
    const other = await chat(app, "só uma mensagem");
    assert.equal(other.summary, null);
  } finally {
    await app.close();
  }
});

test("pergunta de ajudante respondida na Caixa de entrada volta para a conversa que o criou", async () => {
  const app = await boot();
  try {
    const conv = await chat(app, "crie um ajudante para me pergunte qual vaga priorizar");
    assert.match(lastText(conv), /esperam o Helison/);
    const item = (await inbox(app)).items[0];
    assert.equal(item.kind, "question");
    assert.equal(item.origin, "ajudante");
    const answered = await json(app, `/api/conversations/${item.convId}/questions/${item.id}`, { method: "POST", body: { answer: "Gupy primeiro" } });
    assert.equal(answered.status, 200);
    let parent;
    for (let i = 0; i < 100; i += 1) {
      parent = (await json(app, `/api/conversations/${conv.id}`)).body.conversation;
      if (!parent.busy && parent.messages.some((m) => /Gupy primeiro/.test(m.text || ""))) break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.ok(parent.messages.some((m) => m.role === "user" && /Gupy primeiro/.test(m.text)));
    assert.equal((await inbox(app)).count, 0);
  } finally {
    await app.close();
  }
});

test("MCP local: só leitura da lista de ajudantes, nada de criar ou encerrar", async () => {
  const app = await boot();
  try {
    await chat(app, "crie um ajudante para olhar a Gupy");
    const names = TOOLS.map((tool) => tool.name);
    assert.ok(names.includes("helios_listar_ajudantes"));
    for (const name of names) {
      assert.equal(/(criar|encerrar|parar).*(ajudante|assistente)|(ajudante|assistente).*(criar|encerrar)/.test(name), false, name);
      assert.equal(/cofre|senha|vault|segredo|token|password/i.test(name), false, name);
    }
    const res = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "helios_listar_ajudantes", arguments: {} } }),
    });
    const body = await res.json();
    const data = JSON.parse(body.result.content[0].text);
    assert.equal(data.ajudantes.length, 1);
    assert.equal(data.ajudantes[0].estado, "concluído");
    assert.equal(data.contadores.ajudantesCriados, 1);
    const denied = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "criar_ajudante", arguments: { tarefa: "x" } } }),
    });
    const deniedBody = await denied.json();
    assert.ok(deniedBody.error || deniedBody.result?.isError, "criar_ajudante não existe no MCP");
  } finally {
    await app.close();
  }
});

test("interface: aba Atividade, indicador de contexto resumido e rótulos da Caixa de entrada existem", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  assert.match(html, /data-view="activity"/);
  assert.match(app, /activity: \["Atividade"/);
  assert.match(app, /view === "activity"\) loadActivity/);
  assert.match(app, /contexto resumido/);
  assert.match(app, /Compactar agora/);
  assert.match(app, /item\.originLabel/);
  assert.match(app, /Aprovar a criação de assistente/);
  assert.match(app, /criado por/);
  for (const key of Object.keys(LIMIT_SPECS)) assert.ok(typeof LIMIT_SPECS[key].label === "string", key);
});
