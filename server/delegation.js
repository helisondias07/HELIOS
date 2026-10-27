"use strict";

const { redact } = require("./util");
const { unwrapStreamEvent, extractAssistantText } = require("./sdk-events");
const { chooseModel } = require("./model-policy");
const { helperPrompt, consultPrompt, verifierPrompt } = require("./agent-prompt");
const { validateBriefing } = require("./briefing");
const { TIPOS, isLocked } = require("./autonomy");
const { REPORT_MAX } = require("./orchestration");

/** Ferramentas que um ajudante pode receber. Nunca memória, rotina, livecoding ou criação de assistente. */
const HELPER_TOOLS = ["pesquisar_web", "mcp_chamar", "helios_acao", "escrever_arquivo", "helios_preencher_login", "perguntar_ao_helison", "estacionar_tarefa", "criar_ajudante"];

const clipText = (text, max) => {
  const value = redact(String(text ?? "")).replace(/\r\n/g, "\n").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const oneLine = (text, max) => clipText(String(text ?? "").replace(/\s+/g, " "), max);

/** O que ainda prende a conversa de um ajudante: pendentes e pedidos expirados (que o Helison pode reabrir). */
function pendingCount(conv) {
  return (conv?.messages || []).filter((message) => (message.state === "pending" && (message.role === "approval" || message.role === "question")) || (message.state === "expired" && message.role === "approval")).length;
}

/**
 * Ajudantes efêmeros, consultas entre assistentes e criação de assistentes por bots.
 * Tudo roda por `bot.js` (que entrega abrir agente, auth e ferramentas-base).
 */
function createDelegation(deps) {
  const {
    store,
    assistants,
    memories,
    contexts,
    orchestration: orch,
    autonomy,
    usage = null,
    openEphemeral,
    resolveAuth,
    catalogFor,
    makeBaseTools,
    helperTimeoutMs,
    autoPark = () => null,
    ledger = null,
    log = () => {},
  } = deps;

  const consultsByRoot = new Map();

  const timeoutMs = () => (Number.isFinite(helperTimeoutMs) && helperTimeoutMs > 0 ? helperTimeoutMs : orch.limits().tempoAjudanteSeg * 1000);

  /**
   * Roda um agente descartável: abre, manda um prompt, junta a resposta, fecha.
   * Respeita tempo máximo e o botão "Encerrar". Nunca lança: devolve o estado.
   */
  async function runEphemeral({ name, prompt, tools, level = "rapido", onCancel }) {
    const auth = resolveAuth();
    let agent = null;
    let run = null;
    let finalText = "";
    let abort;
    const aborted = new Promise((resolve) => { abort = resolve; });
    const cancel = async () => {
      abort({ stopped: true });
      try {
        await run?.cancel?.();
      } catch {
        /* segue */
      }
    };
    onCancel?.(cancel);
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), timeoutMs());
      timer.unref?.();
    });
    const work = (async () => {
      const catalog = await catalogFor(auth);
      const picked = chooseModel({ text: prompt.slice(-400), override: level, catalog });
      agent = await openEphemeral({ name, selection: picked.selection, tools, auth });
      run = await agent.send(prompt, { model: picked.selection });
      let streamed = "";
      if (typeof run.supports !== "function" || run.supports("stream")) {
        for await (const raw of run.stream()) {
          const msg = unwrapStreamEvent(raw);
          if (msg && msg.type === "assistant") {
            const chunk = extractAssistantText(msg);
            if (chunk) streamed = chunk.startsWith(streamed) ? chunk : streamed + chunk;
          }
        }
      }
      const result = await run.wait();
      finalText = String(result?.result || streamed || "").trim();
      return { status: result?.status === "error" ? "error" : "done", text: finalText, usage: result?.usage || run.usage || null, model: picked.label };
    })().catch((err) => ({ status: "error", text: `Falhou: ${redact(err.message || err)}`, usage: null }));
    const outcome = await Promise.race([work, timeout, aborted]);
    clearTimeout(timer);
    if (outcome.timeout || outcome.stopped) {
      try {
        await run?.cancel?.();
      } catch {
        /* segue */
      }
    }
    try {
      if (agent && typeof agent[Symbol.asyncDispose] === "function") await agent[Symbol.asyncDispose]();
      else agent?.close?.();
    } catch {
      /* ignora */
    }
    if (outcome.timeout) return { status: "timeout", text: finalText, usage: null };
    if (outcome.stopped) return { status: "stopped", text: finalText, usage: null };
    return outcome;
  }

  /** Ferramentas permitidas a um ajudante: o que foi pedido ∩ o que ajudante pode ∩ o que o pai tem. */
  function helperToolNames(requested, parentAllowed, depthOk) {
    const base = HELPER_TOOLS.filter((name) => (name !== "criar_ajudante" || depthOk) && (!parentAllowed || parentAllowed.has(name)));
    if (!Array.isArray(requested) || !requested.length) return { names: base, ignored: [] };
    const wanted = [...new Set(requested.map((item) => String(item || "").trim()).filter(Boolean))];
    return { names: base.filter((name) => wanted.includes(name)), ignored: wanted.filter((name) => !base.includes(name)) };
  }

  function cleanupHelperConv(convId) {
    const conv = store.get(convId);
    if (!conv?.helper?.done) return false;
    if (pendingCount(conv)) return false;
    return store.remove(convId);
  }

  async function runHelper(convId, ctx, args = {}) {
    const task = clipText(args.tarefa || args.task || args.pergunta, 1500);
    if (task.length < 5) return "Descreva a tarefa do ajudante (tarefa).";
    // Briefing de 4 campos (pergunta, fontes, formato, fronteira): sem ele, nada é executado nem contado.
    const checked = validateBriefing(args);
    if (!checked.ok) return checked.error;
    const briefing = checked.briefing;
    const parent = assistants.resolve(ctx.assistantId);
    const blocked = usage?.blockReason(parent.id, parent.name);
    if (blocked) return blocked;
    const depth = ctx.depth + 1;
    const { names, ignored } = helperToolNames(args.ferramentas_permitidas, ctx.allowed, depth < orch.limits().profundidade);
    if (!names.length) return `Nenhuma das ferramentas pedidas está disponível para ajudantes. Disponíveis: ${HELPER_TOOLS.filter((name) => name !== "criar_ajudante").join(", ")}.`;
    const started = orch.start({ assistantId: parent.id, assistantName: parent.name, rootConvId: ctx.rootConvId, task, depth, tools: names });
    if (started.error) return started.error;
    const entry = started.helper;
    const helperConv = store.create(`Ajudante: ${oneLine(task, 50)}`, parent.id);
    store.update(helperConv.id, (conv) => {
      conv.helper = { id: entry.id, parentConvId: convId, rootConvId: ctx.rootConvId, depth, task: oneLine(task, 200), done: false };
    });
    const helperCtx = { kind: "ajudante", assistantId: parent.id, rootConvId: ctx.rootConvId, depth, chain: ctx.chain, allowed: new Set(names) };
    const all = makeBaseTools(helperConv.id, helperCtx);
    const tools = {};
    for (const name of names) if (all.tools[name]) tools[name] = all.tools[name];
    const prompt = helperPrompt({
      task,
      instructions: clipText(args.instrucoes_curtas || args.instrucoes, 600),
      context: clipText(args.contexto, 1200),
      parentName: parent.name,
      briefing,
    });
    let outcome;
    const helperStart = Date.now();
    try {
      outcome = await runEphemeral({
        name: `HELIOS · ajudante ${entry.id}`,
        prompt,
        tools,
        onCancel: (cancel) => orch.setCancel(entry.id, cancel),
      });
    } catch (err) {
      outcome = { status: "error", text: `Falhou: ${redact(err.message || err)}`, usage: null };
    }
    const stopped = orch.wasStopped(entry.id);
    const state = stopped ? "stopped" : outcome.status === "timeout" ? "timeout" : outcome.status === "error" ? "error" : "done";
    const label = { done: "concluído", error: "erro", stopped: "encerrado pelo Helison", timeout: "tempo esgotado" }[state];
    // Registro de fontes: separa acordadas, contestadas e não verificadas e guarda em disco.
    const recorded = ledger && state === "done"
      ? ledger.record({ helperId: entry.id, assistantId: parent.id, assistantName: parent.name, task, pergunta: briefing.pergunta, text: outcome.text })
      : null;
    let report = clipText(recorded ? recorded.stripped || outcome.text : outcome.text, REPORT_MAX);
    if (!report) report = state === "done" ? "FEITO: nada a relatar. ACHEI: nada encontrado. PENDENTE: nada." : "Sem relatório.";
    orch.addUsage(parent.id, "ajudantes", outcome.usage);
    usage?.record(parent.id, { kind: "ajudante", charsIn: prompt.length, charsOut: String(outcome.text || "").length, ms: Date.now() - helperStart, usage: outcome.usage });
    orch.finish(entry.id, state, report);
    store.update(helperConv.id, (conv) => {
      if (conv.helper) conv.helper.done = true;
    });
    // Estourou o tempo: o estado fica salvo e a Caixa de entrada oferece "Retomar" (o ajudante já saiu).
    if (state === "timeout") {
      autoPark(helperConv.id, helperCtx, {
        objetivo: task,
        feito: outcome.text ? [`Relatório parcial: ${oneLine(outcome.text, 180)}`] : [],
        falta: ["Terminar a tarefa de onde parou."],
        pergunta: `O ajudante da tarefa "${oneLine(task, 60)}" passou do tempo máximo. Retomar de onde parou?`,
        motivo: "limite",
      });
    }
    const waiting = pendingCount(store.get(helperConv.id));
    cleanupHelperConv(helperConv.id);
    log(`[ajudante] ${entry.id} ${state}`);
    const notes = [];
    if (state === "done" && ledger) notes.push(ledgerNote(recorded?.entry || null));
    if (ignored.length) notes.push(`Ferramentas ignoradas (fora do que um ajudante pode usar): ${ignored.join(", ")}.`);
    if (waiting) notes.push(`PENDENTE: ${waiting} item(ns) esperam o Helison na Caixa de entrada, como “ajudante de ${parent.name}”. Não repita a tarefa.`);
    return [`RELATÓRIO DO AJUDANTE (${label}):`, report, ...notes].join("\n");
  }

  /** Resumo do registro de fontes que volta junto do relatório (o texto completo fica em disco). */
  function ledgerNote(entry) {
    if (!entry) return "REGISTRO DE FONTES: o ajudante não separou as afirmações em acordadas, contestadas e não verificadas. Trate o que ele afirmou como não verificado.";
    const { counts } = entry;
    const head = `REGISTRO DE FONTES ${entry.id}: ${counts.acordada} acordada(s), ${counts.contestada} contestada(s), ${counts.nao_verificada} não verificada(s)${counts.importantes ? `; ${counts.importantes} importante(s)` : ""}.`;
    const lines = entry.claims.map((claim) => `- [${claim.categoryLabel}${claim.important ? ", importante" : ""}] ${claim.text}${claim.sources.length ? ` (fonte: ${claim.sources.join("; ")})` : " (sem fonte)"}`);
    const tail = counts.importantes && orch.limits().verificadorIndependente ? "Para as importantes, verificar_afirmacao pede a outro ajudante que tente desmentir." : "";
    return clipText([head, ...lines, tail].filter(Boolean).join("\n"), 900);
  }

  const VERDICT_RE = /VEREDITO\s*:\s*(confirmed|rejected|needs_validation)/i;

  /**
   * Verificador independente (opcional, desligado por padrão em Atividade › Limites): outro ajudante,
   * só com pesquisa, tenta DESMENTIR uma afirmação marcada como importante. Um por chamada.
   */
  async function runVerifier(convId, ctx, args = {}) {
    if (!ledger) return "O registro de fontes não está disponível neste processo.";
    if (!orch.limits().verificadorIndependente) return "O verificador independente está desligado (padrão). O Helison liga em Atividade › Limites. Enquanto isso, trate a afirmação como não verificada.";
    const reg = ledger.get(clipText(args.registro || args.id, 60));
    if (!reg || reg.assistantId !== ctx.assistantId) return "Não achei esse registro de fontes. Use registro_fontes para ver os ids.";
    const claim = reg.claims.find((item) => item.id === clipText(args.afirmacao || args.claim, 20));
    if (!claim) return `Não achei essa afirmação no registro ${reg.id}. Ids: ${reg.claims.map((item) => item.id).join(", ")}.`;
    if (!claim.important) return "Só afirmações marcadas [IMPORTANTE] passam pelo verificador independente.";
    if (claim.verification && claim.verification.state !== "needs_validation") return `Essa afirmação já foi verificada: ${claim.verification.state}. ${claim.verification.note}`;
    const parent = assistants.resolve(ctx.assistantId);
    const blocked = usage?.blockReason(parent.id, parent.name);
    if (blocked) return blocked;
    const depth = ctx.depth + 1;
    const names = helperToolNames(["pesquisar_web"], ctx.allowed, false).names;
    const started = orch.start({ assistantId: parent.id, assistantName: parent.name, rootConvId: ctx.rootConvId, task: `Verificar: ${claim.text}`, depth, tools: names });
    if (started.error) return started.error;
    const entry = started.helper;
    const helperConv = store.create(`Verificador: ${oneLine(claim.text, 50)}`, parent.id);
    store.update(helperConv.id, (conv) => {
      conv.helper = { id: entry.id, parentConvId: convId, rootConvId: ctx.rootConvId, depth, task: oneLine(claim.text, 200), done: false };
    });
    const verifierCtx = { kind: "ajudante", assistantId: parent.id, rootConvId: ctx.rootConvId, depth, chain: ctx.chain, allowed: new Set(names) };
    const all = makeBaseTools(helperConv.id, verifierCtx);
    const tools = {};
    for (const name of names) if (all.tools[name]) tools[name] = all.tools[name];
    const prompt = verifierPrompt({ claim: claim.text, sources: claim.sources, pergunta: reg.pergunta });
    const startedAt = Date.now();
    let outcome;
    try {
      outcome = await runEphemeral({ name: `HELIOS · verificador ${entry.id}`, prompt, tools, onCancel: (cancel) => orch.setCancel(entry.id, cancel) });
    } catch (err) {
      outcome = { status: "error", text: `Falhou: ${redact(err.message || err)}`, usage: null };
    }
    const stopped = orch.wasStopped(entry.id);
    const state = stopped ? "stopped" : outcome.status === "timeout" ? "timeout" : outcome.status === "error" ? "error" : "done";
    orch.addUsage(parent.id, "ajudantes", outcome.usage);
    usage?.record(parent.id, { kind: "ajudante", charsIn: prompt.length, charsOut: String(outcome.text || "").length, ms: Date.now() - startedAt, usage: outcome.usage });
    orch.finish(entry.id, state, clipText(outcome.text, 300) || "Sem veredito.");
    store.update(helperConv.id, (conv) => {
      if (conv.helper) conv.helper.done = true;
    });
    cleanupHelperConv(helperConv.id);
    log(`[verificador] ${entry.id} ${state}`);
    if (state !== "done") return `A verificação não terminou (${state}). A afirmação segue como needs_validation.`;
    const text = String(outcome.text || "");
    const found = text.match(VERDICT_RE);
    const verdict = found ? found[1].toLowerCase() : "needs_validation";
    const note = clipText((text.match(/MOTIVO\s*:\s*([^\n]+)/i) || [])[1] || (found ? "" : "O verificador não deu um veredito claro."), 300);
    const source = clipText((text.match(/FONTE\s*:\s*([^\n]+)/i) || [])[1] || "", 200);
    try {
      ledger.verify(reg.id, claim.id, { verifierId: entry.id, state: verdict, note, source });
    } catch (err) {
      return `Não consegui registrar a verificação: ${redact(err.message || err)}`;
    }
    return `VERIFICAÇÃO de ${claim.id} (registro ${reg.id}): ${verdict}.${note ? ` Motivo: ${note}` : ""}${source ? ` Fonte: ${source}` : ""}`;
  }

  /** Leitura do registro de fontes: lista os últimos deste assistente ou detalha um registro. */
  function readLedger(ctx, args = {}) {
    if (!ledger) return "O registro de fontes não está disponível neste processo.";
    const id = clipText(args.id || args.registro, 60);
    if (!id) {
      const rows = ledger.list({ assistantId: ctx.assistantId, limit: 8 });
      if (!rows.length) return "Nenhum registro de fontes ainda.";
      return clipText(rows.map((row) => `- ${row.id} (ajudante ${row.helperId}): ${row.task} — ${row.counts.acordada} acordada(s), ${row.counts.contestada} contestada(s), ${row.counts.nao_verificada} não verificada(s)`).join("\n"), 1500);
    }
    const reg = ledger.get(id);
    if (!reg || reg.assistantId !== ctx.assistantId) return "Não achei esse registro de fontes.";
    const lines = reg.claims.map((claim) => {
      const verdict = claim.important ? ` · verificação: ${claim.verification ? claim.verification.state : "needs_validation"}${claim.verification && claim.verification.note ? ` (${claim.verification.note})` : ""}` : "";
      return `- ${claim.id} [${claim.categoryLabel}${claim.important ? ", importante" : ""}] ${claim.text} — ${claim.sources.length ? claim.sources.join("; ") : "sem fonte"}${verdict}`;
    });
    return clipText([`Registro ${reg.id}: ${reg.task}`, ...lines].join("\n"), 1500);
  }

  async function runConsult(ctx, args = {}) {
    const asker = assistants.resolve(ctx.assistantId);
    const question = clipText(args.pergunta || args.question, 1000);
    if (question.length < 3) return "Escreva a pergunta.";
    const ref = String(args.assistente || args.assistant || "").trim();
    const target = assistants.find(ref);
    if (!target) {
      const names = assistants.list().filter((item) => item.id !== asker.id).map((item) => item.name).join(", ") || "nenhum";
      return `Não achei o assistente “${clipText(ref, 40)}”. Disponíveis: ${names}.`;
    }
    if (target.id === asker.id) return "Você não pode consultar a si mesmo.";
    const blockedAsk = usage?.blockReason(asker.id, asker.name);
    if (blockedAsk) return blockedAsk;
    const chain = ctx.chain && ctx.chain.length ? ctx.chain : [asker.id];
    if (chain.includes(target.id)) {
      const names = [...chain, target.id].map((id) => assistants.resolve(id).name).join(" → ");
      return `Consulta circular bloqueada (${names}). Responda com o que já sabe.`;
    }
    const nextChain = [...chain, target.id];
    const limit = orch.limits().consultasProfundidade;
    if (nextChain.length - 1 > limit) return `Limite de consultas encadeadas (${limit}) atingido. Responda com o que já sabe.`;
    const used = consultsByRoot.get(ctx.rootConvId) || 0;
    const cap = orch.limits().ajudantesPorConversa;
    if (used >= cap) return `Esta conversa já fez ${used} consultas a outros assistentes (limite: ${cap}).`;
    consultsByRoot.set(ctx.rootConvId, used + 1);
    orch.bump(asker.id, "consultas");

    const cap2 = Math.min(3000, orch.limits().contextoMaxCaracteres);
    const prompt = consultPrompt({
      assistantText: assistantProfile(target),
      memoryText: memories.for(target.id).context({ text: question, maxChars: 600 }).text,
      contextText: contexts.for(target.id).promptText(cap2),
      question,
      askerName: asker.name,
    });
    const childCtx = { kind: "consulta", assistantId: target.id, rootConvId: ctx.rootConvId, depth: ctx.depth, chain: nextChain, allowed: null };
    const tools = nextChain.length - 1 < limit ? { consultar_assistente: consultTool(childCtx) } : {};
    const consultStart = Date.now();
    const outcome = await runEphemeral({ name: `HELIOS · consulta a ${target.name}`, prompt, tools });
    orch.addUsage(asker.id, "consultas", outcome.usage);
    usage?.record(asker.id, { kind: "consulta", charsIn: prompt.length, charsOut: String(outcome.text || "").length, ms: Date.now() - consultStart, usage: outcome.usage });
    if (outcome.status === "timeout") return `A consulta a ${target.name} passou do tempo máximo.`;
    if (outcome.status === "stopped") return `A consulta a ${target.name} foi interrompida.`;
    if (outcome.status === "error") return `A consulta a ${target.name} falhou: ${clipText(outcome.text, 200)}`;
    return `Resposta de ${target.name}: ${clipText(outcome.text || "Sem resposta.", 1000)}`;
  }

  function assistantProfile(assistant) {
    // Só o perfil do assistente consultado entra, nunca o de quem perguntou.
    return require("./agent-prompt").assistantPrompt(assistant) || `## Assistente consultado: ${assistant.name}\nFunção: ${assistant.role || "assistente geral"}`;
  }

  function consultTool(ctx) {
    return {
      description: "Pergunta algo a OUTRO assistente do Helison, no contexto dele (memória e instruções), numa sessão nova. Devolve uma resposta curta. Não repita a mesma consulta.",
      inputSchema: { type: "object", properties: { assistente: { type: "string" }, pergunta: { type: "string" } }, required: ["assistente", "pergunta"] },
      execute: async (args) => runConsult(ctx, args),
    };
  }

  /** O pai pede; o assistente só passa a existir depois do cartão de aprovação. */
  function requestAssistant(convId, ctx, args = {}, queueCard) {
    const parent = assistants.resolve(ctx.assistantId);
    if (ctx.kind !== "conversa") return "Só um assistente principal, numa conversa, pode pedir a criação de outro assistente.";
    if (parent.createdBy) return "Um assistente criado por um bot não cria outros (profundidade de criação: 1). Peça ao Helison.";
    const limit = orch.limits().assistentesCriadosPorBots;
    if (assistants.createdByBots() >= limit) return `Limite de assistentes criados por bots atingido (${limit}). Peça ao Helison para remover algum ou aumentar o limite na tela Atividade.`;
    const name = clipText(args.nome || args.name, 40);
    if (name.length < 2) return "Dê um nome ao assistente (2 a 40 letras).";
    // Nunca herda mais que o pai: conectores dentro dos dele, autonomia igual ou mais restrita.
    const asked = Array.isArray(args.conectores) ? args.conectores.map((item) => clipText(item, 40)).filter(Boolean) : null;
    let mcp;
    const dropped = [];
    if (Array.isArray(parent.mcp)) {
      mcp = asked ? asked.filter((item) => parent.mcp.includes(item)) : [...parent.mcp];
      if (asked) dropped.push(...asked.filter((item) => !parent.mcp.includes(item)));
    } else {
      mcp = asked || null;
    }
    const modes = {};
    for (const info of TIPOS) {
      if (isLocked(info.tipo)) continue;
      modes[info.tipo] = autonomy.mode(info.tipo, parent.autonomy);
    }
    let proposed;
    try {
      proposed = assistants.propose({ name, role: args.funcao || args.role || "", instructions: args.instrucoes || args.instructions || "", mcp, autonomy: modes }, { assistantId: parent.id, name: parent.name });
    } catch (err) {
      return `Não deu para propor: ${redact(err.message || err)}`;
    }
    orch.bump(parent.id, "assistentesCriados");
    const detail = [
      `Pedido por ${parent.name}.`,
      proposed.role ? `Função: ${proposed.role}.` : "",
      `Conectores: ${proposed.mcp === null ? "todos os configurados" : proposed.mcp.join(", ") || "nenhum"}.`,
      "Autonomia: igual ou mais restrita que a de quem pediu; pagar e preencher login sempre pedem antes.",
    ].filter(Boolean).join(" ");
    const cardId = queueCard({
      kind: "assistente",
      summary: `Criar o assistente “${proposed.name}”`,
      detail,
      action: { tipo: "assistente", assistantId: proposed.id, resumo: `Criar o assistente ${proposed.name}`, alvo: proposed.name },
    });
    return `PENDENTE — cartão ${cardId}. O assistente “${proposed.name}” só passa a existir depois que o Helison aprovar na Caixa de entrada (criado por ${parent.name}).${dropped.length ? ` Conectores fora do seu alcance foram ignorados: ${dropped.join(", ")}.` : ""} Não repita o pedido.`;
  }

  function approveAssistant(assistantId) {
    const item = assistants.approve(assistantId);
    if (!item) throw new Error("Esse pedido de assistente não existe mais.");
    return `Assistente “${item.name}” criado e ativo${item.createdBy ? ` (criado por ${item.createdBy.name})` : ""}.`;
  }

  function rejectAssistant(assistantId) {
    return assistants.reject(assistantId);
  }

  /** Ferramentas de orquestração e de contexto de uma conversa ou ajudante. */
  function tools(convId, ctx, { queueCard } = {}) {
    const out = {};
    const depthOk = ctx.depth + 1 <= orch.limits().profundidade;
    if (ctx.kind === "conversa" || (ctx.kind === "ajudante" && depthOk && (!ctx.allowed || ctx.allowed.has("criar_ajudante")))) {
      out.criar_ajudante = {
        description: "Cria um ajudante temporário para UMA tarefa, com contexto mínimo. Exige o briefing de 4 campos: pergunta (o que ele deve responder), fontes (onde procurar), formato (como entregar) e fronteira (o que NÃO fazer e onde parar); sem os 4, nada é executado. Devolve só um relatório curto (FEITO / ACHEI / PENDENTE) com o registro de fontes (acordadas, contestadas, não verificadas) e o ajudante some. Use um por tarefa independente (ex.: uma plataforma de vagas).",
        inputSchema: {
          type: "object",
          properties: {
            tarefa: { type: "string" },
            pergunta: { type: "string", description: "A pergunta exata que o ajudante deve responder." },
            fontes: { type: "string", description: "Onde procurar: sites, conectores ou arquivos que ele pode consultar." },
            formato: { type: "string", description: "Como entregar (ex.: lista de 5 itens, tabela, sim/não com motivo)." },
            fronteira: { type: "string", description: "O que NÃO fazer e onde parar." },
            instrucoes_curtas: { type: "string" },
            ferramentas_permitidas: { type: "array", items: { type: "string" } },
            contexto: { type: "string" },
          },
          required: ["tarefa", "pergunta", "fontes", "formato", "fronteira"],
        },
        execute: async (args) => runHelper(convId, ctx, args),
      };
    }
    if (ctx.kind === "conversa") {
      out.registro_fontes = {
        description: "Lê o registro de fontes dos ajudantes deste assistente. Sem id, lista os últimos; com id (reg_… ou ajd_…), mostra cada afirmação (acordada, contestada, não verificada), as fontes e o estado do verificador.",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        execute: async (args) => readLedger(ctx, args),
      };
      out.verificar_afirmacao = {
        description: "Passo opcional (desligado por padrão em Atividade › Limites): outro ajudante, só com pesquisa, tenta DESMENTIR uma afirmação marcada como importante no registro de fontes. Estados: confirmed, needs_validation, rejected.",
        inputSchema: { type: "object", properties: { registro: { type: "string" }, afirmacao: { type: "string" } }, required: ["registro", "afirmacao"] },
        execute: async (args) => runVerifier(convId, ctx, args),
      };
      out.consultar_assistente = consultTool(ctx);
      out.criar_assistente = {
        description: "Propõe um NOVO assistente permanente (bot principal de um assunto). Ele só passa a existir depois da aprovação do Helison e nunca recebe mais autonomia ou conectores do que você tem.",
        inputSchema: {
          type: "object",
          properties: { nome: { type: "string" }, funcao: { type: "string" }, instrucoes: { type: "string" }, conectores: { type: "array", items: { type: "string" } } },
          required: ["nome", "funcao", "instrucoes"],
        },
        execute: async (args) => requestAssistant(convId, ctx, args, queueCard),
      };
      out.contexto_registrar = {
        description: "Registra um item em andamento no contexto ativo deste assistente (ex.: uma vaga aberta). Curto, sem segredos.",
        inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
        execute: async (args) => {
          try {
            const { item, compacted } = contexts.for(ctx.assistantId).add(args.item);
            return `Registrei no contexto (${item.id}).${compacted.moved ? ` Arquivei ${compacted.moved} item(ns) antigos para caber no limite.` : ""}`;
          } catch (err) {
            return redact(err.message || err);
          }
        },
      };
      out.arquivar_item = {
        description: "Move um item concluído ou fechado (ex.: vaga encerrada) do contexto ativo para o arquivo morto, com o motivo. Use o id ctx_… ou um trecho único do texto.",
        inputSchema: { type: "object", properties: { item: { type: "string" }, motivo: { type: "string" } }, required: ["item"] },
        execute: async (args) => {
          try {
            const moved = contexts.for(ctx.assistantId).archiveItem(args.item, args.motivo);
            return `Arquivei ${moved.id}. Ele saiu do contexto ativo.`;
          } catch (err) {
            return redact(err.message || err);
          }
        },
      };
      out.buscar_arquivo = {
        description: "Busca no arquivo morto deste assistente (itens já arquivados). Só use quando precisar de algo antigo.",
        inputSchema: { type: "object", properties: { consulta: { type: "string" } }, required: ["consulta"] },
        execute: async (args) => {
          const found = contexts.for(ctx.assistantId).searchArchive(args.consulta);
          if (!found.length) return "Nada no arquivo morto sobre isso.";
          return clipText(found.map((item) => `- [${item.id}] ${item.text} (arquivado: ${item.motivo || "concluído"})`).join("\n"), 1500);
        },
      };
    }
    return out;
  }

  return { tools, runHelper, runVerifier, readLedger, runConsult, runEphemeral, requestAssistant, approveAssistant, rejectAssistant, cleanupHelperConv };
}

module.exports = { createDelegation, HELPER_TOOLS, pendingCount };
