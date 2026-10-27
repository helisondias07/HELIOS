"use strict";

// Fase 1: modelo padrão de prompt, briefing de 4 campos, registro de fontes e verificador independente.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Captura os prompts que chegam aos agentes. Precisa vir antes de carregar o servidor.
const mockAgent = require("../server/mock-agent");
const prompts = [];
const realCreate = mockAgent.createMockAgent;
mockAgent.createMockAgent = (opts) => {
  const agent = realCreate(opts);
  const realSend = agent.send;
  agent.send = (message, extra) => {
    prompts.push(typeof message === "string" ? message : message?.text || "");
    return realSend.call(agent, message, extra);
  };
  return agent;
};

const { boot, json, say } = require("./helpers-ideias");
const { validateBriefing, FIELDS } = require("../server/briefing");
const { renderPrompt, outline, SECTIONS } = require("../server/prompt-template");
const { SYSTEM, LEVEL_NOTE, buildPrompt, consultPrompt, helperPrompt, verifierPrompt } = require("../server/agent-prompt");
const { createLedger, parseLedger, VERDICTS } = require("../server/ledger");
const { createOrchestration } = require("../server/orchestration");
const { createDelegation } = require("../server/delegation");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "helios-fase1-"));
const lastText = (conv) => [...conv.messages].reverse().find((message) => message.role === "assistant").text;
const FULL = { pergunta: "Quais vagas de front-end júnior abriram hoje?", fontes: ["Gupy", "LinkedIn"], formato: "lista de até 5 vagas", fronteira: "não se candidatar; parar nas 5 primeiras" };

// ---------- B. Briefing de 4 campos ----------

test("briefing: os 4 campos passam e aceitam lista em fontes", () => {
  const ok = validateBriefing(FULL);
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.briefing), FIELDS.map((field) => field.key));
  assert.equal(ok.briefing.fontes, "Gupy; LinkedIn");
});

test("briefing: cada campo que falta (ou vem curto/vazio) é nomeado no erro, em português", () => {
  for (const field of FIELDS) {
    const missing = validateBriefing({ ...FULL, [field.key]: undefined });
    assert.equal(missing.ok, false, field.key);
    assert.deepEqual(missing.missing, [field.key]);
    assert.match(missing.error, /^Briefing incompleto/);
    assert.match(missing.error, new RegExp(field.key));
    assert.match(missing.error, /Nada foi executado/);
    assert.equal(validateBriefing({ ...FULL, [field.key]: " .. " }).ok, false, "só pontuação não vale");
  }
  const none = validateBriefing({});
  assert.deepEqual(none.missing, ["pergunta", "fontes", "formato", "fronteira"]);
  assert.equal(validateBriefing(null).ok, false);
});

test("briefing: criar_ajudante declara os 4 campos como obrigatórios", () => {
  const dir = tmp();
  const delegation = createDelegation({
    store: { get: () => null },
    assistants: { resolve: () => ({ id: "default", name: "HELIOS", builtin: true }) },
    memories: { for: () => ({}) },
    contexts: { for: () => ({}) },
    orchestration: createOrchestration(dir),
    autonomy: { mode: () => "pedir" },
    openEphemeral: async () => mockAgent.createMockAgent({ tools: {} }),
    resolveAuth: () => null,
    catalogFor: async () => null,
    makeBaseTools: () => ({ tools: {} }),
  });
  const tool = delegation.tools("conv_x", { kind: "conversa", assistantId: "default", rootConvId: "conv_x", depth: 0, chain: ["default"], allowed: null }).criar_ajudante;
  for (const key of ["tarefa", "pergunta", "fontes", "formato", "fronteira"]) assert.ok(tool.inputSchema.required.includes(key), key);
});

test("briefing incompleto: erro claro ao assistente, nenhum ajudante criado nem contado", async () => {
  prompts.length = 0;
  const app = await boot();
  try {
    const conv = await say(app, "crie um ajudante para olhar vagas na Gupy sem briefing");
    assert.match(lastText(conv), /^Briefing incompleto: faltam .*pergunta, fontes, formato, fronteira/);
    assert.equal(prompts.some((text) => text.includes("## Tarefa do ajudante")), false, "nenhum agente de ajudante foi aberto");
    const data = (await json(app, "/api/atividade")).body;
    assert.equal(data.helpers.length, 0);
    assert.equal(data.stats.total.ajudantesCriados, 0, "não gasta o limite de ajudantes");
  } finally {
    await app.close();
  }
});

