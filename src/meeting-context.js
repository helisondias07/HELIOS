"use strict";

const { unsafeReason, tokens } = require("../server/memory");

/**
 * Contexto da reunião para traduzir "passando o contexto":
 * glossário (arquivo editável), campo "Contexto da reunião", últimas falas e nível de formalidade.
 * Tudo curto e com teto de caracteres (configurável) para a tradução continuar rápida.
 * Texto com cara de segredo (chave, senha, e-mail) nunca entra no que vai ao modelo.
 */

const LIMITS = {
  context: 800,
  glossaryTerm: 60,
  glossaryMeaning: 120,
  glossaryEntries: 80,
  glossaryPerPrompt: 12,
  historyLine: 160,
};
const DEFAULT_MAX_CHARS = 1200;
const FORMALITY = ["neutro", "formal", "informal"];

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const oneLine = (text, max) => String(text || "").replace(/\s+/g, " ").trim().slice(0, max);

/** Devolve o motivo de recusa (pt-BR) ou "". Vale para o campo de contexto e para o glossário. */
function problem(text) {
  const reason = unsafeReason(text);
  return reason ? `O texto ${reason}. Segredos não vão para o modelo: tire isso do contexto.` : "";
}

/**
 * Lê o glossário em markdown. Aceita, uma por linha: `termo = tradução`, `termo -> tradução`,
 * `termo: tradução`, `termo | tradução` (com ou sem `-` no começo). Linhas com `#`, `>` ou `<!--` são notas.
 */
function parseGlossary(text) {
  const entries = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/^\s*[-*]\s+/, "").trim();
    if (!line || /^(#|>|<!--|-->)/.test(line)) continue;
    const match = line.match(/^(.{1,80}?)\s*(?:=>|->|=|\||:)\s*(.+)$/);
    if (!match) continue;
    const term = oneLine(match[1], LIMITS.glossaryTerm);
    const meaning = oneLine(match[2], LIMITS.glossaryMeaning);
    if (!term || !meaning) continue;
    if (unsafeReason(line) || unsafeReason(`${term} ${meaning}`)) {
      skipped += 1;
      continue;
    }
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ term, meaning });
    if (entries.length >= LIMITS.glossaryEntries) break;
  }
  return { entries, skipped };
}

const fold = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Só os termos que aparecem no texto (traduzir ou perguntar), para o prompt ficar curto. */
function relevantTerms(entries, haystack, max = LIMITS.glossaryPerPrompt) {
  const hay = fold(haystack);
  return entries.filter((entry) => hay.includes(fold(entry.term))).slice(0, max);
}

const FORMALITY_LINE = {
  neutro: "",
  formal: "Tom formal e profissional: frases completas, vocabulário corporativo, sem gírias.",
  informal: "Tom informal e natural, como colegas conversando: pode usar contrações e expressões leves, sem exagerar nas gírias.",
};

/**
 * Monta o bloco de contexto (texto) respeitando `maxChars`.
 * Prioridade: contexto da reunião (até 45%), glossário relevante (até 30%), falas anteriores (o resto, as mais novas primeiro).
 */
function buildBlock({ meetingContext = "", entries = [], haystack = "", history = [], maxChars = DEFAULT_MAX_CHARS } = {}) {
  const max = clampInt(maxChars, 300, 3000, DEFAULT_MAX_CHARS);
  const parts = [];
  let used = 0;
  const ctx = problem(meetingContext) ? "" : oneLine(meetingContext, Math.min(LIMITS.context, Math.floor(max * 0.45)));
  if (ctx) {
    const line = `Contexto da reunião: ${ctx}`;
    parts.push(line);
    used += line.length + 1;
  }
  const picked = relevantTerms(entries, haystack);
  if (picked.length) {
    const budget = Math.floor(max * 0.3);
    const items = [];
    let size = 40;
    for (const entry of picked) {
      const piece = `${entry.term} = ${entry.meaning}`;
      if (size + piece.length + 2 > budget && items.length) break;
      items.push(piece);
      size += piece.length + 2;
    }
    const line = `Glossário (use estes termos): ${items.join("; ")}`;
    parts.push(line);
    used += line.length + 1;
  }
  const older = [];
  const HISTORY_HEAD = "Falas anteriores (só para dar contexto, NÃO traduza):";
  let room = max - used - HISTORY_HEAD.length - 2;
  for (const text of (Array.isArray(history) ? history : []).slice().reverse()) {
    const clipped = oneLine(text, LIMITS.historyLine);
    if (!clipped || problem(clipped)) continue;
    if (clipped.length + 3 > room) break;
    older.unshift(`- ${clipped}`);
    room -= clipped.length + 3;
  }
  if (older.length) parts.push(`${HISTORY_HEAD}\n${older.join("\n")}`);
  return parts.join("\n").slice(0, max);
}

function formalityLine(value) {
  return FORMALITY_LINE[FORMALITY.includes(value) ? value : "neutro"];
}

/** Palavras-chave do contexto para a busca (sem artigos e preposições). */
function keywords(text, max = 6) {
  return [...new Set(tokens(text).filter((word) => word.length >= 4))].slice(0, max);
}

function termFromLine(text) {
  const words = oneLine(text, 300).split(" ").filter(Boolean);
  const caps = words.slice(1).filter((word) => /^[A-ZÀ-Ý][\p{L}\d-]{2,}$/u.test(word));
  if (caps.length) return [...new Set(caps)].slice(0, 3).join(" ");
  return words.filter((word) => word.replace(/[^\p{L}\d]/gu, "").length >= 6).sort((a, b) => b.length - a.length).slice(0, 3).join(" ");
}

/**
 * Monta a pesquisa do Google com o contexto da reunião. Só monta e oferece abrir no navegador:
 * nada é aberto sozinho. `term` vem da seleção; sem ela, usa a última fala.
 */
function buildSearch({ term = "", lastLine = "", meetingContext = "" } = {}) {
  const chosen = oneLine(term, 80) || termFromLine(lastLine);
  if (!chosen) throw Object.assign(new Error("Selecione um termo na transcrição (ou espere uma fala) para eu montar a pesquisa."), { status: 400 });
  const extra = problem(meetingContext) ? [] : keywords(meetingContext, 5);
  const query = oneLine([chosen, ...extra.filter((word) => !fold(chosen).includes(word))].join(" "), 200);
  const bad = problem(query);
  if (bad) throw Object.assign(new Error(bad), { status: 400 });
  return { query, url: `https://www.google.com/search?q=${encodeURIComponent(query)}`, term: chosen };
}

/** Confere a consulta recebida do renderer e devolve a URL do Google, ou lança. Nunca aceita URL pronta. */
function searchUrl(query) {
  const clean = oneLine(query, 200);
  if (!clean) throw new Error("Pesquisa vazia.");
  const bad = problem(clean);
  if (bad) throw new Error(bad);
  return `https://www.google.com/search?q=${encodeURIComponent(clean)}`;
}

module.exports = { LIMITS, DEFAULT_MAX_CHARS, FORMALITY, clampInt, problem, parseGlossary, relevantTerms, buildBlock, formalityLine, keywords, termFromLine, buildSearch, searchUrl };