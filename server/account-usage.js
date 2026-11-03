"use strict";

/**
 * LEVA N + N2: uso por conta Cursor.
 * - N: acumulação do @cursor/sdk (tokens/custo) + limite manual opcional.
 * - N2: fonte real GetCurrentPeriodUsage (exchange API key); manual só como fallback.
 * Nunca inventamos percentual sem dado.
 */

const path = require("node:path");
const { readJson, writeJson, appendHeliosLog } = require("./util");
const { extractSdkUsage } = require("./sdk-usage");

const FILE = "account-usage.json";
const ME_TTL_MS = 15 * 60 * 1000;
const LIMITE_NAO_INFORMADO = "limite não informado pelo Cursor";
const CUSTO_NAO_INFORMADO = "custo não informado pelo SDK";
const FONTE_REAL = "real";
const FONTE_MANUAL = "manual";

function emptyUsed() {
  return {
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
    },
    costCents: null,
    costInformado: false,
    runs: 0,
  };
}

function cleanLimit(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind === "usd" || raw.kind === "tokens" ? raw.kind : null;
  const value = Number(raw.value);
  if (!kind || !Number.isFinite(value) || value <= 0) return null;
  return { kind, value: kind === "usd" ? Math.round(value * 100) / 100 : Math.round(value) };
}

function cleanPeriod(raw, nowMs) {
  const type = raw?.type === "monthly" ? "monthly" : "weekly";
  const d = new Date(nowMs);
  let resetDay;
  if (type === "monthly") {
    const n = Number(raw?.resetDay);
    resetDay = Number.isInteger(n) && n >= 1 && n <= 28 ? n : Math.min(28, Math.max(1, d.getDate()));
  } else {
    const n = Number(raw?.resetDay);
    resetDay = Number.isInteger(n) && n >= 0 && n <= 6 ? n : d.getDay();
  }
  return { type, resetDay };
}

/** Próximo instante de reset (local), a partir de `fromMs` (não inclusivo se for exatamente o reset). */
function nextResetAt(period, fromMs) {
  const d = new Date(fromMs);
  if (period.type === "monthly") {
    const day = period.resetDay;
    let y = d.getFullYear();
    let m = d.getMonth();
    const candidate = new Date(y, m, day, 0, 0, 0, 0);
    if (candidate.getTime() <= fromMs) {
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }
    return new Date(y, m, day, 0, 0, 0, 0).toISOString();
  }
  const target = period.resetDay;
  const cur = d.getDay();
  let add = (target - cur + 7) % 7;
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  if (add === 0 && midnight.getTime() <= fromMs) add = 7;
  if (add === 0) add = 7;
  const out = new Date(midnight.getTime() + add * 864e5);
  return out.toISOString();
}

function periodStartIso(period, nowMs) {
  const next = new Date(nextResetAt(period, nowMs)).getTime();
  if (period.type === "monthly") {
    const end = new Date(next);
    let y = end.getFullYear();
    let m = end.getMonth() - 1;
    if (m < 0) { m = 11; y -= 1; }
    return new Date(y, m, period.resetDay, 0, 0, 0, 0).toISOString();
  }
  return new Date(next - 7 * 864e5).toISOString();
}

function tokenTotal(tokens) {
  if (!tokens || typeof tokens !== "object") return 0;
  if (Number.isFinite(Number(tokens.totalTokens)) && Number(tokens.totalTokens) > 0) {
    return Math.round(Number(tokens.totalTokens));
  }
  return Math.max(0, Math.round(Number(tokens.inputTokens || 0) + Number(tokens.outputTokens || 0)));
}

function costFromExtracted(extracted) {
  if (!extracted?.costInformado || !extracted.cost) return null;
  const cents = extracted.cost.chargedCents ?? extracted.cost.rawCostCents;
  return Number.isFinite(Number(cents)) ? Number(cents) : null;
}