// ---------- A. Modelo padrão de prompt ----------

test("modelo padrão: seções na ordem papel, contexto, regras, formato, objetivo; vazias somem", () => {
  assert.deepEqual(SECTIONS, ["papel", "contexto", "regras", "formato", "objetivo"]);
  const text = renderPrompt({ headings: true, objetivo: "faça X", papel: "Sou Y", formato: ["a", "b"], regras: "", contexto: [null, "ctx"] });
  assert.equal(text, "## Papel\nSou Y\n\n## Contexto\nctx\n\n## Formato de saída\na\n\nb\n\n## Objetivo\nfaça X");
  assert.deepEqual(outline(text), ["Papel", "Contexto", "Formato de saída", "Objetivo"]);
  assert.equal(renderPrompt({}), "");
  assert.equal(renderPrompt({ papel: "A", objetivo: "B" }), "A\n\nB", "sem títulos por padrão");
});

test("modelo padrão: o prompt do assistente e o da consulta saem idênticos aos de antes", () => {
  const base = { text: "oi", level: "padrao", history: "Helison: a\nHELIOS: b", memoryText: "## Memória\n- x", vaultText: "## Cofre", assistantText: "## Assistente atual: Y", contextText: "## Contexto ativo", summaryText: "resumo" };
  const legacy = (a) => [
    SYSTEM,
    LEVEL_NOTE[a.level] || LEVEL_NOTE.padrao,
    a.assistantText,
    a.vaultText,
    a.memoryText,
    a.contextText,
    a.summaryText ? `## Resumo da conversa até aqui (mensagens mais antigas, já resumidas)\n${a.summaryText}` : "",
    a.history ? `Conversa recente:\n${a.history}` : "",
    `## Mensagem do Helison\n${a.text}`,
  ].filter(Boolean).join("\n\n");
  assert.equal(buildPrompt(base), legacy(base));
  const slim = { text: "só isso", level: "rapido" };
  assert.equal(buildPrompt(slim), legacy(slim));
  const consult = consultPrompt({ assistantText: "## Assistente atual: Z", memoryText: "mem", contextText: "", question: "e agora?", askerName: "Alfa" });
  assert.match(consult, /^Você responde, na função do assistente abaixo/);
  assert.ok(consult.endsWith("## Pergunta de outro assistente (Alfa)\ne agora?"));
  assert.deepEqual(consult.split("\n\n").slice(1), ["## Assistente atual: Z", "mem", "## Pergunta de outro assistente (Alfa)\ne agora?"], "mesma ordem e mesmos blocos de antes");
});

test("modelo padrão: o prompt do ajudante leva o briefing nas seções certas e a tarefa por último", () => {
  const { briefing } = validateBriefing(FULL);
  const text = helperPrompt({ task: "olhar vagas na Gupy", instructions: "Seja breve.", context: "Helison busca vaga júnior.", parentName: "HELIOS", briefing });
  assert.deepEqual(outline(text), ["Papel", "Contexto", "Regras e limites", "Formato de saída", "Tarefa do ajudante"]);
  assert.ok(text.endsWith("## Tarefa do ajudante\nolhar vagas na Gupy"), "a tarefa é a última seção");
  const at = (title) => text.indexOf(`## ${title}`);
  const inside = (needle, from, to) => text.indexOf(needle) > at(from) && text.indexOf(needle) < at(to);
  assert.ok(inside(briefing.pergunta, "Contexto", "Regras e limites"), "pergunta em Contexto");
  assert.ok(inside("Gupy; LinkedIn", "Contexto", "Regras e limites"), "fontes em Contexto");
  assert.ok(inside(briefing.fronteira, "Regras e limites", "Formato de saída"), "fronteira em Regras e limites");
  assert.ok(inside(briefing.formato, "Formato de saída", "Tarefa do ajudante"), "formato em Formato de saída");
  assert.match(text, /Criado por: HELIOS/);
  assert.match(text, /ACORDADAS.*CONTESTADAS.*NAO VERIFICADAS/s, "pede o registro de fontes");
  assert.ok(text.length < 2500, `prompt do ajudante continua pequeno (${text.length})`);
  const ver = verifierPrompt({ claim: "O preço caiu 30%", sources: ["https://x.com"], pergunta: "preço?" });
  assert.deepEqual(outline(ver), ["Papel", "Contexto", "Regras e limites", "Formato de saída", "Afirmação a verificar"]);
  assert.match(ver, /tentar DESMENTI-LA/);
});

