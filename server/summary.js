"use strict";

const { redact } = require("./util");

const BATCH = 4;
const SUMMARY_MAX = 1200;

/** Mensagens de conversa (usuário e assistente já prontas), sem cartões nem perguntas. */
function chatMessages(messages) {
  return (messages || []).filter((message) => (message.role === "user" || (message.role === "assistant" && message.status !== "running")) && String(message.text || "").trim());
}

const textSize = (list) => list.reduce((sum, message) => sum + String(message.text || "").length, 0);

/**
 * Decide o que entra no contexto de uma nova sessão: resumo + últimas mensagens.
 * Só resume em lotes (BATCH), para não gastar uma chamada a cada mensagem.
 */
function planSummary({ messages, summary, keep, afterMessages, afterChars }) {
  const chat = chatMessages(messages);
  const triggered = chat.length > afterMessages || textSize(chat) > afterChars;
  const older = chat.slice(0, Math.max(0, chat.length - keep));
  const idx = summary ? chat.findIndex((message) => message.id === summary.upTo) : -1;
  const covered = summary && idx >= 0 ? idx + 1 : 0;
  const fresh = older.slice(covered);
  const update = triggered && fresh.length > 0 && (fresh.length >= BATCH || !summary);
  return {
    triggered,
    update,
    previous: summary && idx >= 0 ? summary.text : "",
    fresh,
    older,
    chat,
    // Sem atualizar, o que o resumo ainda não cobre continua como mensagem recente.
    recent: update ? chat.slice(older.length) : chat.slice(summary && idx >= 0 ? covered : Math.max(0, chat.length - keep)),
  };
}

/** Resumo sem modelo: uma linha por mensagem, cortada. Serve ao modo demonstração e de plano B. */
function extractiveSummary(previous, fresh, maxChars = SUMMARY_MAX) {
  const lines = String(previous || "").split("\n").map((line) => line.trim()).filter((line) => line && line !== "(…)");
  for (const message of fresh) {
    const who = message.role === "user" ? "Helison" : "HELIOS";
    lines.push(`- ${who}: ${redact(String(message.text || "")).replace(/\s+/g, " ").trim().slice(0, 140)}`);
  }
  let text = lines.join("\n");
  if (text.length > maxChars) {
    while (lines.length > 1 && lines.join("\n").length + 4 > maxChars) lines.shift();
    text = `(…)\n${lines.join("\n")}`.slice(0, maxChars);
  }
  return text;
}

function summaryPrompt(previous, fresh) {
  const body = fresh.map((message) => `${message.role === "user" ? "Helison" : "HELIOS"}: ${String(message.text || "").replace(/\s+/g, " ").slice(0, 600)}`).join("\n");
  return [
    "Atualize o resumo corrido desta conversa entre o Helison e o HELIOS. Português do Brasil.",
    `Máximo de ${SUMMARY_MAX} caracteres. Guarde decisões, pedidos em aberto, nomes, valores e prazos. Sem senhas, tokens ou chaves. Responda só com o resumo.`,
    previous ? `## Resumo atual\n${previous}` : "",
    `## Mensagens novas\n${body}`,
  ].filter(Boolean).join("\n\n");
}

module.exports = { planSummary, extractiveSummary, summaryPrompt, chatMessages, BATCH, SUMMARY_MAX };
