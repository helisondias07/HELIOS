"use strict";

/**
 * LEVA O1: agente Chefe (vice interno). Lê o quadro, prioriza, delega aos 4 agentes
 * e pede aprovação para o crítico. Ciclo contínuo pausável; padrão conservador.
 * Oasis isolado dos itens de emprego. Nunca inventa números.
 * LEVA O2: painel com uso % por agente (só dado real; senão null → UI "sem dados"),
 * pausar/retomar por agente, resolver aprovações.
 * LEVA O7: usoPct = % do uso (tokens) da conta ativa atribuído ao agente; limite diário
 * pausa + alerta no quadro; resumo matinal (rotina) sem $ na tela.
 * LEVA R2: destina itens via roteador gratis (agent "chefe"); sem chave/falha → regras atuais.
 * Nenhum dado pessoal (CPF, telefone, endereço, e-mail) no prompt.
 */
const path = require("node:path");
const { nowIso, readJson, writeJson, redact, newId } = require("./util");

const AGENTES = [
  {
    id: "vagas",
    nome: "Vagas",
    missao: "Buscar, filtrar e candidatar o Helison a vagas de front-end, com paradas críticas e ritmo humano.",
    entradas: ["preferências", "perfil", "plataformas", "pedidos no quadro"],
    saidas: ["achados de vaga", "resultados de inscrição", "alertas críticos"],
  },
  {
    id: "pesquisa",
    nome: "Pesquisa",
    missao: "Agregar skills pedidas nas vagas, comparar com o perfil e publicar lacunas no quadro.",
    entradas: ["achados de Vagas", "perfil.skills"],
    saidas: ["lacunas", "pedidos ao Portfólio"],
  },
  {
    id: "oasis",
    nome: "Oasis",
    missao: "Ler tarefas atribuídas no ClickUp, propor plano, executar no repo e comentar no ClickUp só com aprovação. Isolado de emprego.",
    entradas: ["tarefas ClickUp", "pedidos Oasis no quadro"],
    saidas: ["planos", "resultados Oasis", "comentários ClickUp (aprovados)"],
  },
  {
    id: "portfolio",
    nome: "Portfólio",
    missao: "Receber lacunas, propor 1 projeto pequeno, criar repo local e evidência; GitHub/Vercel só com aprovação.",
    entradas: ["pedidos de Pesquisa", "lacunas"],
    saidas: ["repos locais", "pendências de publicação", "evidências em perfil.skills"],
  },
];

const AGENTE_IDS = new Set(AGENTES.map((a) => a.id));
const EMPREGO_RE = /vaga|emprego|candidatura|linkedin|curriculo|\bcv\b|salar|inscri/i;
const CRITICO_RE = /pagar|pagamento|publicar|postar|apagar|cpf|senha|token|produção|producao|force.?push|contrato|exclusiv/i;
const DEFAULT_INTERVAL_MIN = 30;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function cleanPausados(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const id of AGENTE_IDS) {
    if (raw[id] === true) out[id] = true;
  }
  return out;
}

/**
 * Uso em % da conta ativa atribuído ao agente (tokens reais do SDK).
 * Preferência: accountSharePct. Fallback legado: status.percent (limite próprio).
 * null = sem dados; nunca inventa.
 */
function usoPctDe(usage, agentId) {
  if (!usage) return null;
  try {
    if (typeof usage.accountSharePct === "function") {
      const pct = usage.accountSharePct(agentId);
      if (pct != null && Number.isFinite(Number(pct))) {
        return Math.min(100, Math.max(0, Math.round(Number(pct))));
      }
      return null;
    }
    if (typeof usage.status !== "function") return null;
    const st = usage.status(agentId);
    if (!st || st.percent == null || !Number.isFinite(Number(st.percent))) return null;
    return Math.min(100, Math.max(0, Math.round(Number(st.percent))));
  } catch {
    return null;
  }
}

const CHEFE_RESUMO_MARK = "[chefe-resumo-matinal]";
const CHEFE_RESUMO_TITLE = "Resumo matinal do Chefe";

