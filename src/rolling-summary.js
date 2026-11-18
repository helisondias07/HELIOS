"use strict";

const { redact } = require("../server/util");

const ROLLING_MIN_UNCOVERED_CHARS = 1000;
const ROLLING_SUMMARY_MAX = 900;
const CHUNK_MAX_CHARS = 10000;

function formatSpeaker(who) {
  if (who === "me") return "Você";
  if (who === "them") return "Outro(s)";
  return "Voz misturada";
}

function formatLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .filter((l) => l && String(l.text || "").trim())
    .map((l) => `${formatSpeaker(l.who)}: ${redact(String(l.text).trim())}`);
}

function compactOlderLines(lines, maxChars = 700) {
  const rows = formatLines(lines);
  if (!rows.length) return "";
  const full = rows.join("\n");
  if (full.length <= maxChars) return full;
  const half = Math.max(120, Math.floor((maxChars - 24) / 2));
  return `${full.slice(0, half).trim()}\n[…]\n${full.slice(full.length - half).trim()}`.slice(0, maxChars);
}

function rollingSummaryPrompt(previousSummary, newLines) {
  const prev = redact(String(previousSummary || "").trim()).slice(0, ROLLING_SUMMARY_MAX);
  const block = formatLines(newLines).join("\n").slice(0, 8000);
  return [
    {
      role: "system",
      content: [
        "Comprima o histórico anterior de uma reunião em andamento em português do Brasil.",
        "Mantenha SOMENTE fatos, nomes, números, valores, requisitos, decisões e prazos explicitamente falados.",
        "Máximo de 6 tópicos curtos (até 800 caracteres no total). Nunca invente nem adicione suposições.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        prev ? `Resumo acumulado até aqui:\n"""\n${prev}\n"""` : "",
        `Novas falas que saíram da janela recente:\n"""\n${block}\n"""`,
        "Devolva apenas o resumo atualizado em tópicos curtos começando com \"- \".",
      ].filter(Boolean).join("\n\n"),
    },
  ];
}

function effectiveRollingSummary({ lines = [], recentLines = [], savedSummary = "", summarizedCount = 0 } = {}) {
  const all = Array.isArray(lines) ? lines : [];
  const recLen = Array.isArray(recentLines) ? recentLines.length : 0;
  const olderEnd = Math.max(0, all.length - recLen);
  if (olderEnd === 0) return "";
  const safeIdx = Math.min(olderEnd, Math.max(0, Number(summarizedCount) || 0));
  const uncovered = all.slice(safeIdx, olderEnd);
  const parts = [];
  if (savedSummary && String(savedSummary).trim()) {
    parts.push(redact(String(savedSummary).trim()).slice(0, ROLLING_SUMMARY_MAX));
  }
  if (uncovered.length) {
    const fallback = compactOlderLines(uncovered, parts.length ? 450 : 750);
    if (fallback) parts.push(fallback);
  }
  return parts.join("\n").slice(0, 1300);
}

async function advanceRollingState({ lines = [], recentCount = 0, savedSummary = "", summarizedCount = 0, chatFn } = {}) {
  const all = Array.isArray(lines) ? lines : [];
  const olderEnd = Math.max(0, all.length - Math.max(0, recentCount));
  const startIdx = Math.min(olderEnd, Math.max(0, Number(summarizedCount) || 0));
  const deltaLines = all.slice(startIdx, olderEnd);
  const deltaChars = deltaLines.reduce((sum, l) => sum + String((l && l.text) || "").length, 0);
  if (!chatFn || deltaChars < ROLLING_MIN_UNCOVERED_CHARS) {
    return { updated: false, summary: savedSummary || "", count: startIdx };
  }
  const r = await chatFn(rollingSummaryPrompt(savedSummary, deltaLines), { fast: true, maxTokens: 320 });
  const next = redact(String((r && r.text) || "").trim()).slice(0, ROLLING_SUMMARY_MAX);
  if (!next) return { updated: false, summary: savedSummary || "", count: startIdx };
  return { updated: true, summary: next, count: olderEnd };
}

function splitTranscriptChunks(lines, maxChunkChars = CHUNK_MAX_CHARS) {
  const rows = formatLines(lines);
  if (!rows.length) return [];
  const chunks = [];
  let current = [];
  let size = 0;
  for (const row of rows) {
    const clipped = row.slice(0, maxChunkChars);
    if (current.length && size + clipped.length + 1 > maxChunkChars) {
      chunks.push(current.join("\n"));
      current = [clipped];
      size = clipped.length;
    } else {
      current.push(clipped);
      size += clipped.length + (current.length > 1 ? 1 : 0);
    }
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

function chunkSummaryPrompt(chunkText, index, total, { title = "", objective = "", playbookHint = "" } = {}) {
  return [
    {
      role: "system",
      content: [
        `Extraia os fatos reais da parte ${index + 1} de ${total} da transcrição de uma reunião, em português do Brasil.`,
        "Liste apenas: temas discutidos, decisões combinadas, valores/números citados e pendências/próximos passos (com responsável e prazo SOMENTE se falados).",
        "Não invente nada. Máximo de 10 tópicos objetivos.",
        title ? `Título: ${String(title).slice(0, 120)}` : "",
        objective ? `Objetivo: ${String(objective).slice(0, 400)}` : "",
        playbookHint || "",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: `Parte ${index + 1}/${total}:\n"""\n${chunkText}\n"""`,
    },
  ];
}

module.exports = {
  ROLLING_MIN_UNCOVERED_CHARS,
  ROLLING_SUMMARY_MAX,
  CHUNK_MAX_CHARS,
  formatLines,
  compactOlderLines,
  rollingSummaryPrompt,
  effectiveRollingSummary,
  advanceRollingState,
  splitTranscriptChunks,
  chunkSummaryPrompt,
};
