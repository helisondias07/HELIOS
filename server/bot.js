"use strict";

const { newId, nowIso, redact, MAX_MESSAGE_CHARS } = require("./util");
const { chooseModel } = require("./model-policy");
const { LEVELS } = require("./router");
const { createMockAgent } = require("./mock-agent");
const { unwrapStreamEvent, extractAssistantText, humanTool } = require("./sdk-events");
const { buildPrompt, assistantPrompt, compactHistory } = require("./agent-prompt");
const { agentIndex, vaultPrompt } = require("./vault-public");
const { classifyToolDetailed, normalizeTipo } = require("./irreversible");
const { resolveMode, isLocked } = require("./autonomy");
const { cleanAction, sanitizeModelAction } = require("./actions");
const { describeAction, digestOf } = require("./approval-preview");
const { restrictedAgentOptions } = require("./sdk-safety");
const { isAutomated, originOf } = require("./inbox");
const { formatResults } = require("./search");
const { writeFiles, draftPlanFromRequest, normalizePlan, parsePlanJson } = require("./livecoding");
const { createDelegation } = require("./delegation");
const { planSummary, extractiveSummary, summaryPrompt, SUMMARY_MAX } = require("./summary");
const { screenUserText } = require("./credentials");
const { classifyAccountError, describeAccountIssue } = require("./accounts");

const HISTORY = { rapido: [4, 400, 500], padrao: [8, 700, 800], avancado: [12, 1000, 1200] };

function clip(text) {
  const value = redact(text);
  return value.length > 8000 ? `${value.slice(0, 8000)}…` : value;
}

