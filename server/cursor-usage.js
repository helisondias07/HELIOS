"use strict";

/**
 * LEVA N2: uso real do plano Cursor por conta (mesmo caminho do oasis-bot / @cursor/sdk).
 * 1) POST /auth/exchange_user_api_key → accessToken (cache em memória por sha256 da chave)
 * 2) POST /aiserver.v1.DashboardService/GetCurrentPeriodUsage (Connect JSON)
 * Tokens só em memória; nunca em log/disco. Sem dado = null (nunca inventa número).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");

const CURSOR_BACKEND_URL = String(process.env.CURSOR_BACKEND_URL || "https://api2.cursor.sh").replace(/\/+$/, "");
const USAGE_PATH = "/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const EXCHANGE_PATH = "/auth/exchange_user_api_key";

/** Fixture fictícia (centavos / % inventados) — só para HELIOS_MOCK_USAGE e testes. LEVA N4: 57/20. */
const SAMPLE_PERIOD = {
  billingCycleStart: "1793199600000",
  billingCycleEnd: "1795878000000", // 28/11/2026 15:00 UTC → 28/11 BRT
  planUsage: {
    totalSpend: 420,
    includedSpend: 420,
    bonusSpend: 0,
    remaining: 1580,
    limit: 2000,
    autoPercentUsed: 57,
    apiPercentUsed: 20,
    totalPercentUsed: 57,
  },
  spendLimitUsage: {
    totalSpend: 0,
    individualLimit: 10000,
    individualUsed: 0,
    individualRemaining: 10000,
    limitType: "user",
  },
  enabled: true,
  displayMessage: "You've used 30% of your usage limit",
  autoModelSelectedDisplayMessage: "You've used 21% of your included total usage",
};

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** int64 do Connect chega como string de ms; aceita também ISO. */
const isoDate = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  const d = Number.isFinite(n) && n > 0 ? new Date(n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Resposta do GetCurrentPeriodUsage → visão da barra. Nunca inventa percentual.
 */
function parseCurrentPeriodUsage(body) {
  const pu = body && typeof body === "object" && body.planUsage && typeof body.planUsage === "object" ? body.planUsage : {};
  const limit = num(pu.limit);
  const included = num(pu.includedSpend);
  const remaining = num(pu.remaining);
  let percent = num(pu.totalPercentUsed);
  let bucket = "total";
  const fromSpend = limit && limit > 0 && included !== null ? (included / limit) * 100 : null;
  if (fromSpend !== null && (percent === null || percent === 0 || (percent > 0 && round1(percent) === 0 && fromSpend > 0))) {
    percent = fromSpend;
    bucket = "included";
  }
  const sl = body?.spendLimitUsage && typeof body.spendLimitUsage === "object" ? body.spendLimitUsage : null;
  const onDemand = sl ? num(sl.individualUsed) ?? num(sl.totalSpend) : null;
  return {
    status: percent === null ? "empty" : "ok",
    bucket: percent === null ? "none" : bucket,
    percent: percent === null ? null : round1(Math.max(0, percent)),
    autoPercent: num(pu.autoPercentUsed) === null ? null : round1(num(pu.autoPercentUsed)),
    apiPercent: num(pu.apiPercentUsed) === null ? null : round1(num(pu.apiPercentUsed)),
    usedCents: included,
    limitCents: limit,
    remainingCents: remaining ?? (limit !== null && included !== null ? Math.max(0, limit - included) : null),
    onDemandCents: onDemand,
    cycleStart: isoDate(body?.billingCycleStart),
    cycleEnd: isoDate(body?.billingCycleEnd),
    includedPercent: limit && limit > 0 && included !== null ? round1(Math.max(0, (included / limit) * 100)) : null,
    autoBucketModels: Array.isArray(body?.autoBucketModels) ? body.autoBucketModels.filter((m) => typeof m === "string").slice(0, 60) : [],
    message: typeof body?.autoModelSelectedDisplayMessage === "string" && body.autoModelSelectedDisplayMessage
      ? body.autoModelSelectedDisplayMessage.slice(0, 200)
      : typeof body?.displayMessage === "string" ? body.displayMessage.slice(0, 200) : "",
  };
}

/** `exp` do JWT (ms) — só para saber quando trocar a chave de novo. */
function jwtExpiryMs(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

class UsageError extends Error {
  constructor(kind, message, status = 0) {
    super(message);
    this.kind = kind; // "auth" | "error"
    this.status = status;
  }
}

/**
 * Carrega fixture de HELIOS_MOCK_USAGE (path JSON, JSON inline, ou "1"/"true").
 * Formato: corpo GetCurrentPeriodUsage, ou { default, byKey: { "sufixo": body| { __status, error } } }.
 */
function normalizeMockFixture(parsed) {
  if (!parsed || typeof parsed !== "object") return { default: SAMPLE_PERIOD, byKey: {} };
  if (parsed.planUsage) return { default: parsed, byKey: parsed.byKey || {} };
  if (parsed.default || parsed.byKey) {
    return { default: parsed.default || SAMPLE_PERIOD, byKey: parsed.byKey || {} };
  }
  return { default: SAMPLE_PERIOD, byKey: {} };
}

function loadMockUsageFixture(envValue = process.env.HELIOS_MOCK_USAGE) {
  if (envValue == null || envValue === false || envValue === "") return null;
  if (typeof envValue === "object") return normalizeMockFixture(envValue);
  const raw = String(envValue).trim();
  if (!raw) return null;
  if (raw === "1" || /^true$/i.test(raw)) {
    return { default: SAMPLE_PERIOD, byKey: {} };
  }
  try {
    const text = fs.existsSync(raw) ? fs.readFileSync(raw, "utf8") : raw;
    return normalizeMockFixture(JSON.parse(text));
  } catch {
    return { default: SAMPLE_PERIOD, byKey: {} };
  }
}

function resolveMockBody(fixture, apiKey) {
  const key = String(apiKey || "");
  const map = fixture?.byKey && typeof fixture.byKey === "object" ? fixture.byKey : {};
  for (const [suffix, body] of Object.entries(map)) {
    if (suffix && key.includes(suffix)) return body;
  }
  return fixture?.default || SAMPLE_PERIOD;
}

function createMockCursorUsage(fixture, { now = () => Date.now() } = {}) {
  const fix = fixture || { default: SAMPLE_PERIOD, byKey: {} };
  return {
    async get(account) {
      if (!account?.apiKey) return { status: "no-account" };
      const raw = resolveMockBody(fix, account.apiKey);
      if (raw && typeof raw === "object" && raw.__status) {
        const status = ["auth", "error", "empty", "indisponivel"].includes(raw.__status) ? raw.__status : "error";
        return {
          status,
          error: typeof raw.error === "string" ? raw.error.slice(0, 200) : (status === "auth" ? "Entre de novo com o Cursor para ver o uso." : "Uso indisponível agora."),
          fetchedAt: new Date(now()).toISOString(),
        };
      }
      const view = parseCurrentPeriodUsage(raw);
      return { ...view, fetchedAt: new Date(now()).toISOString() };
    },
    invalidate() {},
  };
}

/**
 * @param {object} [o]
 * @param {typeof fetch} [o.fetchImpl]
 * @param {string} [o.baseUrl]
 * @param {() => number} [o.now]
 * @param {number} [o.ttlMs]
 * @param {number} [o.minForceMs]
 * @param {number} [o.timeoutMs]
 * @param {(line: string) => void} [o.log]
 */
function createCursorUsage({
  fetchImpl = (...a) => fetch(...a),
  baseUrl = CURSOR_BACKEND_URL,
  now = () => Date.now(),
  ttlMs = 25_000,
  minForceMs = 4_000,
  timeoutMs = 10_000,
  log = () => {},
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const tokens = new Map(); // sha256(apiKey) → { token, refreshAt }
  const results = new Map(); // accountId → { at, view }
  const inflight = new Map();

  const keyId = (apiKey) => crypto.createHash("sha256").update(String(apiKey)).digest("hex");
  const signal = () => (typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined);

  async function exchange(apiKey) {
    const id = keyId(apiKey);
    const hit = tokens.get(id);
    if (hit && now() < hit.refreshAt) return hit.token;
    let res;
    try {
      res = await fetchImpl(`${base}${EXCHANGE_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: "{}",
        signal: signal(),
      });
    } catch (err) {
      throw new UsageError("error", `sem conexão com o Cursor (${err?.name === "TimeoutError" ? "tempo esgotado" : err?.message || err})`);
    }
    if (res.status === 401 || res.status === 403) throw new UsageError("auth", `chave recusada (${res.status})`, res.status);
    if (!res.ok) throw new UsageError("error", `troca da chave falhou (HTTP ${res.status})`, res.status);
    const body = await res.json().catch(() => ({}));
    const token = typeof body?.accessToken === "string" ? body.accessToken : "";
    if (!token) throw new UsageError("error", "troca da chave não devolveu token");
    const exp = jwtExpiryMs(token);
    tokens.set(id, { token, refreshAt: exp ? Math.max(now() + 60_000, exp - 5 * 60_000) : now() + 30 * 60_000 });
    return token;
  }

  async function callUsage(token) {
    let res;
    try {
      res = await fetchImpl(`${base}${USAGE_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: "{}",
        signal: signal(),
      });
    } catch (err) {
      throw new UsageError("error", `sem conexão com o Cursor (${err?.name === "TimeoutError" ? "tempo esgotado" : err?.message || err})`);
    }
    if (res.status === 401 || res.status === 403) throw new UsageError("auth", `chave recusada (${res.status})`, res.status);
    if (!res.ok) throw new UsageError("error", `HTTP ${res.status}`, res.status);
    return res.json().catch(() => {
      throw new UsageError("error", "resposta de uso inválida");
    });
  }

  async function fetchView(account) {
    let token = await exchange(account.apiKey);
    let body;
    try {
      body = await callUsage(token);
    } catch (err) {
      if (err.kind !== "auth") throw err;
      tokens.delete(keyId(account.apiKey));
      token = await exchange(account.apiKey);
      body = await callUsage(token);
    }
    return parseCurrentPeriodUsage(body);
  }

  async function get(account, { force = false } = {}) {
    if (!account?.apiKey) return { status: "no-account" };
    const id = account.id || keyId(account.apiKey);
    const cached = results.get(id);
    const age = cached ? now() - cached.at : Infinity;
    if (cached && age < (force ? minForceMs : ttlMs)) return cached.view;
    if (inflight.has(id)) return inflight.get(id);
    const p = (async () => {
      let view;
      try {
        view = await fetchView(account);
      } catch (err) {
        const kind = err instanceof UsageError ? err.kind : "error";
        if (!(err instanceof UsageError)) log(`[uso] falha inesperada: ${err?.message || err}`);
        view = {
          status: kind,
          error: kind === "auth"
            ? String(err?.message || "chave recusada — entre de novo").slice(0, 200)
            : String(err?.message || "uso indisponível").slice(0, 200),
        };
      }
      view = { ...view, fetchedAt: new Date(now()).toISOString() };
      results.set(id, { at: now(), view });
      return view;
    })().finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }

  function invalidate(accountId = null) {
    if (accountId) results.delete(accountId);
    else results.clear();
  }

  return { get, invalidate };
}

module.exports = {
  createCursorUsage,
  createMockCursorUsage,
  loadMockUsageFixture,
  parseCurrentPeriodUsage,
  jwtExpiryMs,
  CURSOR_BACKEND_URL,
  USAGE_PATH,
  EXCHANGE_PATH,
  SAMPLE_PERIOD,
};
