"use strict";

const path = require("node:path");
const { newId, nowIso, readJson, writeJson, redact } = require("./util");

/**
 * Registro de fontes (source ledger). O relatório de um ajudante separa o que afirma em:
 *   - acordada: fonte primária, ou fontes que concordam;
 *   - contestada: fontes que divergem;
 *   - nao_verificada: sem fonte, ou só o ajudante afirma.
 * Cada afirmação leva a(s) fonte(s). Afirmações marcadas [IMPORTANTE] podem passar por um verificador
 * independente (quem verifica NÃO é quem achou), com estado confirmed / needs_validation / rejected.
 * Só texto curto e já passado por redact(): nunca senha, token ou chave.
 */
const CATEGORIES = { acordada: "acordada", contestada: "contestada", nao_verificada: "não verificada" };
const VERDICTS = ["confirmed", "needs_validation", "rejected"];
const ENTRY_MAX = 100;
const CLAIMS_MAX = 20;
const TEXT_MAX = 240;
const SOURCE_MAX = 200;
const SOURCES_PER_CLAIM = 3;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const fold = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const oneLine = (text, max) => redact(String(text ?? "").replace(/\s+/g, " ").trim()).slice(0, max);

// "ACORDADAS:", "Contestadas -", "NAO VERIFICADAS:" (com ou sem acento/plural), no começo da linha.
const HEADER = /^\s*(?:[#*_>\-\s]*)(acordadas?|contestadas?|n[aã]o[\s_-]*verificadas?|feito|achei|pendente)\s*(?:\(.*?\))?\s*[:：-]?\s*\**\s*(.*)$/i;
const ledgerKey = (word) => {
  const key = fold(word).replace(/[\s_-]+/g, "");
  if (key.startsWith("acord")) return "acordada";
  if (key.startsWith("contest")) return "contestada";
  if (key.startsWith("naoverif")) return "nao_verificada";
  return null; // feito / achei / pendente encerram a seção anterior
};
const EMPTY = /^(nada|nenhum[ao]?|n\/a|-+|—|sem afirma[cç][oõ]es)\.?$/i;

/**
 * Lê as seções ACORDADAS / CONTESTADAS / NAO VERIFICADAS de um relatório. Não inventa nada:
 * se o ajudante não separou as afirmações, o resultado é vazio.
 * Linha da afirmação: "- texto | fonte 1 | fonte 2" (marque [IMPORTANTE] no começo se for decisiva).
 * @returns {{claims:Array<{category:string,text:string,sources:string[],important:boolean}>, stripped:string}}
 */
function parseLedger(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const claims = [];
  const kept = [];
  let current = null;
  const push = (category, raw) => {
    let line = String(raw || "").replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
    if (!line || EMPTY.test(line)) return;
    const important = /\[\s*importante\s*\]/i.test(line);
    line = line.replace(/\[\s*importante\s*\]\s*/gi, "").trim();
    const [claim, ...rest] = line.split("|").map((part) => part.trim());
    const sources = rest.filter((part) => part && !/^(sem fonte|nenhuma|n\/a|-+)$/i.test(part));
    if (claim && claim.length >= 3) claims.push({ category, text: claim, sources, important });
  };
  for (const line of lines) {
    const match = line.match(HEADER);
    if (match && (ledgerKey(match[1]) || /^(feito|achei|pendente)$/i.test(fold(match[1])))) {
      const key = ledgerKey(match[1]);
      // "FEITO: ... ACHEI: ..." na mesma linha (modo demonstração) não é seção do registro.
      current = key;
      if (key) {
        if (match[2]) push(key, match[2]);
        continue;
      }
      kept.push(line);
      continue;
    }
    if (current) {
      if (!line.trim()) continue;
      push(current, line);
      continue;
    }
    kept.push(line);
  }
  return { claims, stripped: kept.join("\n").trim() };
}

function cleanClaim(raw, index, finderId) {
  const category = CATEGORIES[raw.category] ? raw.category : "nao_verificada";
  const sources = (Array.isArray(raw.sources) ? raw.sources : []).map((item) => oneLine(item, SOURCE_MAX)).filter(Boolean).slice(0, SOURCES_PER_CLAIM);
  const text = oneLine(raw.text, TEXT_MAX);
  // Sem fonte não existe "acordada" nem "contestada": cai para não verificada.
  const demoted = category !== "nao_verificada" && !sources.length;
  const important = Boolean(raw.important);
  return {
    id: String(raw.id || `af_${index + 1}`).slice(0, 20),
    text,
    category: demoted ? "nao_verificada" : category,
    demoted: demoted || Boolean(raw.demoted),
    sources,
    important,
    finderId: String(raw.finderId || finderId || "").slice(0, 60),
    verification: cleanVerification(raw.verification, important),
  };
}

function cleanVerification(raw, important) {
  if (raw && typeof raw === "object" && VERDICTS.includes(raw.state)) {
    return {
      state: raw.state,
      verifierId: raw.verifierId ? String(raw.verifierId).slice(0, 60) : null,
      note: oneLine(raw.note, 300),
      source: oneLine(raw.source, SOURCE_MAX),
      at: raw.at || null,
    };
  }
  return important ? { state: "needs_validation", verifierId: null, note: "", source: "", at: null } : null;
}

function createLedger(dataDir, { now = () => Date.now() } = {}) {
  const file = path.join(dataDir, "registro-fontes.json");
  const saved = readJson(file, { version: 1, entries: [] });
  const entries = (Array.isArray(saved.entries) ? saved.entries : [])
    .filter((item) => item && typeof item.id === "string" && Array.isArray(item.claims))
    .slice(-ENTRY_MAX)
    .map((item) => ({
      id: String(item.id).slice(0, 40),
      helperId: String(item.helperId || "").slice(0, 60),
      assistantId: String(item.assistantId || "default").slice(0, 40),
      assistantName: oneLine(item.assistantName || "HELIOS", 40),
      task: oneLine(item.task, 200),
      pergunta: oneLine(item.pergunta, 300),
      createdAt: item.createdAt || nowIso(),
      claims: item.claims.slice(0, CLAIMS_MAX).map((claim, index) => cleanClaim(claim || {}, index, item.helperId)).filter((claim) => claim.text),
    }));
  const save = () => writeJson(file, { version: 1, entries });

  const get = (id) => entries.find((item) => item.id === id || item.helperId === id) || null;

  function count(entry) {
    const out = { acordada: 0, contestada: 0, nao_verificada: 0, total: entry.claims.length, importantes: 0, verificacao: { confirmed: 0, needs_validation: 0, rejected: 0 } };
    for (const claim of entry.claims) {
      out[claim.category] += 1;
      if (claim.important) {
        out.importantes += 1;
        out.verificacao[claim.verification?.state || "needs_validation"] += 1;
      }
    }
    return out;
  }

  function view(entry, { claims = true } = {}) {
    return {
      id: entry.id,
      helperId: entry.helperId,
      assistantId: entry.assistantId,
      assistantName: entry.assistantName,
      task: entry.task,
      pergunta: entry.pergunta,
      createdAt: entry.createdAt,
      counts: count(entry),
      ...(claims ? { claims: entry.claims.map((claim) => ({ ...claim, categoryLabel: CATEGORIES[claim.category], sources: [...claim.sources], verification: claim.verification ? { ...claim.verification } : null })) } : {}),
    };
  }

  /**
   * Guarda o registro de um ajudante a partir do texto do relatório. Sem afirmações separadas, não guarda
   * nada (`entry: null`) e devolve o relatório sem o bloco do registro.
   */
  function record({ helperId, assistantId, assistantName, task, pergunta, text }) {
    const parsed = parseLedger(text);
    if (!parsed.claims.length) return { entry: null, stripped: parsed.stripped };
    const entry = {
      id: newId("reg"),
      helperId: String(helperId || ""),
      assistantId: String(assistantId || "default"),
      assistantName: oneLine(assistantName || "HELIOS", 40),
      task: oneLine(task, 200),
      pergunta: oneLine(pergunta, 300),
      createdAt: new Date(now()).toISOString(),
      claims: parsed.claims.slice(0, CLAIMS_MAX).map((claim, index) => cleanClaim(claim, index, helperId)).filter((claim) => claim.text),
    };
    entries.push(entry);
    if (entries.length > ENTRY_MAX) entries.splice(0, entries.length - ENTRY_MAX);
    save();
    return { entry: view(entry), stripped: parsed.stripped };
  }

  /**
   * Passo opcional de verificação independente. Só vale para afirmação marcada [IMPORTANTE], e o
   * verificador tem de ser DIFERENTE de quem achou. Estados: confirmed, needs_validation, rejected.
   */
  function verify(entryRef, claimId, { verifierId, state, note = "", source = "" } = {}) {
    const entry = get(String(entryRef || ""));
    if (!entry) throw fail("Não achei esse registro de fontes.", 404);
    const claim = entry.claims.find((item) => item.id === claimId);
    if (!claim) throw fail("Não achei essa afirmação no registro.", 404);
    if (!claim.important) throw fail("Só afirmações marcadas como importantes passam pelo verificador independente.");
    if (!VERDICTS.includes(state)) throw fail(`Estado inválido. Use: ${VERDICTS.join(", ")}.`);
    const who = String(verifierId || "").trim();
    if (!who) throw fail("Diga quem verificou (verifierId).");
    if (who === claim.finderId || who === entry.helperId) throw fail("O verificador precisa ser diferente de quem achou a afirmação.");
    claim.verification = { state, verifierId: who.slice(0, 60), note: oneLine(note, 300), source: oneLine(source, SOURCE_MAX), at: new Date(now()).toISOString() };
    save();
    return { entryId: entry.id, claim: view(entry).claims.find((item) => item.id === claim.id) };
  }

  const list = ({ assistantId, limit = 20 } = {}) => entries
    .filter((entry) => !assistantId || entry.assistantId === assistantId)
    .slice(-limit)
    .reverse()
    .map((entry) => view(entry, { claims: false }));

  /** Resumo curto para a interface (Atividade): contagens por categoria e das afirmações importantes. */
  const summaryFor = (helperId) => {
    const entry = entries.find((item) => item.helperId === helperId);
    return entry ? view(entry) : null;
  };

  return { record, verify, get: (id) => { const entry = get(id); return entry ? view(entry) : null; }, raw: get, list, summaryFor, file };
}

module.exports = { createLedger, parseLedger, CATEGORIES, VERDICTS };