"use strict";

const crypto = require("node:crypto");
const { redact } = require("./util");

/**
 * O que o cartão de aprovação mostra, e a impressão digital do que vai ser executado.
 * Regra: o cartão e a execução saem da MESMA ação limpa. O que o Helison lê é o que roda.
 */

const SECRET_KEY = /(senha|password|passwd|secret|token|api[-_]?key|apikey|authorization|auth|cookie|credential|bearer|valor|private|session|pwd|chave|segredo|passphrase|(?:^|[_-])key$|accesskey|secretkey)/i;
const MAX_ARG_CHARS = 400;
const MAX_TOTAL_CHARS = 2400;
const MAX_BODY_CHARS = 700;

/** Cópia do valor com segredos mascarados (por nome de campo e por formato de chave). Só para exibição. */
function maskValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value);
  if (typeof value !== "object") return value;
  if (depth >= 5) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => maskValue(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    out[key] = SECRET_KEY.test(key) ? "[segredo]" : maskValue(item, depth + 1);
  }
  return out;
}

function clipText(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}… (+${value.length - max} caracteres)` : value;
}

function showValue(value) {
  const masked = maskValue(value);
  const text = typeof masked === "string" ? masked : JSON.stringify(masked);
  return clipText(text, MAX_ARG_CHARS);
}

/** JSON com chaves em ordem fixa, para a impressão digital não depender da ordem dos campos. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function digestOf(action) {
  return crypto.createHash("sha256").update(stableStringify(action)).digest("hex");
}

/** Texto do cartão (várias linhas) para uma ação já limpa por cleanAction. */
function describeAction(clean) {
  const lines = [];
  if (clean.mcp) {
    lines.push(`Conector: ${clean.mcp.server}.${clean.mcp.tool}`);
    const args = clean.mcp.args && typeof clean.mcp.args === "object" ? clean.mcp.args : {};
    const entries = Object.entries(args);
    if (!entries.length) lines.push("Argumentos: nenhum");
    else {
      lines.push("Argumentos:");
      let used = 0;
      for (const [key, value] of entries.slice(0, 20)) {
        const line = `  ${key}: ${showValue(SECRET_KEY.test(key) ? "[segredo]" : value)}`;
        used += line.length;
        if (used > MAX_TOTAL_CHARS) {
          lines.push("  … (mais argumentos não mostrados)");
          break;
        }
        lines.push(line);
      }
      if (entries.length > 20) lines.push(`  … (+${entries.length - 20} argumentos)`);
    }
    return lines.join("\n");
  }
  if (clean.tipo === "escrever") {
    lines.push(`Arquivo: ${clean.alvo}`);
    lines.push(`Conteúdo (${clean.conteudo.length} caracteres):`);
    lines.push(clipText(redact(clean.conteudo), MAX_BODY_CHARS) || "(vazio)");
    return lines.join("\n");
  }
  if (clean.tipo === "apagar") {
    lines.push(`Apagar: ${clean.alvo || "(sem caminho)"}`);
    lines.push("Apagar é permanente: não vai para a Lixeira.");
    if (clean.texto) lines.push(`Detalhe: ${clipText(redact(clean.texto), MAX_BODY_CHARS)}`);
    return lines.join("\n");
  }
  if (clean.tipo === "preencher") {
    lines.push(`Login: ${clean.alvo}`);
    lines.push("A senha será digitada na janela que estiver em foco quando você aprovar. Confira qual janela está em foco antes de aprovar.");
    return lines.join("\n");
  }
  if (clean.alvo) lines.push(`Alvo: ${clean.alvo}`);
  if (clean.texto) lines.push(`Texto: ${clipText(redact(clean.texto), MAX_BODY_CHARS)}`);
  if (clean.conteudo) lines.push(`Conteúdo (${clean.conteudo.length} caracteres): ${clipText(redact(clean.conteudo), MAX_BODY_CHARS)}`);
  return lines.join("\n");
}

module.exports = { describeAction, digestOf, stableStringify, maskValue, SECRET_KEY };