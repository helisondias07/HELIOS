"use strict";

const path = require("node:path");
const { readJson, writeJson } = require("./util");

/**
 * Medidor de uso por assistente (higiene de chave e de gasto).
 *
 * O que é contado de verdade: mensagens, chamadas ao modelo, ajudantes, consultas, caracteres
 * enviados e recebidos e tempo de resposta. Tokens só entram quando o SDK os informa; sem esse dado
 * nada é inventado e a tela avisa que o uso é aproximado. Os números do dia zeram à meia-noite
 * (horário do app); o acumulado fica guardado.
 */

const ALERT_AT = 0.8;
const KINDS = { mensagem: "mensagens", ajudante: "ajudantes", consulta: "consultas", resumo: "resumos" };

const emptyUsage = () => ({ mensagens: 0, chamadas: 0, ajudantes: 0, consultas: 0, resumos: 0, caracteresEnviados: 0, caracteresRecebidos: 0, tempoMs: 0, tokens: 0, execucoesComTokens: 0 });

function int(value, max = 1e9) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.round(n)) : 0;
}

function cleanLimit(input = {}, base = {}) {
  const out = { chamadasPorDia: int(base.chamadasPorDia), tokensPorDia: int(base.tokensPorDia), bloquear: Boolean(base.bloquear) };
  for (const key of ["chamadasPorDia", "tokensPorDia"]) {
    if (input[key] === undefined) continue;
    const n = Number(input[key]);
    if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error("O limite precisa ser um número maior ou igual a zero (0 = sem limite)."), { status: 400 });
    out[key] = int(n, 1e9);
  }
  if (input.bloquear !== undefined) {
    if (typeof input.bloquear !== "boolean") throw Object.assign(new Error("\"bloquear\" precisa ser verdadeiro ou falso."), { status: 400 });
    out.bloquear = input.bloquear;
  }
  return out;
}

/**
 * Teto GLOBAL de chamadas ao modelo por dia, somando todos os assistentes e rotinas. É a rede de segurança contra gasto
 * descontrolado (rotina em laço, ajudantes em cadeia). Vale mesmo sem limite por assistente. 0 = sem teto.
 * O valor vem de Atividade › Limites (usoGlobalChamadasDia); aqui fica só o padrão.
 */
const DEFAULT_GLOBAL_CALLS = 500;

