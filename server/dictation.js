"use strict";

const { findSecret } = require("./secret-scan");

const STYLES = ["padrao", "cursor", "whatsapp", "email"];
const MAX_IN = 8000;

function parsePairs(text, max) {
  const out = [];
  for (const line of String(text || "").split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.includes("=") ? "=" : "";
    if (!sep) continue;
    const at = trimmed.indexOf(sep);
    const from = trimmed.slice(0, at).trim();
    const to = trimmed.slice(at + 1).trim();
    if (from.length < 2 || from.length > 80 || !to || to.length > 500) continue;
    if (findSecret(from) || findSecret(to)) continue;
    out.push({ from, to });
    if (out.length >= max) break;
  }
  return out;
}

function applyPairs(text, pairs) {
  let out = text;
  let fixes = 0;
  const sorted = [...pairs].sort((a, b) => b.from.length - a.from.length);
  for (const pair of sorted) {
    const escaped = pair.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(re, () => {
      fixes += 1;
      return pair.to;
    });
  }
  return { text: out, fixes };
}

function stripFillers(text) {
  let fixes = 0;
  let out = text.replace(/(?:^|[\s,.;:!?])(?:é{2,}|e{3,}|h+m+|a+h+n+|ã+h+n*|u+h+m*|hum+|ahn|ãhn|hmm|uhm)(?=$|[\s,.;:!?])/giu, (match) => {
    fixes += 1;
    return /^[\s,.;:!?]/.test(match) ? match[0] : "";
  });
  out = out.replace(/\s+n[eé](?=\s*[,.!?…]|$)/giu, () => {
    fixes += 1;
    return "";
  });
  out = out.replace(/(?<![\p{L}\p{N}])tipo(?=\s*[,])/giu, () => {
    fixes += 1;
    return "";
  });
  out = out.replace(/\btipo assim\b/giu, () => {
    fixes += 1;
    return "";
  });
  return { text: out, fixes };
}

function applyCorrections(text) {
  let fixes = 0;
  const re = /([^.;!?\n]{1,60}?)\s*,?\s+(?:na verdade|melhor dizendo|quer dizer|digo)\s+([^.;!?\n]{1,60})/giu;
  const out = text.replace(re, (_match, _before, after) => {
    fixes += 1;
    return after.trim();
  });
  return { text: out, fixes };
}

function tidy(text, style) {
  let t = text.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/([,.;:!?])(?=\S)/g, "$1 ").trim();
  if (style === "email") {
    t = t.replace(/\bvc\b/gi, "você").replace(/\bpra\b/gi, "para").replace(/\btá\b/gi, "está").replace(/\btbm\b/gi, "também");
  }
  t = t.replace(/(^|[.!?…]\s+)(\p{L})/gu, (_m, pre, ch) => pre + ch.toLocaleUpperCase("pt-BR"));
  if (t && !/[.!?…]$/.test(t) && (style !== "cursor" || (/\s/.test(t) && !/[`_]$/.test(t)))) t += ".";
  return t;
}

/** Limpa vícios de fala e aplica glossário/atalhos. Não chama rede. Não devolve o áudio. */
function cleanDictation(input, options = {}) {
  const style = STYLES.includes(options.style) ? options.style : "padrao";
  let text = String(input ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_IN);
  if (!text) return { text: "", fixes: 0, style };
  if (options.cleanup === false) return { text, fixes: 0, style };
  let fixes = 0;
  const corrected = applyCorrections(text);
  text = corrected.text;
  fixes += corrected.fixes;
  const filled = stripFillers(text);
  text = filled.text;
  fixes += filled.fixes;
  const snippets = applyPairs(text, parsePairs(options.snippets, 40));
  text = snippets.text;
  fixes += snippets.fixes;
  const glossary = applyPairs(text, parsePairs(options.glossary, 40));
  text = glossary.text;
  fixes += glossary.fixes;
  text = tidy(text, style);
  return { text, fixes, style };
}

module.exports = { cleanDictation, parsePairs, STYLES };
