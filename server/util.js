"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { scrubKnown } = require("./secret-values");

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

const MASK = "[segredo]";
const SECRET_WORDS = "senha|password|passwd|pwd|token|chave|key|secret|segredo|api[_-]?key|bearer";
/** Valores que são palavras comuns ou marcadores, não segredos. */
const NOT_SECRET = new Set([
  "none", "null", "nil", "undefined", "true", "false", "vazio", "vazia", "empty", "required", "optional", "opcional",
  "obrigatorio", "obrigatório", "obrigatoria", "obrigatória", "string", "number", "valor", "value", "sim", "nao", "não",
  "yes", "no", "de", "do", "da", "dos", "das", "para", "the", "a", "o", "e", "um", "uma", "and", "or", "ou", "mascarado",
  "masked", "oculto", "hidden", "redacted", "xxx", "todo"
]);
const KNOWN_TOKEN_RE = new RegExp([
  "\\b(?:sk-|gsk_|crsr_|key_|github_pat_|glpat-|figd_|AIza)[A-Za-z0-9_-]{8,}",
  "\\bgh[pousr]_[A-Za-z0-9]{16,}",
  "\\bxox[abposr]-[A-Za-z0-9-]{8,}",
  "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b",
  "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}(?:\\.[A-Za-z0-9_-]*)?",
  "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"
].join("|"), "g");
const AUTH_RE = /\b(authorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token|digest)\s+)?)([^\s"'`,;]{4,})/gi;
const BEARER_RE = /\b(bearer\s+)((?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{6,}|[A-Za-z0-9._~+/=-]{20,})/gi;
const KV_RE = new RegExp(
  `([A-Za-z0-9_-]*?)(${SECRET_WORDS})((?:[_-]?\\d+)?["']?)(\\s*[:=]\\s*|\\s+(?:é|is)\\s*:?\\s*)(?:(["'])((?:(?!\\5).){1,200})\\5|([^\\s"'\`,;]+))`,
  "gi"
);

function isPlaceholder(value) {
  const v = value.toLowerCase();
  return NOT_SECRET.has(v) || /^(\[segredo\]|\$|<|\{\{|\*+$|process\.env|os\.environ)/.test(v);
}

function maskKeyValue(match, prefix, word, head, sep, quote, quoted, bare) {
  // O nome precisa ser a palavra inteira, parte de snake_case/kebab-case ou camelCase ("apiKey"); "monkey" não.
  if (prefix && !/[_-]$/.test(prefix) && !(/[a-z0-9]$/.test(prefix) && /[A-Z]/.test(word[0]))) return match;
  const proseSep = /^\s+(?:é|is)/i.test(sep);
  if (quote) {
    if (isPlaceholder(quoted)) return match;
    return `${prefix}${word}${head}${sep}${quote}${MASK}${quote}`;
  }
  if (bare.startsWith(MASK)) return match;
  const core = bare.replace(/[.!?)\]}:]+$/, "");
  const tail = bare.slice(core.length);
  if (core.length < 3 || isPlaceholder(core)) return match;
  // Em frase ("a senha é X"), só mascara se X parece segredo: tem dígito, símbolo ou mistura de caixa.
  if (proseSep && !(/\d/.test(core) || /[^\p{L}\p{N}]/u.test(core) || /\p{Ll}\p{Lu}/u.test(core))) return match;
  return `${prefix}${word}${head}${sep}${MASK}${tail}`;
}

/** Tira chaves e campos de senha de texto que possa ir para log, chat ou ferramenta. */
function redact(text) {
  // Fase 3: valores secretos conhecidos (cofre, chaves, env/headers de conectores) caem primeiro, onde quer que estejam.
  return scrubKnown(String(text ?? ""))
    .replace(KNOWN_TOKEN_RE, MASK)
    .replace(/("(?:senha|password|token|apiKey|authorization|valor)"\s*:\s*")[^"]*/gi, `$1${MASK}`)
    .replace(AUTH_RE, (match, head, value) => (isPlaceholder(value) ? match : `${head}${MASK}`))
    .replace(BEARER_RE, `$1${MASK}`)
    .replace(KV_RE, maskKeyValue);
}
/** O IPC "api" só pode falar com /api/ do servidor local; nada de trocar o host ou sair do prefixo. */
function isLocalApiPath(pathname) {
  if (typeof pathname !== "string" || pathname.length > 2000) return false;
  if (!pathname.startsWith("/api/")) return false;
  if (/[\s\\@#]|\/\/|\.\./.test(pathname)) return false;
  try {
    return new URL(pathname, "http://127.0.0.1").host === "127.0.0.1";
  } catch {
    return false;
  }
}

/** Limites de tamanho da API local. */
const MAX_BODY_BYTES = 1_000_000;
const MAX_MESSAGE_CHARS = 20_000;

/** Diagnóstico local. No app instalado, dataDir é %APPDATA%\\HELIOS. Não grava URL de login nem segredo. */
function appendHeliosLog(dataDir, line) {
  if (!dataDir) return;
  try {
    const dir = path.join(dataDir, "logs");
    fs.mkdirSync(dir, { recursive: true });
    const text = redact(String(line ?? ""))
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/[\r\n]+/g, " ")
      .slice(0, 500);
    fs.appendFileSync(path.join(dir, "helios.log"), `${new Date().toISOString()} ${text}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* o diagnóstico não pode derrubar o login */
  }
}

module.exports = { newId, nowIso, readJson, writeJson, redact, appendHeliosLog, isLocalApiPath, MAX_BODY_BYTES, MAX_MESSAGE_CHARS };