function createUsage(dataDir, { now = () => Date.now(), globalCallsPerDay = () => DEFAULT_GLOBAL_CALLS, activeAccountId = () => null } = {}) {
  const file = path.join(dataDir, "uso.json");
  const saved = readJson(file, {});
  const limits = {};
  const byAssistant = {};
  // Uso local por conta do Cursor (só o que passou pelo HELIOS), por dia. Guarda 14 dias.
  const byAccount = {};
  if (saved && typeof saved.byAccount === "object" && saved.byAccount) {
    for (const [id, value] of Object.entries(saved.byAccount)) {
      if (!value || typeof value !== "object" || typeof value.days !== "object" || !value.days) continue;
      const days = {};
      for (const [day, row] of Object.entries(value.days)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && row && typeof row === "object") days[day] = { chamadas: int(row.chamadas), tokens: int(row.tokens) };
      }
      byAccount[id] = { days };
    }
  }
  if (saved && typeof saved.limits === "object" && saved.limits) {
    for (const [id, value] of Object.entries(saved.limits)) limits[id] = cleanLimit({}, value || {});
  }
  if (saved && typeof saved.byAssistant === "object" && saved.byAssistant) {
    for (const [id, value] of Object.entries(saved.byAssistant)) {
      if (!value || typeof value !== "object") continue;
      byAssistant[id] = { day: String(value.day || ""), today: { ...emptyUsage(), ...(value.today || {}) }, total: { ...emptyUsage(), ...(value.total || {}) } };
    }
  }

  const dayKey = () => {
    const d = new Date(now());
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  function entry(id) {
    const key = String(id || "default");
    const today = dayKey();
    if (!byAssistant[key]) byAssistant[key] = { day: today, today: emptyUsage(), total: emptyUsage() };
    if (byAssistant[key].day !== today) {
      byAssistant[key].day = today;
      byAssistant[key].today = emptyUsage();
    }
    return byAssistant[key];
  }

  const persist = () => writeJson(file, { version: 1, limits, byAssistant, byAccount });

  const dayKeyOf = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  function countAccount(accountId, tokens) {
    const id = String(accountId || "");
    if (!id) return;
    const own = byAccount[id] || (byAccount[id] = { days: {} });
    const today = dayKey();
    const row = own.days[today] || (own.days[today] = { chamadas: 0, tokens: 0 });
    row.chamadas += 1;
    row.tokens += tokens;
    const keep = new Set();
    for (let i = 0; i < 14; i += 1) keep.add(dayKeyOf(now() - i * 864e5));
    for (const day of Object.keys(own.days)) if (!keep.has(day)) delete own.days[day];
  }

  /** Uso local de uma conta: hoje e nos últimos 7 dias (não é o limite semanal do Cursor/Grok). */
  function accountStatus(accountId) {
    const own = byAccount[String(accountId || "")];
    const sum = (count) => {
      const out = { chamadas: 0, tokens: 0 };
      for (let i = 0; i < count; i += 1) {
        const row = own && own.days[dayKeyOf(now() - i * 864e5)];
        if (row) { out.chamadas += row.chamadas; out.tokens += row.tokens; }
      }
      return out;
    };
    return { today: sum(1), week: sum(7) };
  }

  /** Registra uma chamada ao modelo. `usage` é o objeto do SDK (se houver); nada é estimado em tokens. */
  function record(assistantId, { kind = "mensagem", charsIn = 0, charsOut = 0, ms = 0, usage = null } = {}) {
    const own = entry(assistantId);
    const tokens = int(usage && (usage.totalTokens ?? (Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0))));
    for (const bucket of [own.today, own.total]) {
      bucket.chamadas += 1;
      if (KINDS[kind]) bucket[KINDS[kind]] += 1;
      bucket.caracteresEnviados += int(charsIn);
      bucket.caracteresRecebidos += int(charsOut);
      bucket.tempoMs += int(ms);
      if (tokens) {
        bucket.tokens += tokens;
        bucket.execucoesComTokens += 1;
      }
    }
    countAccount(activeAccountId(), tokens);
    persist();
    return status(assistantId);
  }

  /** Estado do assistente frente ao limite: ok, alerta (80%+) ou limite (100%+). */
  function status(assistantId) {
    const key = String(assistantId || "default");
    const own = entry(key);
    const limit = limits[key] || cleanLimit({});
    const parts = [];
    if (limit.chamadasPorDia) parts.push({ what: "chamadas", used: own.today.chamadas, max: limit.chamadasPorDia });
    if (limit.tokensPorDia) parts.push({ what: "tokens", used: own.today.tokens, max: limit.tokensPorDia });
    const worst = parts.reduce((best, part) => (!best || part.used / part.max > best.used / best.max ? part : best), null);
    const ratio = worst ? worst.used / worst.max : 0;
    const state = !worst ? "sem-limite" : ratio >= 1 ? "limite" : ratio >= ALERT_AT ? "alerta" : "ok";
    return {
      assistantId: key,
      today: { ...own.today },
      total: { ...own.total },
      limit: { ...limit },
      percent: worst ? Math.round(ratio * 100) : null,
      state,
      worst,
      blocked: state === "limite" && limit.bloquear,
    };
  }

  /** Chamadas ao modelo de hoje, somando todos os assistentes, contra o teto global. */
  function globalStatus() {
    const max = int(globalCallsPerDay());
    let used = 0;
    for (const key of Object.keys(byAssistant)) used += entry(key).today.chamadas;
    const percent = max > 0 ? Math.round((used / max) * 100) : null;
    return { used, max, percent, alert: percent !== null && percent >= ALERT_AT * 100, blocked: max > 0 && used >= max };
  }

  /** Chamado antes de gastar: devolve a mensagem de bloqueio (pt-BR) ou null. */
  function blockReason(assistantId, name = "") {
    const g = globalStatus();
    if (g.blocked) {
      return `O teto global de uso de hoje foi atingido (${g.used} de ${g.max} chamadas ao modelo, somando todos os assistentes e rotinas). Nada foi enviado ao modelo. Aumente o teto em Atividade › Limites, ou espere até amanhã.`;
    }
    const s = status(assistantId);
    if (!s.blocked) return null;
    return `O limite de uso de hoje${name ? ` do assistente ${name}` : ""} foi atingido (${s.worst.used} de ${s.worst.max} ${s.worst.what}). Nada foi enviado ao modelo. Aumente o limite em Atividade › Painel de uso, ou espere até amanhã.`;
  }

  function setLimit(assistantId, patch) {
    const key = String(assistantId || "default");
    limits[key] = cleanLimit(patch && typeof patch === "object" ? patch : {}, limits[key] || {});
    persist();
    return status(key);
  }

  function list(ids = []) {
    const all = new Set([...ids.map(String), ...Object.keys(byAssistant)]);
    return [...all].map(status);
  }

  return { record, status, accountStatus, blockReason, globalStatus, setLimit, list, ALERT_AT, file };
}

const NOTE = "Uso aproximado: conta mensagens, chamadas ao modelo, caracteres e tempo. Tokens só aparecem quando o SDK informa (o modo demonstração nunca informa). Não é fatura: confira o gasto real no painel do provedor.";

module.exports = { createUsage, cleanLimit, NOTE, ALERT_AT, DEFAULT_GLOBAL_CALLS };