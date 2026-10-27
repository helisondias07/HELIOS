"use strict";

const { redact } = require("./util");

/** Quem originou a conversa: uma rotina, o MCP local ou uma conversa comum. */
function originOf(conv) {
  if (conv.helper) return "ajudante";
  const title = String(conv.title || "");
  if (title.startsWith("Rotina:")) return "rotina";
  if (title === "Mensagem via MCP") return "mcp";
  return "conversa";
}

/** Rotina ou ajudante: ninguém está olhando a conversa. Vale para o pedido de aprovação sempre e para a validade dos cartões. */
function isAutomated(conv) {
  const origin = originOf(conv || {});
  return origin === "ajudante" || origin === "rotina";
}

/**
 * Junta, de todas as conversas (inclusive as de rotinas e do MCP), o que está
 * esperando o Helison: cartões de aprovação e perguntas. Mais novo primeiro.
 */
function buildInbox(store, { assistants, parking } = {}) {
  const items = [];
  const expired = [];
  for (const conv of store.list()) {
    const assistant = assistants ? assistants.resolve(conv.assistantId) : null;
    for (const message of conv.messages || []) {
      if (message.role === "approval" && message.state === "expired") {
        expired.push({
          id: message.id,
          kind: "approval",
          tipo: message.kind,
          summary: redact(message.summary),
          detail: redact(message.detail || ""),
          at: message.at,
          expiredAt: message.expiredAt || null,
          convId: conv.id,
          convTitle: conv.title,
          origin: originOf(conv),
          originLabel: conv.helper ? `ajudante de ${assistant ? assistant.name : "HELIOS"}` : "",
          assistantId: assistant ? assistant.id : (conv.assistantId || "default"),
          assistantName: assistant ? assistant.name : "HELIOS",
        });
        continue;
      }
      if (message.state !== "pending") continue;
      if (message.role !== "approval" && message.role !== "question") continue;
      const parked = message.role === "question" && message.parked && parking ? parking.get(message.parked) : null;
      items.push({
        id: message.id,
        kind: message.role === "question" ? "question" : "approval",
        tipo: message.role === "approval" ? message.kind : "pergunta",
        summary: redact(message.role === "approval" ? message.summary : message.question),
        detail: redact(message.detail || ""),
        options: message.role === "question" ? (message.options || []) : [],
        expiresAt: message.role === "approval" ? (message.expiresAt || null) : null,
        parked: parked
          ? { id: parked.id, objetivo: redact(parked.objetivo), feito: parked.feito.map(redact), falta: parked.falta.map(redact), motivo: parked.motivo, resumes: parked.resumes }
          : null,
        at: message.at,
        convId: conv.id,
        convTitle: conv.title,
        origin: originOf(conv),
        originLabel: conv.helper ? `ajudante de ${assistant ? assistant.name : "HELIOS"}` : "",
        assistantId: assistant ? assistant.id : (conv.assistantId || "default"),
        assistantName: assistant ? assistant.name : "HELIOS",
      });
    }
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  expired.sort((a, b) => String(b.expiredAt || b.at).localeCompare(String(a.expiredAt || a.at)));
  return { items, count: items.length, expired, expiredCount: expired.length };
}

module.exports = { buildInbox, originOf, isAutomated };