function createBot(deps) {
  const agents = new Map();
  const {
    store,
    memory,
    memories = { for: () => memory },
    assistants = { resolve: () => ({ id: "default", name: "HELIOS", builtin: true, mcp: null, autonomy: {} }) },
    searchWeb,
    mcp,
    actions,
    accounts,
    routines,
    autonomy = { mode: (tipo, assistantModes) => resolveMode(tipo, assistantModes) },
    contexts,
    orchestration,
    parking,
    ledger = null,
    usage = null,
    now = () => Date.now(),
    loadSdk = () => import("@cursor/sdk"),
    helperTimeoutMs,
    getVaultIndex,
    onLivecoding,
    cwd,
    log = () => {},
  } = deps;
  const forceMock = () => Boolean(deps.mock);
  const delegation = createDelegation({
    store,
    assistants,
    memories,
    contexts,
    orchestration,
    autonomy,
    usage,
    ledger,
    helperTimeoutMs,
    autoPark: (convId, ctx, info) => (parking ? parkTask(convId, ctx, info).entry : null),
    openEphemeral: (args) => openEphemeral(args),
    resolveAuth: () => resolveAuth(),
    catalogFor: (auth) => catalogFor(auth),
    makeBaseTools: (convId, ctx) => makeTools(convId, ctx),
    log,
  });

  /**
   * Pedidos de rotinas e ajudantes valem por um tempo (aprovacaoExpiraMin). Depois viram "expirado" e nada é executado.
   * Pedidos de uma conversa ativa não expiram.
   */
  function expiryStamp(convId) {
    if (!isAutomated(store.get(convId))) return null;
    const minutes = Math.max(1, Number(orchestration.limits().aprovacaoExpiraMin) || 10);
    return new Date(now() + minutes * 60000).toISOString();
  }

  function queueApproval(convId, action) {
    const clean = cleanAction(action);
    const id = newId("apr");
    const expiresAt = expiryStamp(convId);
    // O cartão mostra o que de fato vai rodar (com segredos mascarados). A impressão digital amarra cartão e ação.
    const detail = describeAction(clean);
    store.update(convId, (conv) => {
      conv.messages.push({
        id,
        role: "approval",
        kind: clean.tipo,
        summary: clean.resumo,
        detail,
        digest: digestOf({ action: clean, detail }),
        action: clean,
        state: "pending",
        expiresAt,
        at: nowIso(),
      });
    });
    return `PENDENTE — cartão ${id}. Não execute nada. Peça ao Helison para aprovar ou ajustar.`;
  }

  /** Cartão de aprovação que não é uma ação comum (ex.: criar assistente). Devolve o id. */
  function queueCard(convId, { kind, summary, detail, action }) {
    const id = newId("apr");
    const expiresAt = expiryStamp(convId);
    const shownDetail = redact(detail || "");
    store.update(convId, (conv) => {
      conv.messages.push({ id, role: "approval", kind, summary: redact(summary), detail: shownDetail, digest: digestOf({ action, detail: shownDetail }), action, state: "pending", expiresAt, at: nowIso() });
    });
    return id;
  }

  /** Modo efetivo da ação nesta conversa. Pagar e preencher login nunca saem de "pedir". */
  function modeFor(convId, tipo) {
    if (isLocked(tipo)) return "pedir";
    return autonomy.mode(tipo, assistantFor(convId)?.autonomy, { automated: isAutomated(store.get(convId)) });
  }

  /** Assistente dono da conversa. Conversa sem dono (ou dono removido) usa o padrão. */
  function assistantFor(convId) {
    return assistants.resolve(store.get(convId)?.assistantId);
  }

  const memoryOf = (convId) => memories.for(assistantFor(convId).id);

  /** Roda a ação já, sem cartão pendente, e deixa um registro na conversa. Só vale para tipos liberados em Autonomia. */
  async function runAuto(convId, clean) {
    let state = "done";
    let result;
    try {
      result = `Feito sozinho, como você configurou em Autonomia. ${await actions.perform(clean, { auto: true })}`;
    } catch (err) {
      state = "error";
      result = redact(err.message || err);
    }
    store.update(convId, (conv) => {
      conv.messages.push({
        id: newId("apr"),
        role: "approval",
        kind: clean.tipo,
        summary: clean.resumo,
        detail: describeAction(clean),
        action: { ...clean, conteudo: "" },
        state,
        auto: true,
        result,
        at: nowIso(),
      });
    });
    return state === "done" ? `FEITO SOZINHO - ${clip(result)}` : `ERRO - ${clip(result)}`;
  }

  /**
   * Confere de novo, na hora de criar o cartão e na hora de executar, uma ação de conector: o assistente tem acesso ao conector,
   * a ferramenta existe numa lista já testada e o tipo vem da classificação do HELIOS (nunca do que o modelo escreveu).
   */
  function revalidateMcp(convId, clean) {
    const { server, tool } = clean.mcp;
    const allowed = assistantFor(convId).mcp;
    if (Array.isArray(allowed) && !allowed.includes(server)) {
      return { error: `Este assistente não tem acesso ao conector "${clip(server)}". Peça ao Helison para liberar na tela Assistentes.` };
    }
    if (!mcp || typeof mcp.findTool !== "function") return { error: "Os conectores não estão disponíveis neste processo." };
    const known = mcp.findTool(server, tool);
    if (!known) return { error: `Não achei ${clip(server)}.${clip(tool)} numa lista já testada. Confirme e teste o conector na tela Conectores antes de chamar.` };
    const kind = classifyToolDetailed(tool, known.description || "");
    return { tipo: kind.tipo, forceCard: kind.forceCard };
  }

  /** Único caminho de uma ação com efeito: ou vira cartão ("pedir") ou roda direto ("sozinho"). */
  async function gate(convId, action) {
    const clean = cleanAction(action);
    let forceCard = false;
    if (clean.mcp) {
      const checked = revalidateMcp(convId, clean);
      if (checked.error) return checked.error;
      clean.tipo = checked.tipo;
      forceCard = checked.forceCard;
    }
    if (forceCard || isLocked(clean.tipo) || modeFor(convId, clean.tipo) !== "sozinho") return queueApproval(convId, clean);
    return runAuto(convId, clean);
  }

  const routineLimits = () => {
    const limits = orchestration.limits();
    return { maxRoutines: Number(limits.rotinasMax) || undefined, minEveryMinutes: Number(limits.rotinaIntervaloMin) || undefined, fromBot: true };
  };

  function addQuestion(convId, args = {}, extra = {}) {
    const question = redact(String(args.pergunta || args.question || "").replace(/\s+/g, " ").trim()).slice(0, 500);
    if (question.length < 3) return null;
    const options = (Array.isArray(args.opcoes) ? args.opcoes : []).map((item) => redact(String(item)).trim().slice(0, 80)).filter(Boolean).slice(0, 6);
    const id = newId("qst");
    store.update(convId, (conv) => {
      conv.messages.push({ id, role: "question", question, options, state: "pending", answer: "", ...extra, at: nowIso() });
    });
    return id;
  }

  function queueQuestion(convId, args = {}) {
    const id = addQuestion(convId, args);
    if (!id) return "Escreva a pergunta.";
    return `PERGUNTA REGISTRADA - ${id}. Pare agora e espere a resposta do Helison na Caixa de entrada.`;
  }

  /**
   * Estaciona a tarefa: grava o estado em disco, abre a pergunta exata na Caixa de entrada (com "Retomar")
   * e devolve para o agente parar. Nada fica ocupado esperando; sobrevive a reiniciar o app.
   */
  function parkTask(convId, ctx, args = {}) {
    if (!parking) return { ok: false, text: "Estacionar tarefa não está disponível neste processo.", entry: null };
    let parked;
    try {
      parked = parking.park({ ...args, assistantId: ctx.assistantId, convId, origin: originOf(store.get(convId) || {}) });
    } catch (err) {
      return { ok: false, text: redact(err.message || err), entry: null };
    }
    const { entry, updated } = parked;
    const existing = updated && entry.questionId ? store.get(convId)?.messages.find((message) => message.id === entry.questionId && message.state === "pending") : null;
    if (existing) {
      store.update(convId, (conv) => {
        const found = conv.messages.find((message) => message.id === entry.questionId);
        if (found) found.question = entry.pergunta;
      });
    } else {
      const questionId = addQuestion(convId, { pergunta: entry.pergunta, opcoes: ["Retomar"] }, { parked: entry.id });
      parking.attach(entry.id, questionId);
    }
    return {
      ok: true,
      entry,
      text: `ESTACIONADA - ${entry.id}. O estado foi salvo e a pergunta está na Caixa de entrada com o botão Retomar. Pare agora: não fique esperando e não repita a chamada.`,
    };
  }

  /** Contexto de execução de uma conversa: quem é o assistente, profundidade de ajudantes e cadeia de consultas. */
  function rootCtx(convId) {
    const assistantId = assistantFor(convId).id;
    return { kind: "conversa", assistantId, rootConvId: convId, depth: 0, chain: [assistantId], allowed: null };
  }

  function makeTools(convId, ctx = rootCtx(convId)) {
    const sources = [];
    const tools = {
      memory_save: {
        description: "Guarda um fato durável sobre o Helison. Sem senha, token ou e-mail.",
        inputSchema: { type: "object", properties: { texto: { type: "string" }, tipo: { type: "string" } }, required: ["texto"] },
        execute: async (args) => {
          const saved = memoryOf(convId).remember({ text: args.texto, kind: args.tipo || "fato", source: "bot" });
          return saved.updated ? "Atualizei um fato parecido na memória." : "Guardei na memória.";
        },
      },
      memory_forget: {
        description: "Esquece um item da memória pelo id mem_…",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        execute: async (args) => (memoryOf(convId).forget(String(args.id || "")) ? "Esqueci." : "Não achei esse item."),
      },
      pesquisar_web: {
        description: "Pesquisa na web e devolve título, URL e trecho. Use quando precisar de fonte.",
        inputSchema: { type: "object", properties: { consulta: { type: "string" } }, required: ["consulta"] },
        execute: async (args) => {
          const consulta = String(args.consulta || args.query || "");
          if (modeFor(convId, "ler") !== "sozinho") {
            return queueApproval(convId, { tipo: "ler", resumo: `Pesquisar na web: ${consulta.slice(0, 120)}`, alvo: consulta });
          }
          const result = await searchWeb(consulta);
          sources.push(...result.results);
          if (result.error && !result.results.length) return result.error;
          return clip(formatResults(result.query, result.results));
        },
      },
      helios_preencher_login: {
        description: "Abre um cartão para preencher um login na janela em foco. Informe só o nome. A senha só é digitada depois que o Helison aprovar.",
        inputSchema: { type: "object", properties: { nome: { type: "string" } }, required: ["nome"] },
        execute: async (args) => {
          const nome = String(args?.nome || "").trim();
          const index = agentIndex(getVaultIndex?.() || []);
          const hit = index.find((entry) => entry.nome.toLowerCase() === nome.toLowerCase() || entry.id === nome);
          if (!hit) {
            const names = index.map((entry) => entry.nome).join(", ") || "nenhum";
            return `Não achei o login "${clip(nome)}" no cofre. Nomes disponíveis: ${names}.`;
          }
          return queueApproval(convId, {
            tipo: "preencher",
            resumo: `Preencher o login ${hit.nome} na janela em foco`,
            alvo: hit.nome,
            loginId: hit.id,
          });
        },
      },
      helios_acao: {
        description: "Ação com efeito (enviar, apagar, pagar, publicar). Pede aprovação num cartão, a menos que o Helison tenha liberado esse tipo em Autonomia. Pagar nunca é liberado.",
        inputSchema: {
          type: "object",
          properties: { tipo: { type: "string" }, resumo: { type: "string" }, alvo: { type: "string" }, texto: { type: "string" } },
          required: ["tipo", "resumo"],
        },
        execute: async (args) => {
          // Só tipo, resumo, alvo e texto valem. Conector, login e conteúdo de arquivo têm ferramentas próprias, com suas conferências.
          const safe = sanitizeModelAction(args);
          const tipo = normalizeTipo(safe.tipo);
          if (tipo === "ler") return "Para ler ou pesquisar, use pesquisar_web ou mcp_chamar.";
          if (tipo === "escrever") return "Para gravar um arquivo, use escrever_arquivo.";
          if (tipo === "preencher") return "Para preencher um login, use helios_preencher_login.";
          return gate(convId, safe);
        },
      },
      escrever_arquivo: {
        description: "Grava um arquivo de texto dentro da pasta de projetos do HELIOS. Pede aprovação, a menos que o Helison tenha liberado esse tipo em Autonomia.",
        inputSchema: {
          type: "object",
          properties: { caminho: { type: "string" }, conteudo: { type: "string" } },
          required: ["caminho", "conteudo"],
        },
        execute: async (args) => {
          const caminho = String(args?.caminho || "").trim();
          if (!caminho) return "Informe o caminho do arquivo.";
          return gate(convId, {
            tipo: "escrever",
            resumo: `Gravar o arquivo ${caminho.slice(0, 120)}`,
            alvo: caminho,
            conteudo: String(args?.conteudo ?? ""),
          });
        },
      },
      mcp_chamar: {
        description: "Chama uma ferramenta de um conector MCP configurado. Ações de enviar, apagar, pagar ou publicar ficam no cartão.",
        inputSchema: {
          type: "object",
          properties: { servidor: { type: "string" }, ferramenta: { type: "string" }, argumentos: { type: "object" } },
          required: ["servidor", "ferramenta"],
        },
        execute: async (args) => {
          const servidor = String(args.servidor || "");
          const ferramenta = String(args.ferramenta || "");
          const allowed = assistantFor(convId).mcp;
          if (Array.isArray(allowed) && !allowed.includes(servidor)) {
            return `Este assistente não tem acesso ao conector "${clip(servidor)}". Peça ao Helison para liberar na tela Assistentes.`;
          }
          const known = mcp.findTool(servidor, ferramenta);
          if (!known) return `Não achei ${servidor}.${ferramenta} numa lista já testada. Confirme e teste o conector na tela Conectores antes de chamar.`;
          // Falha fechada: ferramenta de nome desconhecido ou que executa código/mexe em acesso nunca roda sem cartão.
          const kind = classifyToolDetailed(ferramenta, known.description || "");
          const tipo = kind.tipo;
          if (tipo === "ler" && !kind.forceCard && modeFor(convId, "ler") === "sozinho") {
            return clip(await mcp.call(servidor, ferramenta, args.argumentos || {}) || "O conector não devolveu texto.");
          }
          return gate(convId, {
            tipo,
            resumo: `${servidor}.${ferramenta}`,
            texto: JSON.stringify(args.argumentos || {}).slice(0, 500),
            mcp: { server: servidor, tool: ferramenta, args: args.argumentos || {} },
          });
        },
      },
      estacionar_tarefa: {
        description: "Estaciona a tarefa quando você NÃO consegue continuar (falta aprovação, informação ou um limite foi atingido). Salva o estado em disco (objetivo, o que já fez, o que falta) e abre na Caixa de entrada a pergunta exata com o botão Retomar. Depois de chamar, PARE.",
        inputSchema: {
          type: "object",
          properties: {
            objetivo: { type: "string" },
            feito: { type: "array", items: { type: "string" } },
            falta: { type: "array", items: { type: "string" } },
            pergunta: { type: "string" },
            motivo: { type: "string", description: "aprovacao, informacao ou limite" },
          },
          required: ["objetivo", "pergunta"],
        },
        execute: async (args) => parkTask(convId, ctx, args || {}).text,
      },
      perguntar_ao_helison: {
        description: "Faz uma pergunta ao Helison que precisa de resposta antes de continuar. Ela cai na Caixa de entrada. Depois de chamar, pare e espere a resposta.",
        inputSchema: {
          type: "object",
          properties: { pergunta: { type: "string" }, opcoes: { type: "array", items: { type: "string" } } },
          required: ["pergunta"],
        },
        execute: async (args) => queueQuestion(convId, args),
      },
      iniciar_livecoding: {
        description: "Abre o modo de reunião no livecoding, cria a pasta, o plano e abre o VS Code. Não grava o primeiro arquivo.",
        inputSchema: { type: "object", properties: { descricao: { type: "string" } }, required: ["descricao"] },
        execute: async (args) => {
          if (!onLivecoding) return "O livecoding não está disponível neste processo.";
          const session = await onLivecoding(String(args.descricao || "Página de exemplo"));
          return `Abri o livecoding “${session.title}” em ${session.folder}. O Helison avança com Próximo passo.`;
        },
      },
      agendar_rotina: {
        description: "Pede ao Helison para agendar uma rotina local (horário HH:MM ou cadaMinutos). Abre um cartão de aprovação: nada é agendado antes de ele aprovar. Há intervalo mínimo e número máximo de rotinas.",
        inputSchema: {
          type: "object",
          properties: { titulo: { type: "string" }, pedido: { type: "string" }, horario: { type: "string" }, cadaMinutos: { type: "number" } },
          required: ["titulo", "pedido"],
        },
        execute: async (args) => {
          let clean;
          try {
            clean = routines.checkLimits({ title: args.titulo, prompt: args.pedido, clock: args.horario, everyMinutes: args.cadaMinutos }, routineLimits());
          } catch (err) {
            return redact(err.message || err);
          }
          const quando = clean.clock ? `todo dia às ${clean.clock}` : `a cada ${clean.everyMinutes} minutos`;
          const id = queueCard(convId, {
            kind: "rotina",
            summary: `Agendar a rotina “${clean.title}” (${quando})`,
            detail: `Rotina: ${clean.title}\nQuando: ${quando}\nO que será pedido ao assistente a cada execução:\n${clean.prompt}\nA rotina roda sozinha, sem você olhando. Ações com efeito continuam pedindo cartão.`,
            action: { tipo: "rotina", rotina: clean },
          });
          return `PENDENTE — cartão ${id}. Nada foi agendado ainda. Peça ao Helison para aprovar ou ajustar.`;
        },
      },
    };
    Object.assign(tools, delegation.tools(convId, ctx, { queueCard: (card) => queueCard(convId, card) }));
    return { tools, sources };
  }

  function resolveAuth() {
    const account = accounts.active();
    if (!account?.apiKey) return null;
    return { accountId: account.id, apiKey: account.apiKey, label: accounts.display(account) };
  }

  async function catalogFor(auth) {
    if (forceMock() || !auth?.apiKey) return null;
    try {
      const sdk = await loadSdk();
      const list = await sdk.Cursor.models.list({ apiKey: auth.apiKey });
      return Array.isArray(list) ? list : null;
    } catch (err) {
      log(`[modelos] catálogo indisponível: ${redact(err.message || err)}`);
      return null;
    }
  }

  async function dispose(convId) {
    const entry = agents.get(convId);
    agents.delete(convId);
    const agent = entry?.agent;
    if (!agent) return;
    try {
      if (typeof agent[Symbol.asyncDispose] === "function") await agent[Symbol.asyncDispose]();
      else agent.close?.();
    } catch {
      /* ignora */
    }
  }

  /** Agente descartável (ajudante, consulta, resumo): sem retomar sessão, sem guardar nada. */
  async function openEphemeral({ name, selection, tools, auth }) {
    if (forceMock() || !auth?.apiKey) return createMockAgent({ tools });
    const sdk = await loadSdk();
    return sdk.Agent.create({
      name: String(name).slice(0, 80),
      model: selection,
      apiKey: auth.apiKey,
      local: { cwd, settingSources: [], sandboxOptions: { enabled: true }, customTools: tools },
      ...restrictedAgentOptions({ withCustomTools: Object.keys(tools || {}).length > 0 }),
    });
  }

  async function openAgent(conv, auth, selection, tools, { forceNew = false } = {}) {
    if (forceMock() || !auth?.apiKey) return { agent: createMockAgent({ tools }), fresh: true };
    const sdk = await loadSdk();
    const opts = {
      name: `HELIOS · ${conv.title}`.slice(0, 80),
      model: selection,
      apiKey: auth.apiKey,
      local: { cwd, settingSources: [], sandboxOptions: { enabled: true }, customTools: tools },
      // As restrições não ficam gravadas na sessão: valem de novo em Agent.create e em Agent.resume.
      ...restrictedAgentOptions({ withCustomTools: Object.keys(tools || {}).length > 0 }),
    };
    const cached = agents.get(conv.id);
    if (forceNew) {
      await dispose(conv.id);
      return { agent: await sdk.Agent.create(opts), fresh: true };
    }
    if (cached?.agent && cached.accountId === auth.accountId && conv.agentModel === selection.id) {
      return { agent: cached.agent, fresh: false };
    }
    if (cached?.agent) await dispose(conv.id);
    if (conv.agentId) {
      try {
        return { agent: await sdk.Agent.resume(conv.agentId, opts), fresh: false };
      } catch (err) {
        log(`[bot] não retomou a sessão: ${redact(err.message || err)}`);
      }
    }
    return { agent: await sdk.Agent.create(opts), fresh: true };
  }

  /**
   * Erro de limite de uso, de taxa ou de autenticação da conta ativa: vira um aviso claro, com o que fazer.
   * Nunca troca de conta e nunca repete o turno: quem decide é o Helison, no botão do aviso.
   */
  function accountNotice(raw, auth) {
    const issue = classifyAccountError(raw);
    if (!issue || !auth?.accountId) return null;
    accounts.noteIssue?.(auth.accountId, issue.kind);
    const label = auth.label;
    const next = issue.kind === "rate" ? null : accounts.nextAccount?.(auth.accountId) || null;
    const head = describeAccountIssue(issue, label);
    let tail;
    if (issue.kind === "rate") {
      tail = "Isso é limite de velocidade (muitos pedidos seguidos) e passa sozinho: espere cerca de um minuto e reenvie a mensagem na mesma conta. Não precisa trocar de conta.";
    } else if (issue.kind === "usage") {
      tail = next
        ? `O HELIOS não troca de conta sozinho. Se quiser continuar agora, troque para a ${next.label}${next.limited ? " (ela também já bateu o limite hoje)" : ""}. Ou espere o limite renovar.`
        : "Não há outra conta cadastrada. Espere o limite renovar ou cadastre outra conta em Conta Cursor.";
    } else {
      tail = next ? `Cole uma chave nova em Conta Cursor ou, se preferir, troque para a ${next.label}.` : "Cole uma chave nova em Conta Cursor.";
    }
    return {
      text: `${head} ${tail}`,
      accountIssue: { kind: issue.kind, accountId: auth.accountId, accountLabel: label, next: next ? { id: next.id, label: next.label } : null },
    };
  }

  function finish(convId, replyId, patch) {
    store.update(convId, (conv) => {
      const reply = conv.messages.find((message) => message.id === replyId);
      if (reply) Object.assign(reply, patch, { narration: "" });
      conv.busy = false;
      if (conv.title === "Nova conversa") {
        const user = conv.messages.find((message) => message.role === "user");
        if (user?.text) conv.title = user.text.replace(/\s+/g, " ").slice(0, 48);
      }
    });
  }

  /**
   * Resumo corrido: depois de N mensagens (ou M caracteres) as mais antigas viram um resumo curto
   * e a nova sessão do agente começa com "resumo + últimas mensagens". Sem modelo (demonstração)
   * ou se o resumo por agente falhar, usa o resumo extrativo.
   */
  async function rollSummary(convId, conv, earlier, keep, assistantId) {
    const limits = orchestration.limits();
    const plan = planSummary({
      messages: earlier,
      summary: conv.summary || null,
      keep,
      afterMessages: limits.resumoAposMensagens,
      afterChars: limits.resumoAposCaracteres,
    });
    let summary = conv.summary || null;
    let updated = false;
    if (plan.update) {
      let text = "";
      if (!forceMock() && resolveAuth()?.apiKey) {
        const summaryAsk = summaryPrompt(plan.previous, plan.fresh);
        const summaryStart = Date.now();
        const outcome = await delegation.runEphemeral({ name: "HELIOS · resumo", prompt: summaryAsk, tools: {} });
        usage?.record(assistantId, { kind: "resumo", charsIn: summaryAsk.length, charsOut: outcome.text.length, ms: Date.now() - summaryStart, usage: outcome.usage });
        if (outcome.status === "done" && outcome.text.trim().length >= 20) text = redact(outcome.text.trim()).slice(0, SUMMARY_MAX);
        orchestration.addUsage(assistantId, "conversas", outcome.usage);
      }
      if (!text) text = extractiveSummary(plan.previous, plan.fresh);
      const upTo = plan.older[plan.older.length - 1].id;
      summary = { text, upTo, covered: plan.older.length, updatedAt: nowIso(), rollovers: ((conv.summary && conv.summary.rollovers) || 0) + 1 };
      store.update(convId, (item) => {
        item.summary = summary;
      });
      updated = true;
    }
    return { summary, recent: plan.recent, updated, active: Boolean(summary) };
  }

  /** Registra a chamada no medidor de uso; devolve um aviso curto quando cruzou 80% ou 100% do limite. */
  function meter(assistant, info) {
    if (!usage) return "";
    const before = usage.status(assistant.id).state;
    const after = usage.record(assistant.id, info);
    if (after.state === before || (after.state !== "alerta" && after.state !== "limite")) return "";
    return after.state === "limite"
      ? `\n\n⚠ Uso do dia: limite de ${assistant.name} atingido (${after.percent}%).${after.limit.bloquear ? " Novas mensagens ficam bloqueadas até amanhã ou até você aumentar o limite." : " O bloqueio está desligado, então segue funcionando."}`
      : `\n\n⚠ Uso do dia: ${after.percent}% do limite de ${assistant.name}. Veja em Atividade › Painel de uso.`;
  }

  async function runTurn(convId, text, { level, replyId }) {
    const conv = store.get(convId);
    const gate = assistants.resolve(conv.assistantId);
    const blocked = usage?.blockReason(gate.id, gate.name);
    if (blocked) {
      finish(convId, replyId, { status: "error", text: blocked });
      return;
    }
    const auth = resolveAuth();
    const catalog = await catalogFor(auth);
    const picked = chooseModel({ text, override: level, catalog });
    const limits = HISTORY[picked.level] || HISTORY.padrao;
    const earlier = conv.messages.filter((message) => message.id !== replyId);
    const assistant = assistants.resolve(conv.assistantId);
    const own = contexts.for(assistant.id);
    own.compact({ reason: "compactação automática (limite do contexto)" });
    const rolled = await rollSummary(convId, conv, earlier, limits[0], assistant.id);
    const prompt = buildPrompt({
      text,
      level: picked.level,
      history: rolled.summary ? compactHistory(rolled.recent, Math.max(limits[0], rolled.recent.length), limits[1]) : compactHistory(earlier, limits[0], limits[1]),
      summaryText: rolled.summary ? rolled.summary.text : "",
      assistantText: assistantPrompt(assistant),
      memoryText: memories.for(assistant.id).context({ text, maxChars: limits[2] }).text,
      contextText: own.promptText(),
      vaultText: vaultPrompt(getVaultIndex?.() || []),
    });
    const { tools, sources } = makeTools(convId);
    let opened;
    try {
      opened = await openAgent(conv, auth, picked.selection, tools, { forceNew: rolled.updated });
    } catch (err) {
      const notice = accountNotice(err, auth);
      finish(convId, replyId, notice
        ? { status: "error", ...notice, model: picked.label, level: picked.level, reason: picked.reason }
        : { status: "error", text: `Não consegui abrir o agente: ${redact(err.message || err)}`, model: picked.label, level: picked.level, reason: picked.reason });
      return;
    }
    agents.set(convId, { agent: opened.agent, accountId: auth?.accountId || null });
    store.update(convId, (item) => {
      item.agentId = opened.agent.agentId || item.agentId;
      item.agentModel = picked.selection.id;
    });
    let streamed = "";
    const turnStart = Date.now();
    try {
      const run = await opened.agent.send(opened.fresh ? prompt : `${prompt}`, { model: picked.selection });
      if (typeof run.supports !== "function" || run.supports("stream")) {
        for await (const raw of run.stream()) {
          const msg = unwrapStreamEvent(raw);
          if (!msg) continue;
          if (msg.type === "assistant") {
            const chunk = extractAssistantText(msg);
            if (!chunk) continue;
            streamed = chunk.startsWith(streamed) ? chunk : streamed + chunk;
            store.update(convId, (item) => {
              const reply = item.messages.find((message) => message.id === replyId);
              if (reply) reply.narration = redact(streamed).slice(-400);
            });
          } else if (msg.type === "tool_call" && msg.status === "running") {
            store.update(convId, (item) => {
              const reply = item.messages.find((message) => message.id === replyId);
              if (reply) reply.narration = humanTool(msg.name);
            });
          }
        }
      }
      const result = await run.wait();
      if (result?.status === "error") {
        const failed = accountNotice(result.error || { message: String(result.result || "") }, auth);
        if (failed) {
          meter(assistant, { kind: "mensagem", charsIn: prompt.length, charsOut: streamed.length, ms: Date.now() - turnStart });
          finish(convId, replyId, { status: "error", ...failed, model: picked.label, level: picked.level, reason: picked.reason });
          return;
        }
      }
      if (auth?.accountId) accounts.noteOk?.(auth.accountId);
      const finalText = String(result?.result || streamed || "Pronto.").trim();
      orchestration.addUsage(assistant.id, "conversas", result?.usage || run.usage);
      const usageNote = meter(assistant, { kind: "mensagem", charsIn: prompt.length, charsOut: finalText.length, ms: Date.now() - turnStart, usage: result?.usage || run.usage });
      finish(convId, replyId, {
        status: result?.status === "error" ? "error" : "done",
        text: clip(finalText) + usageNote,
        model: picked.label,
        level: picked.level,
        reason: picked.reason,
        sources: sources.slice(0, 5),
      });
    } catch (err) {
      await dispose(convId);
      meter(assistant, { kind: "mensagem", charsIn: prompt.length, charsOut: streamed.length, ms: Date.now() - turnStart });
      const notice = accountNotice(err, auth);
      finish(convId, replyId, notice
        ? { status: "error", ...notice, model: picked.label, level: picked.level, reason: picked.reason }
        : { status: "error", text: `Algo deu errado: ${redact(err.message || err)}`, model: picked.label, level: picked.level, reason: picked.reason });
    }
  }

  function send(convId, text, { level = "auto" } = {}) {
    const conv = store.get(convId);
    if (!conv) throw Object.assign(new Error("conversa não encontrada"), { status: 404 });
    const typed = String(text || "").trim();
    if (!typed) throw Object.assign(new Error("Escreva uma mensagem."), { status: 400 });
    // Fase 3: segredo digitado no chat é mascarado antes de ir ao modelo, ao histórico e ao disco; o Helison é avisado.
    const screened = screenUserText(typed);
    const clean = screened.text;
    if (clean.length > MAX_MESSAGE_CHARS) {
      throw Object.assign(new Error(`A mensagem é grande demais (${clean.length.toLocaleString("pt-BR")} caracteres). O limite é ${MAX_MESSAGE_CHARS.toLocaleString("pt-BR")}. Divida em partes menores ou envie como arquivo.`), { status: 413 });
    }
    if (conv.busy) throw Object.assign(new Error("Ainda estou respondendo esta conversa."), { status: 409 });
    if (level !== "auto" && !LEVELS.includes(level)) throw Object.assign(new Error("Nível inválido."), { status: 400 });
    const replyId = newId("msg");
    store.update(convId, (item) => {
      item.busy = true;
      item.messages.push(
        { id: newId("msg"), role: "user", text: clean, at: nowIso(), status: "done", ...(screened.masked ? { aviso: screened.notice } : {}) },
        { id: replyId, role: "assistant", text: "", status: "running", at: nowIso(), narration: "Pensando", sources: [] },
      );
    });
    runTurn(convId, clean, { level, replyId }).catch((err) => {
      log(`[bot] ${redact(err.stack || err)}`);
      finish(convId, replyId, { status: "error", text: `Algo deu errado: ${redact(err.message || err)}` });
    });
    return store.get(convId);
  }

  /** Depois de decidir um cartão de ajudante já encerrado, a conversa descartável some. */
  function afterDecision(convId) {
    const snapshot = store.get(convId);
    delegation.cleanupHelperConv(convId);
    return snapshot;
  }

  // Dois cliques rápidos (ou dois clientes) em "Aprovar" com uma ação lenta executavam a ação duas vezes.
  const deciding = new Set();
  async function decide(convId, approvalId, input = {}) {
    const key = `${convId}:${approvalId}`;
    if (deciding.has(key)) throw Object.assign(new Error("este pedido já está sendo decidido"), { status: 409 });
    deciding.add(key);
    try {
      return await decideNow(convId, approvalId, input);
    } finally {
      deciding.delete(key);
    }
  }

  const EXPIRED_NOTE = "Expirou sem resposta e nada foi feito. Você pode reabrir.";
  const EXPIRED_KEEP_MS = 7 * 24 * 3600 * 1000;

  function markExpired(convId, approvalId) {
    store.update(convId, (conv) => {
      const found = conv.messages.find((message) => message.id === approvalId);
      if (!found || found.state !== "pending") return;
      found.state = "expired";
      found.result = EXPIRED_NOTE;
      found.expiredAt = new Date(now()).toISOString();
    });
  }

  const isPastExpiry = (item) => Boolean(item && item.state === "pending" && item.expiresAt && Date.parse(item.expiresAt) <= now());

  /**
   * Varre os pedidos de rotinas e ajudantes: os que passaram da validade viram "expirado", sem executar nada.
   * Pedidos expirados há mais de 7 dias são descartados (e a conversa descartável do ajudante some).
   */
  function expireDue() {
    let expired = 0;
    for (const conv of store.list()) {
      for (const message of conv.messages || []) {
        if (message.role !== "approval") continue;
        if (isPastExpiry(message)) {
          markExpired(conv.id, message.id);
          expired += 1;
        } else if (message.state === "expired" && message.expiredAt && now() - Date.parse(message.expiredAt) > EXPIRED_KEEP_MS) {
          store.update(conv.id, (current) => {
            const found = current.messages.find((entry) => entry.id === message.id);
            if (found) {
              found.state = "denied";
              found.result = "Descartado: expirou há mais de 7 dias. Nada foi feito.";
            }
          });
          delegation.cleanupHelperConv(conv.id);
        }
      }
    }
    return expired;
  }

  /** Cria a rotina aprovada, conferindo de novo os tetos (podem ter mudado desde o cartão). */
  function performRoutine(rotina) {
    const clean = routines.checkLimits(rotina || {}, routineLimits());
    const created = routines.add(clean);
    const quando = created.clock ? `todo dia às ${created.clock}` : `a cada ${created.everyMinutes} minutos`;
    return `Aprovado. Agendei “${created.title}” (${quando}).`;
  }

  async function decideNow(convId, approvalId, { decision, note } = {}) {
    const conv = store.get(convId);
    let item = conv?.messages.find((message) => message.id === approvalId);
    if (!item || item.role !== "approval") throw Object.assign(new Error("pedido não encontrado"), { status: 404 });
    // Vencido entre uma varredura e outra: vira "expirado" aqui e nunca é executado.
    if (isPastExpiry(item)) {
      markExpired(convId, approvalId);
      item = store.get(convId).messages.find((message) => message.id === approvalId);
    }
    if (decision === "reopen") {
      if (item.state !== "expired") throw Object.assign(new Error("só um pedido expirado pode ser reaberto"), { status: 409 });
      const proposed = item.action && item.action.tipo === "assistente" ? item.action.assistantId : "";
      if (proposed && assistants.listPending && !assistants.listPending().some((entry) => entry.id === proposed)) {
        throw Object.assign(new Error("a proposta deste assistente não existe mais"), { status: 409 });
      }
      const expiresAt = expiryStamp(convId);
      store.update(convId, (current) => {
        const found = current.messages.find((message) => message.id === approvalId);
        found.state = "pending";
        found.expiresAt = expiresAt;
        found.result = "";
        found.reopened = (found.reopened || 0) + 1;
      });
      return store.get(convId);
    }
    if (item.state === "expired" && decision !== "deny") {
      throw Object.assign(new Error("este pedido expirou e nada foi feito. Reabra para decidir"), { status: 409 });
    }
    if (item.state !== "pending" && item.state !== "expired") throw Object.assign(new Error("este pedido já foi decidido"), { status: 409 });
    const proposedAssistant = item.action && item.action.tipo === "assistente" ? item.action.assistantId : "";
    if (decision === "adjust") {
      if (proposedAssistant) delegation.rejectAssistant(proposedAssistant);
      store.update(convId, (current) => {
        const found = current.messages.find((message) => message.id === approvalId);
        found.state = "adjust";
        found.result = redact(String(note || "Ajuste pedido.")).slice(0, 400);
      });
      return afterDecision(convId);
    }
    if (decision === "deny") {
      if (proposedAssistant) delegation.rejectAssistant(proposedAssistant);
      store.update(convId, (current) => {
        const found = current.messages.find((message) => message.id === approvalId);
        found.state = "denied";
        found.result = redact(String(note || "Negado pelo Helison. Nada foi feito.")).slice(0, 400);
      });
      return afterDecision(convId);
    }
    if (decision !== "approve") throw Object.assign(new Error("decisão inválida"), { status: 400 });
    try {
      // O que roda é exatamente o que o cartão mostrou: se a ação ou o texto do cartão mudaram depois de criados, nada é executado.
      if (item.digest && item.digest !== digestOf({ action: item.action, detail: item.detail })) {
        throw new Error("A ação mudou depois que o cartão foi criado. Nada foi executado. Peça de novo.");
      }
      let result;
      if (proposedAssistant) result = delegation.approveAssistant(proposedAssistant);
      else if (item.action && item.action.tipo === "rotina") result = performRoutine(item.action.rotina);
      else {
        if (item.action && item.action.mcp) {
          const checked = revalidateMcp(convId, cleanAction(item.action));
          if (checked.error) throw new Error(checked.error);
        }
        result = await actions.perform(item.action);
      }
      store.update(convId, (current) => {
        const found = current.messages.find((message) => message.id === approvalId);
        found.state = "done";
        found.result = result;
      });
    } catch (err) {
      store.update(convId, (current) => {
        const found = current.messages.find((message) => message.id === approvalId);
        found.state = "error";
        found.result = redact(err.message || err);
      });
    }
    return afterDecision(convId);
  }

  /** Responde (ou dispensa) uma pergunta pendente. A resposta volta à conversa como mensagem do Helison. */
  function answerQuestion(convId, questionId, { answer, dismiss } = {}) {
    const conv = store.get(convId);
    const item = conv?.messages.find((message) => message.id === questionId);
    if (!item || item.role !== "question") throw Object.assign(new Error("pergunta não encontrada"), { status: 404 });
    if (item.state !== "pending") throw Object.assign(new Error("esta pergunta já foi respondida"), { status: 409 });
    const parkedEntry = item.parked && parking ? parking.get(item.parked) : null;
    if (dismiss) {
      store.update(convId, (current) => {
        const found = current.messages.find((message) => message.id === questionId);
        found.state = "dismissed";
      });
      if (item.parked && parking) parking.discard(item.parked);
      const kept = store.get(convId);
      delegation.cleanupHelperConv(convId);
      return kept;
    }
    let text = redact(String(answer || "").replace(/\s+/g, " ").trim()).slice(0, 1000);
    if (!text && parkedEntry) text = "Pode retomar.";
    if (!text) throw Object.assign(new Error("Escreva a resposta."), { status: 400 });
    // Tarefa estacionada: a retomada leva o estado salvo (objetivo, feito, falta) junto com a resposta.
    const withState = (lead) => (parkedEntry ? `${lead}\n${parking.stateBlock(parkedEntry)}` : lead);
    if (conv.busy) throw Object.assign(new Error("Ainda estou respondendo esta conversa. Tente de novo em instantes."), { status: 409 });
    if (conv.helper) {
      // O ajudante já entregou o relatório e saiu: a resposta segue para a conversa de quem o criou.
      let parentId = conv.helper.parentConvId;
      let parent = store.get(parentId);
      if (!parent && parkedEntry) {
        // A conversa que criou o ajudante sumiu: a tarefa estacionada recomeça numa conversa nova do mesmo assistente.
        parent = store.create(`Retomar: ${parkedEntry.objetivo.slice(0, 50)}`, parkedEntry.assistantId);
        parentId = parent.id;
      }
      if (!parent) throw Object.assign(new Error("A conversa que criou este ajudante não existe mais."), { status: 409 });
      if (parent.busy) throw Object.assign(new Error("O assistente ainda está respondendo. Tente de novo em instantes."), { status: 409 });
      store.update(convId, (current) => {
        const found = current.messages.find((message) => message.id === questionId);
        found.state = "answered";
        found.answer = text;
      });
      const task = conv.helper.task || "tarefa de um ajudante";
      send(parentId, withState(`Resposta à sua pergunta "${item.question.slice(0, 160)}" (feita pelo ajudante da tarefa "${task.slice(0, 80)}"): ${text}`), { level: "auto" });
      if (parkedEntry) parking.markResumed(parkedEntry.id);
      delegation.cleanupHelperConv(convId);
      return store.get(convId) || conv;
    }
    store.update(convId, (current) => {
      const found = current.messages.find((message) => message.id === questionId);
      found.state = "answered";
      found.answer = text;
    });
    const sent = send(convId, withState(`Resposta à sua pergunta "${item.question.slice(0, 160)}": ${text}`), { level: "auto" });
    if (parkedEntry) parking.markResumed(parkedEntry.id);
    return sent;
  }

  async function runLiveStep({ folder, step }) {
    const auth = resolveAuth();
    if (forceMock() || !auth?.apiKey) {
      writeFiles(folder, step.files || []);
      return { via: "plano", text: step.explicacao };
    }
    const sdk = await loadSdk();
    const selection = chooseModel({ text: step.titulo, override: "padrao" }).selection;
    const tools = {
      escrever_arquivo: {
        description: "Grava um arquivo UTF-8 dentro da pasta deste livecoding. Recusa caminho fora dela.",
        inputSchema: {
          type: "object",
          properties: { caminho: { type: "string" }, conteudo: { type: "string" } },
          required: ["caminho", "conteudo"],
        },
        execute: async (args) => {
          writeFiles(folder, [{ path: String(args.caminho || ""), contents: String(args.conteudo ?? "") }]);
          return `Gravei ${args.caminho}.`;
        },
      },
    };
    const agent = await sdk.Agent.create({
      name: "HELIOS · livecoding",
      apiKey: auth.apiKey,
      model: selection,
      local: { cwd: folder, settingSources: [], sandboxOptions: { enabled: true }, customTools: tools },
      ...restrictedAgentOptions(),
    });
    try {
      const files = (step.files || []).map((file) => `Grave ${file.path} com escrever_arquivo. Conteúdo:\n${file.contents}`).join("\n\n");
      const prompt = [
        "Modo livecoding do HELIOS. Você ensina um estagiário.",
        "Execute SOMENTE este passo. Não antecipe o próximo.",
        "Responda em português do Brasil, em poucas frases, dizendo o que fez.",
        `Pasta: ${folder}`,
        `Passo ${step.n}: ${step.titulo}`,
        step.explicacao,
        files,
      ].filter(Boolean).join("\n\n");
      const run = await agent.send(prompt, { model: selection });
      const result = await run.wait();
      return { via: "agente", text: clip(result?.result || step.explicacao) };
    } finally {
      try {
        if (typeof agent[Symbol.asyncDispose] === "function") await agent[Symbol.asyncDispose]();
      } catch {
        /* ignora */
      }
    }
  }

  async function proposeLivePlan(description) {
    const pedido = String(description || "").trim().slice(0, 500);
    const auth = resolveAuth();
    if (forceMock() || !auth?.apiKey) return draftPlanFromRequest(pedido);
    try {
      const sdk = await loadSdk();
      const selection = chooseModel({ text: pedido, override: "padrao" }).selection;
      const agent = await sdk.Agent.create({
        name: "HELIOS · plano",
        apiKey: auth.apiKey,
        model: selection,
        local: { cwd: cwd || process.cwd(), settingSources: [], sandboxOptions: { enabled: true } },
        ...restrictedAgentOptions({ withCustomTools: false }),
      });
      try {
        const prompt = [
          "Monte o plano de livecoding do HELIOS para um estagiário de front-end.",
          "Responda somente com um JSON, sem texto antes ou depois.",
          "Formato: {\"title\":\"...\",\"steps\":[{\"titulo\":\"...\",\"explicacao\":\"...\",\"files\":[{\"path\":\"index.html\",\"contents\":\"...\"}]}]}",
          "Regras: 3 a 5 passos em português do Brasil. O último passo é uma revisão e fica com files vazio.",
          "O primeiro passo cria index.html. Use só caminhos relativos simples (index.html, style.css, script.js). Sem .. e sem caminho absoluto.",
          "O conteúdo dos arquivos tem de atender ao pedido, não uma página genérica.",
          `Pedido: ${pedido}`,
        ].join("\n");
        const run = await agent.send(prompt, { model: selection });
        const result = await run.wait();
        return normalizePlan(parsePlanJson(result?.result || "")) || draftPlanFromRequest(pedido);
      } finally {
        try {
          if (typeof agent[Symbol.asyncDispose] === "function") await agent[Symbol.asyncDispose]();
        } catch {
          /* ignora */
        }
      }
    } catch (err) {
      log(`[livecoding] plano: ${redact(err.message || err)}`);
      return draftPlanFromRequest(pedido);
    }
  }

  async function modelsView(text = "") {
    const auth = resolveAuth();
    const catalog = await catalogFor(auth);
    const auto = chooseModel({ text, catalog });
    return {
      auto: { id: auto.id, label: auto.label, level: auto.level, reason: auto.reason, kind: auto.kind },
      account: auth ? auth.label : null,
      mock: forceMock() || !auth,
      estimates: require("./model-policy").referenceEstimates(),
    };
  }

  return { send, decide, answerQuestion, expireDue, runLiveStep, proposeLivePlan, modelsView, dispose, resolveAuth };
}

module.exports = { createBot };
