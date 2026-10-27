"use strict";

const path = require("node:path");
const { newId, nowIso, readJson, writeJson, redact } = require("./util");

/** Limites configuráveis. Padrões conservadores; cada um tem piso e teto. */
const LIMIT_SPECS = {
  maxSimultaneos: { def: 3, min: 1, max: 20, label: "Ajudantes ao mesmo tempo" },
  profundidade: { def: 1, min: 1, max: 2, label: "Profundidade de ajudantes (1 = ajudante não cria ajudante)" },
  ajudantesPorConversa: { def: 10, min: 1, max: 100, label: "Ajudantes por conversa" },
  tempoAjudanteSeg: { def: 120, min: 10, max: 900, label: "Tempo máximo por ajudante (segundos)" },
  consultasProfundidade: { def: 2, min: 1, max: 3, label: "Consultas encadeadas entre assistentes" },
  assistentesCriadosPorBots: { def: 5, min: 0, max: 20, label: "Assistentes criados por bots" },
  resumoAposMensagens: { def: 24, min: 6, max: 200, label: "Resumir a conversa depois de (mensagens)" },
  resumoAposCaracteres: { def: 12000, min: 2000, max: 100000, label: "Resumir a conversa depois de (caracteres)" },
  aprovacaoExpiraMin: { def: 10, min: 1, max: 1440, label: "Validade dos pedidos de rotinas e ajudantes (minutos)" },
  usoGlobalChamadasDia: { def: 500, min: 0, max: 100000, label: "Teto global de chamadas ao modelo por dia, todos os assistentes e rotinas (0 = sem teto)" },
  rotinasMax: { def: 20, min: 1, max: 100, label: "Máximo de rotinas (ativas e pausadas)" },
  rotinaIntervaloMin: { def: 15, min: 1, max: 1440, label: "Intervalo mínimo de rotinas pedidas por assistentes (minutos)" },
  contextoMaxCaracteres: { def: 6000, min: 1000, max: 50000, label: "Contexto ativo de cada assistente (caracteres)" },
  verificadorIndependente: { def: 0, min: 0, max: 1, label: "Verificador independente de afirmações importantes (0 = desligado, 1 = ligado)" },
};

const REPORT_MAX = 1500;
const RECENT_MAX = 50;
const BUCKETS = ["conversas", "ajudantes", "consultas"];

const STATES = { running: "rodando", done: "concluído", error: "erro", stopped: "encerrado", timeout: "tempo esgotado", interrupted: "interrompido" };

function cleanLimits(input = {}, base = {}) {
  const out = { ...base };
  for (const [key, spec] of Object.entries(LIMIT_SPECS)) {
    if (input[key] === undefined) {
      if (out[key] === undefined) out[key] = spec.def;
      continue;
    }
    const value = Number(input[key]);
    if (!Number.isFinite(value)) throw Object.assign(new Error(`Valor inválido em “${spec.label}”.`), { status: 400 });
    out[key] = Math.min(spec.max, Math.max(spec.min, Math.round(value)));
  }
  return out;
}

function emptyStats() {
  return { ajudantesCriados: 0, consultas: 0, assistentesCriados: 0, execucoesComTokens: 0, tokens: { conversas: 0, ajudantes: 0, consultas: 0 } };
}