function createAccountUsage(dataDir, {
  now = () => Date.now(),
  meFetcher = null,
  cursorUsage = null, // { get(account, {force}), invalidate? } — fonte real (N2)
  log = () => {},
} = {}) {
  const file = path.join(dataDir, FILE);
  const saved = readJson(file, {});
  let autoSwitch = saved.autoSwitch === true;
  const byAccount = {};
  const switches = Array.isArray(saved.switches) ? saved.switches.slice(-50) : [];
  /** Visões reais em memória (sem tokens). accountId → view do createCursorUsage. */
  const realViews = new Map();

  if (saved && typeof saved.byAccount === "object" && saved.byAccount) {
    for (const [id, row] of Object.entries(saved.byAccount)) {
      if (!row || typeof row !== "object") continue;
      const period = cleanPeriod(row.period || { type: row.periodType, resetDay: row.resetDay }, now());
      byAccount[id] = {
        period,
        periodStart: typeof row.periodStart === "string" ? row.periodStart : periodStartIso(period, now()),
        nextResetAt: typeof row.nextResetAt === "string" ? row.nextResetAt : nextResetAt(period, now()),
        limit: cleanLimit(row.limit),
        used: {
          ...emptyUsed(),
          ...(row.used && typeof row.used === "object" ? row.used : {}),
          tokens: { ...emptyUsed().tokens, ...(row.used?.tokens || {}) },
        },
        me: row.me && typeof row.me === "object" ? row.me : null,
        lastRefreshAt: row.lastRefreshAt || null,
      };
    }
  }

  const persist = () => writeJson(file, { version: 1, autoSwitch, byAccount, switches: switches.slice(-50) });

  function ensure(accountId) {
    const id = String(accountId || "");
    if (!id) return null;
    if (!byAccount[id]) {
      const period = cleanPeriod({ type: "weekly" }, now());
      byAccount[id] = {
        period,
        periodStart: periodStartIso(period, now()),
        nextResetAt: nextResetAt(period, now()),
        limit: null,
        used: emptyUsed(),
        me: null,
        lastRefreshAt: null,
      };
    }
    return byAccount[id];
  }

  function rollIfNeeded(own) {
    if (!own) return;
    const t = now();
    if (new Date(own.nextResetAt).getTime() > t) return;
    own.used = emptyUsed();
    own.periodStart = own.nextResetAt;
    own.nextResetAt = nextResetAt(own.period, t);
  }

  function usedSnapshot(own) {
    const tokens = { ...(own.used.tokens || emptyUsed().tokens) };
    const total = tokenTotal(tokens);
    return {
      tokens,
      totalTokens: total || null,
      costCents: own.used.costInformado ? own.used.costCents : null,
      costInformado: Boolean(own.used.costInformado),
      costRotulo: own.used.costInformado ? null : CUSTO_NAO_INFORMADO,
      runs: own.used.runs || 0,
    };
  }

  function remainingOf(own) {
    const limit = own.limit;
    if (!limit) return null;
    const used = usedSnapshot(own);
    if (limit.kind === "tokens") {
      const u = used.totalTokens || 0;
      return { kind: "tokens", value: Math.max(0, limit.value - u), used: u, max: limit.value };
    }
    const cents = used.costInformado && used.costCents != null ? used.costCents : 0;
    const maxCents = Math.round(limit.value * 100);
    return { kind: "usd", value: Math.max(0, (maxCents - cents) / 100), usedCents: cents, max: limit.value };
  }

  function percentOf(own) {
    const rem = remainingOf(own);
    if (!rem || !rem.max) return null;
    if (rem.kind === "tokens") return Math.min(100, Math.round((rem.used / rem.max) * 100));
    const maxCents = Math.round(rem.max * 100);
    if (!maxCents) return null;
    return Math.min(100, Math.round((rem.usedCents / maxCents) * 100));
  }

  /**
   * LEVA N5: o Cursor às vezes devolve só % (auto/api/total) sem limit/includedSpend.
   * Isso ainda é barra válida (igual oasis usageModel: hasPools || hasSpend || percent).
   */
  function realHasBar(view) {
    if (!view || view.status !== "ok") return false;
    if (view.percent != null || view.includedPercent != null) return true;
    if (Number.isFinite(view.autoPercent) || Number.isFinite(view.apiPercent)) return true;
    const limit = Number(view.limitCents);
    if (!Number.isFinite(limit) || limit <= 0) return false;
    return view.remainingCents != null || view.usedCents != null;
  }

  /** Motivo curto e sanitizado para o card (sem segredos). */
  function shortUsageReason(view) {
    if (!view || typeof view !== "object") return "sem dados de uso";
    if (view.status === "no-account") return "sem chave de API nesta conta";
    if (view.status === "empty") return "Cursor não informou o uso";
    if (view.status === "auth") {
      const err = String(view.error || "");
      if (/\b401\b/.test(err) || /não aceitou a chave|chave recusada|sessão.*recusada/i.test(err)) return "chave recusada (401)";
      if (/\b403\b/.test(err)) return "chave recusada (403)";
      return "chave recusada — entre de novo";
    }
    const err = String(view.error || "");
    if (/sem conexão|tempo esgotado|TimeoutError|ENOTFOUND|ECONN/i.test(err)) return "sem conexão";
    const http = err.match(/\bHTTP\s+(\d{3})\b/i) || err.match(/\b(401|403|429|500|502|503)\b/);
    if (http) return `HTTP ${http[1]}`;
    if (/troca da chave|exchange/i.test(err)) return "falha na troca da chave";
    if (/resposta de uso inválida|parse/i.test(err)) return "resposta inválida";
    if (err) return err.replace(/Uso indisponível agora:\s*/i, "").slice(0, 80);
    if (view.status === "error" || view.status === "indisponivel") return "uso indisponível";
    return "";
  }

  function realSlice(view) {
    if (!view || typeof view !== "object") return null;
    return {
      status: view.status || "empty",
      percent: view.percent ?? null,
      autoPercent: view.autoPercent ?? null,
      apiPercent: view.apiPercent ?? null,
      usedCents: view.usedCents ?? null,
      limitCents: view.limitCents ?? null,
      remainingCents: view.remainingCents ?? null,
      onDemandCents: view.onDemandCents ?? null,
      cycleStart: view.cycleStart || null,
      cycleEnd: view.cycleEnd || null,
      includedPercent: view.includedPercent ?? null,
      error: typeof view.error === "string" ? view.error.slice(0, 200) : null,
      fetchedAt: view.fetchedAt || null,
    };
  }

  function exhausted(own, st = null) {
    if (st?.source === FONTE_REAL && st.remaining) return st.remaining.value <= 0;
    const rem = remainingOf(own);
    if (!rem) return false;
    return rem.value <= 0;
  }

  function status(accountId) {
    const own = ensure(accountId);
    if (!own) return null;
    rollIfNeeded(own);
    const used = usedSnapshot(own);
    const me = own.me
      ? {
        email: own.me.email || null,
        name: own.me.name || null,
        apiKeyName: own.me.apiKeyName || null,
        at: own.me.at || null,
      }
      : null;
    const real = realSlice(realViews.get(String(accountId)));

    // Fonte real com % e/ou limite → barra oficial; SDK fica só em used (secundário).
    if (real && realHasBar(real)) {
      const hasLimit = Number.isFinite(Number(real.limitCents)) && Number(real.limitCents) > 0;
      const limitCents = hasLimit ? Number(real.limitCents) : null;
      const usedCents = real.usedCents != null ? Number(real.usedCents) : null;
      const remainingCents = real.remainingCents != null
        ? Number(real.remainingCents)
        : (hasLimit && usedCents != null ? Math.max(0, limitCents - usedCents) : null);
      // LEVA N4 / oasis usageModel: max(auto, api) quando houver baldes; senão gasto/limite; senão percent.
      const hasPools = Number.isFinite(real.autoPercent) || Number.isFinite(real.apiPercent);
      let pctRaw = null;
      if (hasPools) {
        pctRaw = Math.max(
          Number.isFinite(real.autoPercent) ? real.autoPercent : 0,
          Number.isFinite(real.apiPercent) ? real.apiPercent : 0,
        );
      } else if (hasLimit && usedCents != null) {
        pctRaw = (usedCents / limitCents) * 100;
      } else if (real.percent != null) {
        pctRaw = real.percent;
      } else if (real.includedPercent != null) {
        pctRaw = real.includedPercent;
      }
      const percent = pctRaw == null ? null : Math.min(100, Math.round(pctRaw));
      const limitUsd = hasLimit ? Math.round((limitCents / 100) * 100) / 100 : null;
      const exhaustedReal = remainingCents != null
        ? remainingCents <= 0
        : (percent != null && percent >= 100);
      return {
        accountId: String(accountId),
        source: FONTE_REAL,
        period: { ...own.period, start: own.periodStart, nextResetAt: real.cycleEnd || own.nextResetAt },
        nextResetAt: real.cycleEnd || own.nextResetAt,
        limit: hasLimit ? { kind: "usd", value: limitUsd } : null,
        limiteRotulo: null,
        used,
        remaining: hasLimit && remainingCents != null
          ? { kind: "usd", value: Math.max(0, remainingCents / 100), usedCents: usedCents ?? 0, max: limitUsd }
          : null,
        percent,
        showBar: percent !== null,
        indeterminate: percent === null,
        exhausted: exhaustedReal,
        pools: {
          autoPercent: real.autoPercent,
          apiPercent: real.apiPercent,
        },
        real,
        reason: null,
        manualLimit: own.limit,
        me,
        lastRefreshAt: own.lastRefreshAt || real.fetchedAt,
      };
    }

    // Fallback: limite manual (quando real falhou/vazia/ausente).
    const limit = own.limit;
    const rem = remainingOf(own);
    const percent = percentOf(own);
    let source = FONTE_MANUAL;
    let realStatus = real?.status || null;
    if (!limit) {
      if (realStatus === "auth") source = "auth";
      else if (realStatus === "error" || realStatus === "indisponivel") source = "indisponivel";
      else if (realStatus === "no-account") source = "none";
      else source = "none";
    } else {
      source = FONTE_MANUAL;
    }
    // Motivo curto só após tentativa real; sem consulta ainda → rótulo clássico.
    const reason = (!limit && real) ? shortUsageReason(real) : null;
    return {
      accountId: String(accountId),
      source,
      period: { ...own.period, start: own.periodStart, nextResetAt: own.nextResetAt },
      nextResetAt: own.nextResetAt,
      limit,
      limiteRotulo: limit ? null : (reason || real?.error || LIMITE_NAO_INFORMADO),
      used,
      remaining: rem,
      percent,
      showBar: percent !== null,
      indeterminate: percent === null,
      exhausted: exhausted(own),
      pools: null,
      real,
      reason,
      manualLimit: own.limit,
      me,
      lastRefreshAt: own.lastRefreshAt,
    };
  }

  /** Normaliza AgentUsage { usage, cost } ou TokenUsage (+ cost) para extractSdkUsage. */
  function normalizeRaw(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.usage && typeof raw.usage === "object") {
      return { ...raw.usage, cost: raw.cost || raw.usage.cost };
    }
    return raw;
  }

  /** Acumula o que o SDK informou nesta chamada/agente. Nunca inventa tokens nem custo. */
  function record(accountId, rawUsage) {
    const own = ensure(accountId);
    if (!own) return null;
    rollIfNeeded(own);
    const extracted = extractSdkUsage(normalizeRaw(rawUsage));
    const tokensSrc = extracted.tokens || {};
    for (const key of Object.keys(own.used.tokens)) {
      const n = Number(tokensSrc[key]);
      if (Number.isFinite(n) && n > 0) own.used.tokens[key] = (own.used.tokens[key] || 0) + Math.round(n);
    }
    if (!own.used.tokens.totalTokens) {
      const add = tokenTotal(tokensSrc);
      if (add) own.used.tokens.totalTokens = add;
    }
    const cents = costFromExtracted(extracted);
    if (cents != null) {
      own.used.costInformado = true;
      own.used.costCents = (own.used.costCents || 0) + cents;
    }
    own.used.runs += 1;
    persist();
    return status(accountId);
  }

  function setLimit(accountId, patch) {
    const own = ensure(accountId);
    if (!own) throw Object.assign(new Error("conta não encontrada"), { status: 404 });
    if (patch === null || patch?.clear === true || patch?.limite === null) {
      own.limit = null;
    } else {
      const limit = cleanLimit(patch.limit || patch);
      if (!limit && patch.kind) {
        throw Object.assign(new Error("Informe kind (usd ou tokens) e um valor maior que zero."), { status: 400 });
      }
      own.limit = limit;
    }
    persist();
    return status(accountId);
  }

  function setPeriod(accountId, patch) {
    const own = ensure(accountId);
    if (!own) throw Object.assign(new Error("conta não encontrada"), { status: 404 });
    const period = cleanPeriod({ type: patch?.type || patch?.period, resetDay: patch?.resetDay }, now());
    own.period = period;
    own.periodStart = periodStartIso(period, now());
    own.nextResetAt = nextResetAt(period, now());
    persist();
    return status(accountId);
  }

  function setAutoSwitch(enabled) {
    autoSwitch = Boolean(enabled);
    persist();
    return { autoSwitch };
  }

  function getAutoSwitch() {
    return autoSwitch;
  }

  /**
   * Score de restante: maior = mais restante.
   * Prefere remainingCents da fonte real; senão limite manual; sem dado = -1.
   */
  function remainingScore(st) {
    if (!st) return -1;
    if (st.source === FONTE_REAL && st.real?.remainingCents != null && Number.isFinite(Number(st.real.remainingCents))) {
      return Number(st.real.remainingCents);
    }
    if (st.remaining && st.limit) {
      if (st.remaining.kind === "tokens") return st.remaining.value;
      return st.remaining.value * 100; // cents
    }
    // LEVA N5: só % (sem centavos) — menor uso = mais restante.
    if (st.source === FONTE_REAL && st.percent != null && Number.isFinite(Number(st.percent))) {
      return (100 - Number(st.percent)) * 100;
    }
    return -1;
  }

  function decorateList(accounts) {
    const rows = (accounts || []).map((account) => {
      const cursorUsage = status(account.id);
      return { ...account, cursorUsage };
    });
    const ranked = rows.filter((r) => remainingScore(r.cursorUsage) >= 0);
    let bestId = null;
    if (ranked.length) {
      bestId = ranked.slice().sort((a, b) => remainingScore(b.cursorUsage) - remainingScore(a.cursorUsage))[0]?.id || null;
    }
    const active = rows.find((r) => r.active) || null;
    const ordered = rows.slice().sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (b.active && !a.active) return 1;
      const sa = remainingScore(a.cursorUsage);
      const sb = remainingScore(b.cursorUsage);
      if (sa < 0 && sb < 0) return 0;
      if (sa < 0) return 1;
      if (sb < 0) return -1;
      return sb - sa;
    });
    // Ativa sempre no topo (visível); demais por restante.
    if (active) {
      const rest = ordered.filter((r) => r.id !== active.id);
      return {
        accounts: [active, ...rest],
        maisRestanteId: bestId,
        autoSwitch,
        limiteNota: LIMITE_NAO_INFORMADO,
      };
    }
    return { accounts: ordered, maisRestanteId: bestId, autoSwitch, limiteNota: LIMITE_NAO_INFORMADO };
  }

  async function refreshReal(accountId, apiKey, { force = false } = {}) {
    if (!cursorUsage || typeof cursorUsage.get !== "function" || !apiKey) return null;
    try {
      const view = await cursorUsage.get({ id: accountId, apiKey }, { force: Boolean(force) });
      realViews.set(String(accountId), view);
      return view;
    } catch (err) {
      const view = { status: "error", error: String(err?.message || err).slice(0, 200), fetchedAt: new Date(now()).toISOString() };
      realViews.set(String(accountId), view);
      return view;
    }
  }

  async function refreshMe(accountId, apiKey, { force = false } = {}) {
    const own = ensure(accountId);
    if (!own || !apiKey) return status(accountId);
    await refreshReal(accountId, apiKey, { force });
    if (typeof meFetcher === "function") {
      const stale = own.me?.at && (now() - new Date(own.me.at).getTime()) < ME_TTL_MS;
      if (!(stale && own.me)) {
        try {
          const me = await meFetcher(apiKey);
          const first = String(me?.userFirstName || "").trim();
          const last = String(me?.userLastName || "").trim();
          const name = [first, last].filter(Boolean).join(" ") || null;
          own.me = {
            email: me?.userEmail || null,
            name,
            apiKeyName: me?.apiKeyName || null,
            at: new Date(now()).toISOString(),
          };
        } catch {
          /* falha silenciosa: o Cursor.me pode falhar sem quebrar a tela */
        }
      }
    }
    own.lastRefreshAt = new Date(now()).toISOString();
    rollIfNeeded(own);
    persist();
    return status(accountId);
  }

  async function refreshAll(listWithKeys, { force = false } = {}) {
    const out = [];
    for (const item of listWithKeys || []) {
      if (!item?.id || !item.apiKey) continue;
      out.push(await refreshMe(item.id, item.apiKey, { force }));
    }
    return out;
  }

  function pickBestRemaining(accounts, excludeId) {
    const candidates = (accounts || []).filter((a) => a && a.apiKey && a.id !== excludeId);
    if (!candidates.length) return null;
    const scored = candidates.map((a) => {
      const st = status(a.id);
      return { account: a, st, score: remainingScore(st), exhausted: Boolean(st?.exhausted) };
    }).filter((x) => !x.exhausted);
    if (!scored.length) return null;
    scored.sort((a, b) => {
      if (a.score < 0 && b.score >= 0) return 1;
      if (b.score < 0 && a.score >= 0) return -1;
      return b.score - a.score;
    });
    return scored[0].account;
  }

  /**
   * Troca automática (opt-in). Motivo: limite manual atingido ou erro usage/429/quota.
   * Só entre contas com chave. Registra em switches + helios.log.
   */
  function tryAutoSwitch({ accountsApi, fromId, reason }) {
    if (!autoSwitch) return null;
    if (!accountsApi || typeof accountsApi.setActive !== "function") return null;
    const active = accountsApi.active?.();
    const from = fromId || active?.id;
    if (!from) return null;
    const snap = typeof accountsApi.snapshot === "function" ? accountsApi.snapshot() : null;
    const list = snap?.accounts || [];
    // snapshot não tem env; list() público sem chave — precisamos das chaves via active + snapshot
    const withKeys = list.filter((a) => a.apiKey);
    // incluir env se for a ativa
    if (active?.apiKey && !withKeys.some((a) => a.id === active.id)) {
      withKeys.push({ id: active.id, apiKey: active.apiKey, label: accountsApi.display?.(active) || active.label });
    }
    const pick = pickBestRemaining(withKeys, from);
    if (!pick || pick.id === from) return null;
    const before = accountsApi.display?.(accountsApi.active()) || from;
    accountsApi.setActive(pick.id);
    const after = accountsApi.display?.(pick) || pick.label || pick.id;
    const entry = {
      at: new Date(now()).toISOString(),
      fromId: from,
      toId: pick.id,
      fromLabel: before,
      toLabel: after,
      reason: String(reason || "limite").slice(0, 80),
    };
    switches.push(entry);
    persist();
    appendHeliosLog(dataDir, `[contas] auto-troca ${before} → ${after} (${entry.reason})`);
    log(`[contas] auto-troca: ${before} → ${after}`);
    return entry;
  }

  function recentSwitches(limit = 20) {
    return switches.slice(-limit).reverse();
  }

  /** Após registrar uso: se a ativa esgotou (real ou manual) e auto-troca ligada, troca. */
  function afterRecord(accountId, accountsApi) {
    const st = status(accountId);
    if (!st?.exhausted) return null;
    const reason = st.source === FONTE_REAL ? "limite/quota Cursor" : "limite manual";
    return tryAutoSwitch({ accountsApi, fromId: accountId, reason });
  }

  function setRealView(accountId, view) {
    if (!accountId) return;
    if (view == null) realViews.delete(String(accountId));
    else realViews.set(String(accountId), view);
  }

  return {
    record,
    status,
    setLimit,
    setPeriod,
    setAutoSwitch,
    getAutoSwitch,
    decorateList,
    refreshMe,
    refreshAll,
    refreshReal,
    tryAutoSwitch,
    afterRecord,
    recentSwitches,
    remainingScore,
    setRealView,
    nextResetAt,
    periodStartIso,
    cleanPeriod,
    cleanLimit,
    LIMITE_NAO_INFORMADO,
    CUSTO_NAO_INFORMADO,
    file,
    // testes
    _ensure: ensure,
    _rollIfNeeded: rollIfNeeded,
    _byAccount: byAccount,
    _realViews: realViews,
  };
}

module.exports = {
  createAccountUsage,
  nextResetAt,
  periodStartIso,
  cleanPeriod,
  cleanLimit,
  emptyUsed,
  tokenTotal,
  LIMITE_NAO_INFORMADO,
  CUSTO_NAO_INFORMADO,
  ME_TTL_MS,
};
