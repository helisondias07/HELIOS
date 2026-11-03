"use strict";

const TOKEN_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "reasoningTokens",
];

function pickTokens(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const tokens = {};
  for (const key of TOKEN_KEYS) {
    if (src[key] !== undefined && src[key] !== null && Number.isFinite(Number(src[key]))) {
      tokens[key] = Math.max(0, Math.round(Number(src[key])));
    }
  }
  if (!tokens.totalTokens && (tokens.inputTokens || tokens.outputTokens)) {
    tokens.totalTokens = (tokens.inputTokens || 0) + (tokens.outputTokens || 0);
  }
  return tokens;
}

function pickCost(raw) {
  const cost = raw?.cost;
  if (!cost || typeof cost !== "object") return null;
  const out = {};
  if (cost.rawCostCents !== undefined && Number.isFinite(Number(cost.rawCostCents))) {
    out.rawCostCents = Number(cost.rawCostCents);
  }
  if (cost.chargedCents !== undefined && Number.isFinite(Number(cost.chargedCents))) {
    out.chargedCents = Number(cost.chargedCents);
  }
  return Object.keys(out).length ? out : null;
}

/** Extrai só o que o SDK informou; nunca inventa números. */
function extractSdkUsage(raw) {
  const tokens = pickTokens(raw);
  const cost = pickCost(raw);
  if (!cost) {
    return {
      tokens,
      costInformado: false,
      rotulo: "custo não informado pelo SDK",
    };
  }
  return { tokens, cost, costInformado: true };
}

function formatUsageNote(extracted) {
  const data = extracted && typeof extracted === "object" ? extracted : extractSdkUsage(null);
  const t = data.tokens || {};
  const parts = [];
  if (t.totalTokens) parts.push(`${t.totalTokens} tokens`);
  else {
    const sum = (t.inputTokens || 0) + (t.outputTokens || 0);
    if (sum) parts.push(`${sum} tokens`);
  }
  if (t.cacheReadTokens) parts.push(`${t.cacheReadTokens} cache leitura`);
  if (t.reasoningTokens) parts.push(`${t.reasoningTokens} raciocínio`);
  if (data.costInformado && data.cost) {
    const cents = data.cost.chargedCents ?? data.cost.rawCostCents;
    if (cents !== undefined) parts.push(`custo ${(cents / 100).toFixed(2)}`);
  } else if (data.rotulo) parts.push(data.rotulo);
  return parts.length ? parts.join(" · ") : "uso não informado pelo SDK";
}

function recordFromAgent(usageApi, agent, { assistantId, accountId = null, accountUsage = null, accountsApi = null } = {}) {
  if (!usageApi || typeof usageApi.record !== "function") return null;
  let raw = null;
  if (agent && typeof agent.getUsage === "function") {
    try {
      raw = agent.getUsage();
    } catch {
      raw = null;
    }
  }
  const extracted = extractSdkUsage(raw?.usage ? { ...raw.usage, cost: raw.cost } : raw);
  const usagePayload =
    extracted.tokens && Object.keys(extracted.tokens).length
      ? {
          totalTokens: extracted.tokens.totalTokens,
          inputTokens: extracted.tokens.inputTokens,
          outputTokens: extracted.tokens.outputTokens,
          cacheReadTokens: extracted.tokens.cacheReadTokens,
          cacheWriteTokens: extracted.tokens.cacheWriteTokens,
          reasoningTokens: extracted.tokens.reasoningTokens,
        }
      : null;
  const result = usageApi.record(String(assistantId || "default"), { kind: "mensagem", usage: usagePayload });
  if (accountUsage && typeof accountUsage.record === "function" && accountId) {
    accountUsage.record(accountId, raw);
    if (accountsApi && typeof accountUsage.afterRecord === "function") accountUsage.afterRecord(accountId, accountsApi);
  }
  return result;
}

module.exports = { extractSdkUsage, formatUsageNote, recordFromAgent };