function numberOr0(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Limites, registro de ajudantes (ativos e recentes) e contadores.
 * Só o que é seguro guardar vai para o disco: tarefa e relatório curto, nunca senha.
 */
function createOrchestration(dataDir, { now = () => Date.now() } = {}) {
  const file = path.join(dataDir, "orquestracao.json");
  const saved = readJson(file, {});
  let limits;
  try {
    limits = cleanLimits(saved && typeof saved.limits === "object" && saved.limits ? saved.limits : {});
  } catch {
    limits = cleanLimits({});
  }
  const recent = (Array.isArray(saved.recent) ? saved.recent : []).filter((item) => item && typeof item.id === "string").slice(-RECENT_MAX)
    .map((item) => (item.state === STATES.running ? { ...item, state: STATES.interrupted, endedAt: item.endedAt || item.startedAt } : item));
  const stats = { total: emptyStats(), byAssistant: {} };
  if (saved.stats && typeof saved.stats === "object") {
    Object.assign(stats.total, emptyStats(), saved.stats.total || {});
    stats.total.tokens = { ...emptyStats().tokens, ...(saved.stats.total?.tokens || {}) };
    if (saved.stats.byAssistant && typeof saved.stats.byAssistant === "object") stats.byAssistant = saved.stats.byAssistant;
  }
  const active = new Map();
  const perConversation = new Map();

  function persist() {
    writeJson(file, { version: 1, limits, stats, recent: recent.slice(-RECENT_MAX) });
  }

  function statsFor(assistantId) {
    const key = String(assistantId || "default");
    if (!stats.byAssistant[key]) stats.byAssistant[key] = emptyStats();
    stats.byAssistant[key].tokens = { ...emptyStats().tokens, ...(stats.byAssistant[key].tokens || {}) };
    return stats.byAssistant[key];
  }

  function bump(assistantId, field) {
    statsFor(assistantId)[field] += 1;
    stats.total[field] += 1;
    persist();
  }

  /** Soma o uso de tokens quando o SDK informa. Sem número, nada é inventado. */
  function addUsage(assistantId, bucket, usage) {
    const total = numberOr0(usage && (usage.totalTokens ?? (Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0))));
    if (!BUCKETS.includes(bucket) || !total) return false;
    const own = statsFor(assistantId);
    own.tokens[bucket] += total;
    own.execucoesComTokens += 1;
    stats.total.tokens[bucket] += total;
    stats.total.execucoesComTokens += 1;
    persist();
    return true;
  }

  const activeCount = () => active.size;

  function toView(entry) {
    const end = entry.endedAt ? Date.parse(entry.endedAt) : now();
    return {
      id: entry.id,
      task: entry.task,
      assistantId: entry.assistantId,
      assistantName: entry.assistantName,
      depth: entry.depth,
      state: entry.state,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt || null,
      durationMs: Math.max(0, end - Date.parse(entry.startedAt)),
      summary: entry.summary || "",
      tools: entry.tools || [],
      active: entry.state === STATES.running,
    };
  }

  /**
   * Abre o registro de um ajudante, se couber nos limites. Quando não cabe,
   * devolve `error` em português para o agente repassar.
   */
  function start({ assistantId, assistantName, rootConvId, task, depth = 1, tools = [], cancel }) {
    if (depth > limits.profundidade) {
      return { error: limits.profundidade <= 1
        ? "Limite de profundidade: um ajudante não cria outros ajudantes. Faça a etapa você mesmo ou devolva o relatório ao assistente principal."
        : `Limite de profundidade (${limits.profundidade}): este ajudante já está no nível máximo e não cria outros.` };
    }
    if (active.size >= limits.maxSimultaneos) {
      return { error: `Já existem ${active.size} ajudantes ativos (limite: ${limits.maxSimultaneos}). Espere um terminar ou peça ao Helison para aumentar o limite na tela Atividade.` };
    }
    const used = perConversation.get(rootConvId) || 0;
    if (used >= limits.ajudantesPorConversa) {
      return { error: `Esta conversa já criou ${used} ajudantes (limite: ${limits.ajudantesPorConversa}). Resuma o que tem e siga sem criar outro.` };
    }
    perConversation.set(rootConvId, used + 1);
    const entry = {
      id: newId("ajd"),
      task: redact(String(task || "").replace(/\s+/g, " ").trim()).slice(0, 200),
      assistantId: String(assistantId || "default"),
      assistantName: String(assistantName || "HELIOS"),
      depth,
      state: STATES.running,
      startedAt: nowIso(),
      endedAt: null,
      summary: "",
      tools: tools.slice(0, 12),
      cancel: typeof cancel === "function" ? cancel : null,
      stopRequested: false,
    };
    active.set(entry.id, entry);
    bump(entry.assistantId, "ajudantesCriados");
    return { helper: entry };
  }

  function setCancel(id, cancel) {
    const entry = active.get(id);
    if (entry) entry.cancel = cancel;
  }

  function finish(id, state, summary = "") {
    const entry = active.get(id);
    if (!entry) return null;
    active.delete(id);
    entry.state = entry.stopRequested ? STATES.stopped : STATES[state] || state;
    entry.endedAt = nowIso();
    entry.summary = redact(String(summary || "")).replace(/\s+/g, " ").slice(0, 300);
    const stored = { ...entry };
    delete stored.cancel;
    recent.push(stored);
    if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
    persist();
    return toView(entry);
  }

  /** Botão "Encerrar": pede o cancelamento e marca como encerrado pelo Helison. */
  async function stop(id) {
    const entry = active.get(id);
    if (!entry) return false;
    entry.stopRequested = true;
    try {
      await entry.cancel?.();
    } catch {
      /* o ajudante termina de qualquer forma quando o tempo acabar */
    }
    return true;
  }

  function wasStopped(id) {
    return Boolean(active.get(id)?.stopRequested);
  }

  /** Ativos primeiro, depois os mais recentes. */
  function helpers() {
    const live = [...active.values()].map(toView).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    const done = [...recent].reverse().map(toView);
    return [...live, ...done];
  }

  function setLimits(patch) {
    limits = cleanLimits(patch && typeof patch === "object" ? patch : {}, limits);
    persist();
    return { ...limits };
  }

  function limitsView() {
    return Object.entries(LIMIT_SPECS).map(([key, spec]) => ({ key, label: spec.label, value: limits[key], default: spec.def, min: spec.min, max: spec.max }));
  }

  function statsView() {
    return JSON.parse(JSON.stringify(stats));
  }

  return {
    limits: () => ({ ...limits }),
    setLimits,
    limitsView,
    start,
    setCancel,
    finish,
    stop,
    wasStopped,
    helpers,
    activeCount,
    bump,
    addUsage,
    stats: statsView,
    statsFor: (id) => JSON.parse(JSON.stringify(statsFor(id))),
    file,
  };
}

module.exports = { createOrchestration, LIMIT_SPECS, REPORT_MAX, STATES, cleanLimits };
