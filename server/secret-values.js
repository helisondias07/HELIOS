"use strict";

/**
 * Valores secretos conhecidos do HELIOS (senhas e tokens do cofre, chaves, env/headers de conectores).
 * Ficam só em memória e só servem para uma coisa: se um deles aparecer, por qualquer caminho, dentro de um texto que
 * vai para o modelo, o histórico, um log, um cartão ou a resposta de uma ferramenta, o redact() troca o valor por [segredo].
 * Nada aqui é gravado em disco nem devolvido: só existe `scrubKnown`.
 */
const MASK = "[segredo]";
const MIN_LENGTH = 6;
const sources = new Map();
let flat = [];

function variantsOf(value) {
  const out = new Set([value]);
  try { out.add(JSON.stringify(value).slice(1, -1)); } catch { /* sem variante JSON */ }
  try { out.add(encodeURIComponent(value)); } catch { /* sem variante de URL */ }
  return [...out].filter((item) => item.length >= MIN_LENGTH);
}

function rebuild() {
  const all = new Set();
  for (const list of sources.values()) for (const value of list) all.add(value);
  flat = [...all].sort((a, b) => b.length - a.length);
}

/** Troca a lista de valores de uma origem ("vault:...", "mcp:...", "env"). Valor curto demais ou vazio é ignorado. */
function setSecretValues(source, values) {
  const list = [];
  for (const raw of Array.isArray(values) ? values : []) {
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const value = String(raw).trim();
    if (value.length < MIN_LENGTH) continue;
    list.push(...variantsOf(value));
  }
  if (list.length) sources.set(String(source), list);
  else sources.delete(String(source));
  rebuild();
}

function clearSecretValues(source) {
  if (source === undefined) sources.clear();
  else sources.delete(String(source));
  rebuild();
}

/** Quantos valores secretos estão registrados (só para teste e diagnóstico; nunca os valores). */
function knownSecretCount() {
  return flat.length;
}

/** Texto com todo valor secreto conhecido trocado por [segredo]. */
function scrubKnown(text) {
  let out = String(text ?? "");
  if (!flat.length || !out) return out;
  for (const value of flat) {
    if (out.includes(value)) out = out.split(value).join(MASK);
  }
  return out;
}

module.exports = { setSecretValues, clearSecretValues, knownSecretCount, scrubKnown, MASK, MIN_LENGTH };