/** Remove CPF, e-mail, telefone e endereço do texto antes de mandar ao modelo. */
function scrubPii(text) {
  let s = String(text || "");
  s = s.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[cpf]");
  s = s.replace(/\b[\w.+-]+@[\w.-]+\.\w{2,}\b/gi, "[email]");
  s = s.replace(/(?:\+?\d{1,3}\s*)?(?:\(?\d{2}\)?\s*)?\d{4,5}[-.\s]?\d{4}\b/g, "[telefone]");
  s = s.replace(/\b(rua|avenida|av\.|alameda|travessa|rodovia|cep|endere[cç]o)\b[^.\n]{0,100}/gi, "[endereco]");
  return s.slice(0, 2000);
}

function createChefe(dataDir, { quadro, missions, assistants, orchestration, store, bot, usage, routines, llm = null, runTask = null, operacional = false } = {}) {
  if (!quadro) throw new Error("chefe precisa do quadro");
  const file = path.join(dataDir, "chefe.json");
  const saved = readJson(file, {});
  let state = {
    version: 1,
    // O HELIOS instalado opera por padrão; uma pausa salva pelo Helison sempre vence.
    pausado: saved.pausado === undefined ? !operacional : saved.pausado !== false,
    intervaloMin: Math.min(240, Math.max(5, Number(saved.intervaloMin) || DEFAULT_INTERVAL_MIN)),
    ultimoCicloEm: saved.ultimoCicloEm || null,
    ultimoResumo: saved.ultimoResumo || "",
    ultimoResumoMatinal: saved.ultimoResumoMatinal || null,
    ciclos: Number(saved.ciclos) || 0,
    pendenciasAprovacao: Array.isArray(saved.pendenciasAprovacao) ? saved.pendenciasAprovacao : [],
    agentesPausados: cleanPausados(saved.agentesPausados),
  };

  function persist() {
    writeJson(file, state);
  }

  function ultimoResultadoDe(agentId) {
    const de = quadro.ler({ de: agentId, tipo: "resultado", limite: 1 });
    const para = quadro.ler({ para: agentId, tipo: "resultado", limite: 1 });
    const candidatos = [...de, ...para].sort((a, b) => String(b.atualizadoEm || b.criadoEm || "").localeCompare(String(a.atualizadoEm || a.criadoEm || "")));
    const r = candidatos[0];
    if (!r) return null;
    return {
      id: r.id,
      assunto: r.assunto,
      em: r.atualizadoEm || r.criadoEm,
    };
  }

  function agentesView() {
    return AGENTES.map((a) => {
      const ast = assistants?.find?.(a.id) || assistants?.get?.(a.id);
      const missoes = missions?.list?.({ assistantId: a.id }) || [];
      const abertos = quadro.ler({ para: a.id, status: "aberto", limite: 20 });
      const andamento = quadro.ler({ para: a.id, status: "em_andamento", limite: 20 });
      const pausado = state.agentesPausados[a.id] === true;
      const itensAbertos = abertos.length + andamento.length;
      let status = "ativo";
      if (pausado) status = "pausado";
      else if (itensAbertos > 0) status = "trabalhando";
      else if (missoes.some((m) => m.status === "aguardando")) status = "aguardando";
      const usoPct = usoPctDe(usage, a.id);
      const log = usage && typeof usage.agentLog === "function" ? usage.agentLog(a.id) : null;
      return {
        id: a.id,
        nome: a.nome,
        missao: a.missao,
        assistente: ast ? { id: ast.id, name: ast.name, role: ast.role } : null,
        missoesAtivas: missoes.filter((m) => m.status === "em_andamento" || m.status === "planejando" || m.status === "aguardando").length,
        itensAbertos,
        entradas: a.entradas,
        saidas: a.saidas,
        pausado,
        status,
        ultimoResultado: ultimoResultadoDe(a.id),
        // null = UI mostra "sem dados"; nunca inventar; só % (sem $)
        usoPct,
        tokensHoje: log && Number.isFinite(Number(log.tokensHoje)) ? Number(log.tokensHoje) : null,
        limiteTokens: log && log.limiteTokens ? log.limiteTokens : 0,
        limitePct: log && log.limitePct != null ? log.limitePct : null,
      };
    });
  }

  function seedPapeis() {
    if (!assistants?.seedBuiltins) return { seeded: false };
    assistants.seedBuiltins();
    // Missões-base (uma por agente), só se ainda não houver missão ativa.
    const criadas = [];
    for (const a of AGENTES) {
      const existentes = missions?.list?.({ assistantId: a.id }) || [];
      if (existentes.some((m) => m.status !== "cancelada" && m.status !== "entregue")) continue;
      if (!missions?.create) continue;
      const m = missions.create({
        title: `Missão contínua: ${a.nome}`,
        goal: a.missao,
        assistantId: a.id,
      });
      criadas.push(m.id);
    }
    return { seeded: true, missoes: criadas };
  }

  function prioridade(item) {
    let score = 0;
    if (item.tipo === "alerta") score += 100;
    if (item.tipo === "pedido") score += 40;
    if (item.tipo === "resultado") score += 20;
    if (item.tipo === "achado") score += 10;
    if (CRITICO_RE.test(`${item.assunto} ${item.corpo}`)) score += 80;
    return score;
  }

  function destinar(item) {
    const blob = `${item.assunto} ${item.corpo}`.toLowerCase();
    if (item.para && item.para !== "chefe") return item.para;
    if (/oasis|clickup/.test(blob)) return "oasis";
    if (/lacuna|skill|docker|react|typescript|estud/.test(blob) && !/inscri|candidat/.test(blob)) return "pesquisa";
    if (/projeto|portfolio|portfólio|repo|evidenc/.test(blob)) return "portfolio";
    if (EMPREGO_RE.test(blob)) return "vagas";
    if (/pesquisa|agregar|comparar perfil/.test(blob)) return "pesquisa";
    return "pesquisa";
  }

  /**
   * Destino via modelo gratis (agent chefe). Sem llm/chave/falha → regras de destinar().
   * Prompt só com assunto/corpo higienizados — nunca CPF, telefone, endereço ou e-mail.
   */
  async function destinarComLlm(item) {
    const fallback = destinar(item);
    if (!llm || typeof llm.chat !== "function") return fallback;
    try {
      const assunto = scrubPii(item.assunto);
      const corpo = scrubPii(item.corpo);
      const r = await llm.chat({
        agent: "chefe",
        messages: [
          {
            role: "system",
            content: "Voce e o Chefe do HELIOS. Escolha UM agente destino. Responda so JSON: {\"destino\":\"vagas|pesquisa|oasis|portfolio\"}. Oasis nunca recebe item de emprego/candidatura. Nunca peca nem use CPF, telefone, endereco ou e-mail.",
          },
          {
            role: "user",
            content: JSON.stringify({
              assunto,
              corpo,
              agentes: AGENTES.map((a) => ({ id: a.id, missao: a.missao })),
            }),
          },
        ],
      });
      const m = String((r && r.message && r.message.content) || "").match(/\{[\s\S]*\}/);
      const dest = m ? String(JSON.parse(m[0]).destino || "").toLowerCase() : "";
      if (!AGENTE_IDS.has(dest)) return fallback;
      if (dest === "oasis" && EMPREGO_RE.test(`${item.assunto} ${item.corpo}`)) return fallback;
      return dest;
    } catch {
      return fallback;
    }
  }

  function registrarPendencia(item, motivo) {
    const entry = {
      id: newId("cap"),
      quadroId: item.id,
      motivo: redact(motivo).slice(0, 200),
      criadoEm: nowIso(),
      estado: "pendente",
    };
    state.pendenciasAprovacao = [entry, ...state.pendenciasAprovacao.filter((p) => p.estado === "pendente")].slice(0, 50);
    persist();
    return entry;
  }

  /**
   * Um ciclo do chefe: lê itens abertos para o chefe, prioriza, delega ou pede aprovação.
   * Não inventa números: só conta o que leu no quadro.
   * LEVA R2: destino pode vir do LLM gratis; falha → regras.
   */
  async function ciclo({ forcar = false } = {}) {
    if (state.pausado && !forcar) {
      return { ok: false, motivo: "Chefe pausado.", pausado: true };
    }
    const entradas = quadro.ler({ para: "chefe", status: "aberto", limite: 40 });
    // Resultados dos agentes são retorno, não novos pedidos. Antes eles eram
    // delegados novamente pelo Chefe e criavam uma fila infinita de “Resultado
    // Vagas (ciclo)” para Vagas/Pesquisa, deixando a interface em Trabalhando.
    const retornos = entradas.filter((item) => item.tipo === "resultado" || (item.tipo === "achado" && item.de !== "helison"));
    for (const item of retornos) quadro.atualizarStatus(item.id, "feito");
    const abertos = entradas.filter((item) => !retornos.includes(item));
    const ordenados = [...abertos].sort((a, b) => prioridade(b) - prioridade(a));
    const delegados = [];
    const aprovacoes = [];
    const ignorados = retornos.map((item) => ({ id: item.id, motivo: "retorno_recebido" }));

    for (const item of ordenados) {
      // Oasis isolado: se o item é de emprego, nunca delega ao Oasis.
      const destino = await destinarComLlm(item);
      if (destino === "oasis" && EMPREGO_RE.test(`${item.assunto} ${item.corpo}`)) {
        quadro.atualizarStatus(item.id, "cancelado");
        quadro.postar({
          de: "chefe",
          para: "helison",
          tipo: "alerta",
          assunto: "Item de emprego bloqueado para Oasis",
          corpo: `O item ${item.id} misturava emprego com Oasis e foi cancelado. Oasis fica isolado.`,
          ref: item.id,
        });
        ignorados.push({ id: item.id, motivo: "oasis_isolado" });
        continue;
      }

      if (CRITICO_RE.test(`${item.assunto} ${item.corpo}`)) {
        quadro.atualizarStatus(item.id, "em_andamento");
        const pend = registrarPendencia(item, "Ação crítica: precisa da aprovação do Helison.");
        quadro.postar({
          de: "chefe",
          para: "helison",
          tipo: "alerta",
          assunto: `Aprovação necessária: ${item.assunto}`.slice(0, 160),
          corpo: `Item ${item.id} parece crítico (${pend.motivo}). Nada foi executado.`,
          ref: item.id,
        });
        aprovacoes.push({ id: item.id, pendencia: pend.id });
        // Despacho via orchestration/delegation quando houver bot (cartão).
        if (store && bot && typeof bot.queueApprovalCard === "function") {
          try {
            const conv = store.list().find((c) => c.title === "Chefe · aprovações") || store.create("Chefe · aprovações", "chefe");
            bot.queueApprovalCard?.(conv.id, {
              kind: "enviar",
              summary: `Chefe pede aprovação: ${item.assunto}`,
              detail: item.corpo,
              meta: { quadroId: item.id, pendenciaId: pend.id },
            });
          } catch { /* cartão opcional nesta leva */ }
        }
        continue;
      }

      // LEVA O2: não delega a agente pausado — deixa o item aberto e registra.
      if (state.agentesPausados[destino] === true) {
        ignorados.push({ id: item.id, motivo: "agente_pausado", destino });
        continue;
      }

      quadro.atualizarStatus(item.id, "em_andamento");
      const pedido = quadro.postar({
        de: "chefe",
        para: destino,
        tipo: "pedido",
        assunto: item.assunto,
        corpo: `Delegado pelo Chefe a partir de ${item.id}.\n\n${item.corpo}`,
        ref: item.id,
      });
      quadro.atualizarStatus(item.id, "feito");
      delegados.push({ origem: item.id, destino, pedido: pedido.id });

      // Despachante leve: marca uso no orchestration se disponível (sem inventar tokens).
      if (orchestration && typeof orchestration.bump === "function") {
        try { orchestration.bump("chefe", "consultas"); } catch { /* ok */ }
      }
    }

    state.ultimoCicloEm = nowIso();
    state.ciclos += 1;
    state.ultimoResumo = `Ciclo ${state.ciclos}: ${delegados.length} delegado(s), ${aprovacoes.length} aprovação(ões), ${ignorados.length} bloqueado(s). Itens lidos: ${ordenados.length}.`;
    persist();
    return {
      ok: true,
      lidos: ordenados.length,
      delegados,
      aprovacoes,
      ignorados,
      resumo: state.ultimoResumo,
      em: state.ultimoCicloEm,
    };
  }

  async function ordem(texto) {
    const clean = redact(String(texto || "").trim()).slice(0, 2000);
    if (clean.length < 3) throw fail("Escreva a ordem para o Chefe.");
    const item = quadro.postar({
      de: "helison",
      para: "chefe",
      tipo: "pedido",
      assunto: clean.slice(0, 80),
      corpo: clean,
    });
    // Uma ordem digitada no Chefe é uma execução operacional única. Quando há
    // runtime de agentes, ele vira o dono da execução; o ciclo legado não deve
    // delegar o mesmo pedido de novo e criar trabalho duplicado no quadro.
    // Papéis/missões nascem no startServer quando seedAssistants está ligado.
    const wasPaused = state.pausado;
    let tarefa = null;
    if (typeof runTask === "function") {
      quadro.atualizarStatus(item.id, "em_andamento");
      try { tarefa = await runTask(clean, { quadroId: item.id }); } catch (err) { tarefa = { error: redact(err.message || String(err)) }; }
      const out = {
        ok: true,
        modo: "operacional",
        lidos: 1,
        delegados: [],
        aprovacoes: [],
        ignorados: [],
        resumo: "Ordem entregue a uma única sessão operacional do Chefe.",
        em: nowIso(),
      };
      state.ultimoCicloEm = out.em;
      state.ciclos += 1;
      state.ultimoResumo = out.resumo;
      persist();
      return { item, ciclo: out, tarefa, pausado: wasPaused };
    }
    // Sem runtime (ex.: uso unitário/testes antigos), mantém o despachante do quadro.
    const out = await ciclo({ forcar: true });
    return { item, ciclo: out, tarefa, pausado: wasPaused };
  }

  function status() {
    const board = quadro.resumo();
    const pend = state.pendenciasAprovacao.filter((p) => p.estado === "pendente");
    const resultados = quadro.ler({ tipo: "resultado", limite: 5 });
    return {
      pausado: state.pausado,
      intervaloMin: state.intervaloMin,
      ultimoCicloEm: state.ultimoCicloEm,
      ultimoResumo: state.ultimoResumo,
      ciclos: state.ciclos,
      agentes: agentesView(),
      itensAbertos: board.abertos,
      porPara: board.porPara,
      ultimosResultados: resultados.map((r) => ({
        id: r.id,
        de: r.de,
        assunto: r.assunto,
        em: r.atualizadoEm || r.criadoEm,
      })),
      pendenciasAprovacao: pend.map((p) => ({
        id: p.id,
        quadroId: p.quadroId,
        motivo: p.motivo,
        criadoEm: p.criadoEm,
      })),
      // Nunca inventa números de tokens/custo aqui.
    };
  }

  function agenteStatus(ref) {
    const key = String(ref || "").trim().toLowerCase();
    if (key === "chefe") {
      return { id: "chefe", nome: "Chefe", papel: "Vice interno: prioriza, delega e pede aprovação", ...status() };
    }
    const found = agentesView().find((a) => a.id === key || a.nome.toLowerCase() === key);
    if (!found) throw fail("Agente não encontrado. Use vagas, pesquisa, oasis, portfolio ou chefe.", 404);
    const recentes = [
      ...quadro.ler({ para: found.id, limite: 5 }),
      ...quadro.ler({ de: found.id, limite: 5 }),
    ];
    return { ...found, recentes };
  }

  function setPausado(pausado) {
    state.pausado = Boolean(pausado);
    persist();
    return { pausado: state.pausado };
  }

  function setAgentePausado(ref, pausado) {
    const key = String(ref || "").trim().toLowerCase();
    if (!AGENTE_IDS.has(key)) throw fail("Agente não encontrado. Use vagas, pesquisa, oasis ou portfolio.", 404);
    if (pausado) state.agentesPausados[key] = true;
    else delete state.agentesPausados[key];
    persist();
    return agentesView().find((a) => a.id === key);
  }

  function resolverAprovacao(pendenciaId, decision) {
    const id = String(pendenciaId || "").trim();
    const pend = state.pendenciasAprovacao.find((p) => p.id === id && p.estado === "pendente");
    if (!pend) throw fail("Pendência de aprovação não encontrada.", 404);
    const ok = decision === "approve" || decision === "aprovar";
    const deny = decision === "deny" || decision === "negar";
    if (!ok && !deny) throw fail("Decisão inválida. Use approve ou deny.");
    pend.estado = ok ? "aprovada" : "negada";
    pend.decididoEm = nowIso();
    persist();
    try {
      if (pend.quadroId) {
        quadro.atualizarStatus(pend.quadroId, ok ? "em_andamento" : "cancelado");
        quadro.postar({
          de: "helison",
          para: "chefe",
          tipo: ok ? "pedido" : "alerta",
          assunto: ok ? `Aprovado: ${pend.quadroId}` : `Negado: ${pend.quadroId}`,
          corpo: ok
            ? `Helison aprovou a pendência ${pend.id}. Pode seguir com o item ${pend.quadroId}.`
            : `Helison negou a pendência ${pend.id}. Nada foi executado no item ${pend.quadroId}.`,
          ref: pend.quadroId,
        });
      }
    } catch { /* quadro opcional se item sumiu */ }
    if (ok) {
      Promise.resolve(ciclo({ forcar: true })).catch(() => {});
    }
    return { pendencia: { id: pend.id, estado: pend.estado, quadroId: pend.quadroId }, ok };
  }

  function setIntervaloMin(min) {
    const n = Number(min);
    if (!Number.isFinite(n)) throw fail("intervalo inválido");
    state.intervaloMin = Math.min(240, Math.max(5, Math.round(n)));
    persist();
    return { intervaloMin: state.intervaloMin };
  }

  /**
   * Resumo matinal: o que cada agente fez (últimas 24h), pendências e uso em %.
   * Só leitura do quadro/usage; nunca inventa números; nunca menciona $.
   */
  function resumoMatinal({ sinceMs = null, postar = true } = {}) {
    const since = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : Date.now() - 24 * 3600 * 1000;
    const linhas = ["Resumo matinal do Chefe", ""];
    const agentes = [];
    for (const a of agentesView()) {
      const feitos = [
        ...quadro.ler({ de: a.id, tipo: "resultado", limite: 30 }),
        ...quadro.ler({ de: a.id, tipo: "achado", limite: 30 }),
      ]
        .filter((item) => {
          const t = Date.parse(item.atualizadoEm || item.criadoEm || "");
          return Number.isFinite(t) && t >= since;
        })
        .sort((x, y) => String(y.atualizadoEm || y.criadoEm || "").localeCompare(String(x.atualizadoEm || x.criadoEm || "")));
      const pendencias = [
        ...quadro.ler({ para: a.id, status: "aberto", limite: 20 }),
        ...quadro.ler({ para: a.id, status: "em_andamento", limite: 20 }),
      ];
      const usoTxt = a.usoPct == null ? "sem dados" : `${a.usoPct}%`;
      const tokensTxt = a.tokensHoje != null && a.tokensHoje > 0 ? ` · ${a.tokensHoje} tokens` : "";
      const feitosTxt = feitos.length
        ? feitos.slice(0, 5).map((f) => `  - ${String(f.assunto || "").slice(0, 80)}`).join("\n")
        : "  - nada registrado nas últimas 24h";
      const pendTxt = pendencias.length
        ? pendencias.slice(0, 5).map((p) => `  - ${String(p.assunto || "").slice(0, 80)}`).join("\n")
        : "  - nenhuma";
      linhas.push(`${a.nome}${a.pausado ? " (pausado)" : ""} — uso ${usoTxt}${tokensTxt}`);
      linhas.push(`Feito:\n${feitosTxt}`);
      linhas.push(`Pendências:\n${pendTxt}`);
      linhas.push("");
      agentes.push({
        id: a.id,
        nome: a.nome,
        pausado: a.pausado,
        usoPct: a.usoPct,
        tokensHoje: a.tokensHoje,
        feitos: feitos.slice(0, 8).map((f) => ({ id: f.id, assunto: f.assunto, tipo: f.tipo, em: f.atualizadoEm || f.criadoEm })),
        pendencias: pendencias.slice(0, 8).map((p) => ({ id: p.id, assunto: p.assunto, status: p.status, tipo: p.tipo })),
      });
    }
    const pendChefe = state.pendenciasAprovacao.filter((p) => p.estado === "pendente");
    linhas.push(`Aprovações do Chefe pendentes: ${pendChefe.length}.`);
    const texto = linhas.join("\n").trim();
    let quadroId = null;
    if (postar) {
      const item = quadro.postar({
        de: "chefe",
        para: "helison",
        tipo: "resultado",
        assunto: "Resumo matinal",
        corpo: texto.slice(0, 4000),
      });
      quadroId = item.id;
    }
    state.ultimoResumoMatinal = { em: nowIso(), texto: texto.slice(0, 4000), quadroId };
    persist();
    return { ok: true, texto, agentes, pendenciasAprovacao: pendChefe.length, quadroId, em: state.ultimoResumoMatinal.em };
  }

  /** Instala rotina matinal (seg–sex 07:45, pausada). Só leitura / resumo. */
  function installResumoMatinal({ clock = "07:45", weekdays = [1, 2, 3, 4, 5] } = {}) {
    if (!routines || typeof routines.add !== "function") {
      throw fail("Rotinas não disponíveis neste contexto.");
    }
    const okClock = /^\d{2}:\d{2}$/.test(String(clock || "")) ? String(clock) : "07:45";
    const days = Array.isArray(weekdays) ? weekdays : [1, 2, 3, 4, 5];
    const existing = routines.list().find((r) => String(r.prompt || "").includes(CHEFE_RESUMO_MARK));
    if (existing) {
      return routines.update(existing.id, {
        enabled: existing.enabled,
        title: CHEFE_RESUMO_TITLE,
      }) || existing;
    }
    return routines.add({
      title: CHEFE_RESUMO_TITLE,
      prompt: `${CHEFE_RESUMO_MARK} Resumo do que cada agente fez, pendências e uso em % da conta. Só leitura.`,
      clock: okClock,
      weekdays: days,
      enabled: false,
      assistantId: "default",
    });
  }

  // Timer conservador (só se intervalo > 0 e não mock forçar off).
  let timer = null;
  function startLoop(ms) {
    stopLoop();
    const every = Number(ms);
    if (!Number.isFinite(every) || every <= 0) return;
    timer = setInterval(() => {
      Promise.resolve(ciclo()).catch(() => {});
    }, every);
    timer.unref?.();
  }
  function stopLoop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    AGENTES,
    seedPapeis,
    ciclo,
    ordem,
    status,
    agenteStatus,
    setPausado,
    setAgentePausado,
    resolverAprovacao,
    setIntervaloMin,
    resumoMatinal,
    installResumoMatinal,
    startLoop,
    stopLoop,
    state: () => ({ ...state, agentesPausados: { ...state.agentesPausados } }),
  };
}

module.exports = {
  createChefe,
  AGENTES,
  AGENTE_IDS,
  DEFAULT_INTERVAL_MIN,
  usoPctDe,
  scrubPii,
  CHEFE_RESUMO_MARK,
  CHEFE_RESUMO_TITLE,
};
