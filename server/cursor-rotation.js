"use strict";

const { classifyAccountError } = require("./accounts");

/**
 * Repete o mesmo pedido na próxima conta do Cursor quando a atual bate
 * em limite de uso ou de taxa. O estado do pedido fica no argumento `run`,
 * não na conta. Nunca registra a chave.
 */
async function callRotating(accountsApi, run) {
  if (!accountsApi || typeof accountsApi.active !== "function" || typeof run !== "function") {
    throw new Error("Rotação de conta indisponível.");
  }
  const tried = new Set();
  let lastError = null;
  for (let step = 0; step < 3; step += 1) {
    const active = accountsApi.active();
    if (!active || !active.apiKey || tried.has(active.id)) break;
    tried.add(active.id);
    try {
      const result = await run(active);
      if (typeof accountsApi.noteOk === "function") accountsApi.noteOk(active.id);
      return { result, accountId: active.id, trocas: step };
    } catch (error) {
      lastError = error;
      const issue = classifyAccountError(error);
      if (!issue || (issue.kind !== "usage" && issue.kind !== "rate")) throw error;
      if (typeof accountsApi.noteIssue === "function") accountsApi.noteIssue(active.id, issue.kind);
      const next = typeof accountsApi.nextAccount === "function" ? accountsApi.nextAccount(active.id) : null;
      if (!next || !next.id || tried.has(next.id)) throw error;
      accountsApi.setActive(next.id);
    }
  }
  throw lastError || new Error("Nenhuma conta do Cursor disponível.");
}

module.exports = { callRotating };
