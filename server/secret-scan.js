"use strict";

const { redact } = require("./util");

const MASK = "[segredo]";
// Palavra longa com letras e números misturados (chave, token, hash): pode ser segredo mesmo sem rótulo.
const LONG_RE = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g;

/** Texto com tudo o que parece segredo trocado por [segredo]. Usa o redact() do HELIOS e a regra de palavra longa. */
function maskSecrets(text) {
  return redact(String(text ?? "")).replace(LONG_RE, MASK);
}

/** Motivo (em português) se o texto parece conter segredo; "" se parece limpo. */
function findSecret(text) {
  const value = String(text ?? "");
  if (!value) return "";
  return maskSecrets(value) !== value ? "parece conter senha, chave ou token" : "";
}

/**
 * Percorre um valor JSON e mascara todo texto com cara de segredo.
 * `found` recebe { campo, motivo } para cada texto alterado. Nunca devolve o segredo.
 */
function maskDeep(value, campo, found, depth = 0) {
  if (depth > 10) return null;
  if (typeof value === "string") {
    const reason = findSecret(value);
    if (!reason) return value;
    found.push({ campo, motivo: reason });
    return maskSecrets(value);
  }
  if (Array.isArray(value)) return value.map((item, index) => maskDeep(item, `${campo}[${index}]`, found, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = maskDeep(item, campo ? `${campo}.${key}` : key, found, depth + 1);
    return out;
  }
  return value;
}

/** Só detecta (não altera): lista os campos de texto que parecem segredo. */
function scanDeep(value, campo = "", found = [], depth = 0) {
  if (depth > 10) return found;
  if (typeof value === "string") {
    const reason = findSecret(value);
    if (reason) found.push({ campo, motivo: reason });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => scanDeep(item, `${campo}[${index}]`, found, depth + 1));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) scanDeep(item, campo ? `${campo}.${key}` : key, found, depth + 1);
  }
  return found;
}

module.exports = { maskSecrets, findSecret, maskDeep, scanDeep, MASK };