test("ajudante de verdade: o briefing chega ao prompt do ajudante com as seções do modelo padrão", async () => {
  prompts.length = 0;
  const app = await boot();
  try {
    await say(app, "crie um ajudante para olhar vagas na Gupy");
    const helper = prompts.find((text) => text.includes("## Tarefa do ajudante"));
    assert.ok(helper);
    assert.deepEqual(outline(helper), ["Papel", "Contexto", "Regras e limites", "Formato de saída", "Tarefa do ajudante"]);
    assert.match(helper, /### Fronteira \(o que NÃO fazer e onde parar\)\nNão enviar, apagar, pagar nem publicar sem aprovação\./);
    assert.match(helper, /### Seja breve|### Instruções curtas\nSeja breve\./);
  } finally {
    await app.close();
  }
});

// ---------- C. Registro de fontes ----------

const REPORT = [
  "FEITO: li as vagas. ACHEI: 3 vagas. PENDENTE: nada.",
  "ACORDADAS:",
  "- A vaga A é remota | https://gupy.io/a | https://linkedin.com/a",
  "CONTESTADAS:",
  "- O salário da vaga B é 5 mil | https://gupy.io/b diz 5 mil | https://glassdoor.com/b diz 3 mil",
  "NAO VERIFICADAS:",
  "- [IMPORTANTE] A vaga C fecha amanhã | sem fonte",
  "- A empresa D está contratando",
].join("\n");

test("ledger: separa acordadas, contestadas e não verificadas, cada uma com a fonte", () => {
  const parsed = parseLedger(REPORT);
  assert.deepEqual(parsed.claims.map((claim) => claim.category), ["acordada", "contestada", "nao_verificada", "nao_verificada"]);
  assert.deepEqual(parsed.claims[0].sources, ["https://gupy.io/a", "https://linkedin.com/a"]);
  assert.equal(parsed.claims[1].sources.length, 2);
  assert.equal(parsed.claims[2].important, true);
  assert.deepEqual(parsed.claims[2].sources, []);
  assert.equal(parsed.stripped, "FEITO: li as vagas. ACHEI: 3 vagas. PENDENTE: nada.", "o relatório fica sem o bloco do registro");
  assert.deepEqual(parseLedger("FEITO: x. ACHEI: nada encontrado. PENDENTE: nada.").claims, []);
  assert.deepEqual(parseLedger("Não verificadas: nada\nAcordadas:\n- nenhuma").claims, []);
});

test("ledger: guarda em disco, volta ao reabrir e sem fonte nunca é acordada nem contestada", () => {
  const dir = tmp();
  const ledger = createLedger(dir);
  const text = `${REPORT}\nACORDADAS:\n- Afirmação sem fonte alguma`;
  const { entry } = ledger.record({ helperId: "ajd_1", assistantId: "default", assistantName: "HELIOS", task: "vagas", pergunta: "quais vagas?", text });
  assert.match(entry.id, /^reg_/);
  assert.deepEqual({ a: entry.counts.acordada, c: entry.counts.contestada, n: entry.counts.nao_verificada }, { a: 1, c: 1, n: 3 });
  const demoted = entry.claims.find((claim) => claim.text === "Afirmação sem fonte alguma");
  assert.equal(demoted.category, "nao_verificada");
  assert.equal(demoted.demoted, true);
  const file = path.join(dir, "registro-fontes.json");
  assert.ok(fs.existsSync(file), "arquivo no mesmo padrão de estacionadas.json / uso.json");
  const again = createLedger(dir);
  assert.equal(again.get(entry.id).claims.length, 5);
  assert.equal(again.summaryFor("ajd_1").id, entry.id);
  assert.equal(again.list({ assistantId: "outro" }).length, 0);
  assert.equal(again.list({ assistantId: "default" }).length, 1);
  assert.equal(again.record({ helperId: "ajd_2", text: "FEITO: nada" }).entry, null, "sem afirmações, nada é gravado");
  fs.writeFileSync(file, "{ quebrado");
  assert.equal(createLedger(dir).list().length, 0, "arquivo quebrado não derruba");
});

test("ledger: segredo no texto é mascarado antes de gravar", () => {
  const dir = tmp();
  const ledger = createLedger(dir);
  const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  ledger.record({ helperId: "ajd_s", text: `ACORDADAS:\n- A chave é ${secret} | https://x.com/${secret}` });
  assert.equal(fs.readFileSync(path.join(dir, "registro-fontes.json"), "utf8").includes(secret), false);
});

// ---------- D. Verificador independente ----------

test("verificador: só afirmação importante, só por alguém diferente de quem achou, só 3 estados", () => {
  assert.deepEqual(VERDICTS, ["confirmed", "needs_validation", "rejected"]);
  const ledger = createLedger(tmp());
  const { entry } = ledger.record({ helperId: "ajd_1", assistantId: "default", text: REPORT });
  const important = entry.claims.find((claim) => claim.important);
  assert.equal(important.verification.state, "needs_validation", "importante começa aguardando verificação");
  assert.equal(entry.claims.find((claim) => !claim.important).verification, null);
  assert.equal(entry.counts.importantes, 1);
  assert.throws(() => ledger.verify(entry.id, entry.claims[0].id, { verifierId: "ajd_9", state: "confirmed" }), /importantes/);
  assert.throws(() => ledger.verify(entry.id, important.id, { verifierId: "ajd_1", state: "confirmed" }), /diferente de quem achou/);
  assert.throws(() => ledger.verify(entry.id, important.id, { verifierId: "", state: "confirmed" }), /quem verificou/);
  assert.throws(() => ledger.verify(entry.id, important.id, { verifierId: "ajd_9", state: "talvez" }), /Estado inválido/);
  assert.throws(() => ledger.verify("reg_nao_existe", important.id, { verifierId: "ajd_9", state: "confirmed" }), /Não achei esse registro/);
  for (const state of VERDICTS) {
    const done = ledger.verify(entry.id, important.id, { verifierId: "ajd_9", state, note: `nota ${state}` });
    assert.equal(done.claim.verification.state, state);
  }
  const final = ledger.get(entry.id);
  assert.equal(final.claims.find((claim) => claim.important).verification.verifierId, "ajd_9");
  assert.equal(final.counts.verificacao.rejected, 1, "o último estado gravado vale");
  assert.equal(createLedger(path.dirname(ledger.file)).get(entry.id).claims.find((claim) => claim.important).verification.verifierId, "ajd_9", "sobrevive ao reiniciar");
});

test("verificador: desligado por padrão; ligado, um outro ajudante registra confirmed, rejected ou needs_validation", async () => {
  prompts.length = 0;
  const app = await boot();
  try {
    const conv = await say(app, "crie um ajudante para comparar bibliotecas com fontes");
    assert.match(lastText(conv), /^RELATÓRIO DO AJUDANTE \(concluído\):/);
    assert.match(lastText(conv), /REGISTRO DE FONTES reg_\w+: 1 acordada\(s\), 1 contestada\(s\), 2 não verificada\(s\); 3 importante\(s\)/);
    assert.match(lastText(conv), /\[contestada, importante\] A biblioteca X é a mais rápida \(fonte: https:\/\/exemplo\.com\/a diz que sim; https:\/\/exemplo\.com\/b diz que não\)/);
    assert.equal(lastText(conv).includes("ACORDADAS:"), false, "o bloco cru não vai duplicado ao assistente");

    // A interface lê o mesmo registro na aba Atividade.
    const data = (await json(app, "/api/atividade")).body;
    const reg = data.helpers[0].ledger;
    assert.deepEqual({ a: reg.counts.acordada, c: reg.counts.contestada, n: reg.counts.nao_verificada }, { a: 1, c: 1, n: 2 });
    assert.equal(reg.claims.every((claim) => Array.isArray(claim.sources)), true);
    assert.match(data.helpers[0].summary, /^FEITO:/, "resumo curto do ajudante segue como antes");
    assert.equal(data.helpers[0].summary.includes("ACORDADAS"), false, "sem o bloco cru do registro");
    const listed = (await json(app, "/api/registro-fontes")).body.items;
    assert.equal(listed.length, 1);
    assert.equal((await json(app, `/api/registro-fontes/${reg.id}`)).body.entry.claims.length, 4);
    assert.equal((await json(app, "/api/registro-fontes/reg_nao_existe")).status, 404);
    assert.equal((await json(app, "/api/registro-fontes", { method: "POST", body: {} })).status === 200, false, "só leitura");

    // Desligado por padrão: nada é aberto.
    const view = (await json(app, "/api/atividade")).body.limits.find((row) => row.key === "verificadorIndependente");
    assert.equal(view.value, 0);
    const before = prompts.length;
    const off = await say(app, `verifique a afirmação af_3 do registro ${reg.id}`, conv.id);
    assert.match(lastText(off), /verificador independente está desligado/);
    assert.equal(prompts.slice(before).some((text) => text.includes("## Afirmação a verificar")), false);

    // Ligado: um verificador por chamada.
    assert.equal((await json(app, "/api/atividade/limites", { method: "POST", body: { verificadorIndependente: 1 } })).status, 200);
    const rejected = await say(app, `verifique a afirmação af_3 do registro ${reg.id}`, conv.id);
    assert.match(lastText(rejected), /^VERIFICAÇÃO de af_3 .*: rejected\./);
    const confirmed = await say(app, `verifique a afirmação af_1 do registro ${reg.id}`, conv.id);
    assert.match(lastText(confirmed), /: confirmed\./);
    const pending = await say(app, `verifique a afirmação af_2 do registro ${reg.id}`, conv.id);
    assert.match(lastText(pending), /: needs_validation\./);
    assert.match(lastText(await say(app, `verifique a afirmação af_4 do registro ${reg.id}`, conv.id)), /Só afirmações marcadas/);
    assert.match(lastText(await say(app, `verifique a afirmação af_3 do registro ${reg.id}`, conv.id)), /já foi verificada: rejected/);
    assert.match(lastText(await say(app, `verifique a afirmação af_1 do registro reg_nao_existe`, conv.id)), /Não achei esse registro/);

    const final = (await json(app, `/api/registro-fontes/${reg.id}`)).body.entry;
    const state = (id) => final.claims.find((claim) => claim.id === id).verification;
    assert.equal(state("af_3").state, "rejected");
    assert.equal(state("af_1").state, "confirmed");
    assert.equal(state("af_2").state, "needs_validation");
    assert.notEqual(state("af_3").verifierId, final.helperId, "quem verificou não é quem achou");
    assert.match(state("af_3").verifierId, /^ajd_/);
    assert.equal(final.claims.find((claim) => claim.id === "af_4").verification, null);
    assert.equal(prompts.filter((text) => text.includes("## Afirmação a verificar")).length, 3, "só 3 verificadores abertos, um por chamada");
    const verifierPromptText = prompts.find((text) => text.includes("## Afirmação a verificar"));
    assert.match(verifierPromptText, /Fonte citada por quem achou/);
    // O verificador conta como ajudante nos limites e aparece na aba Atividade.
    assert.equal((await json(app, "/api/atividade")).body.stats.total.ajudantesCriados, 4);
    // O assistente lê o registro pela ferramenta.
    const read = await say(app, "registro_fontes", conv.id);
    assert.ok(read);
  } finally {
    await app.close();
  }
});

test("limite do verificador: padrão 0, só aceita 0 ou 1", () => {
  const orch = createOrchestration(tmp());
  assert.equal(orch.limits().verificadorIndependente, 0);
  assert.equal(orch.setLimits({ verificadorIndependente: 7 }).verificadorIndependente, 1);
  assert.equal(orch.setLimits({ verificadorIndependente: -3 }).verificadorIndependente, 0);
});