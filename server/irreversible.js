"use strict";

const WORD = /(send|delete|remove|trash|destroy|drop|pay|purchase|transfer|publish|post_message|enviar|apagar|excluir|pagar|publicar)/i;

function isIrreversible(name, description = "") {
  return WORD.test(`${name || ""} ${description || ""}`);
}

const TIPOS = ["enviar", "apagar", "pagar", "publicar", "preencher", "escrever", "ler"];

function normalizeTipo(tipo) {
  const value = String(tipo || "").toLowerCase();
  if (TIPOS.includes(value)) return value;
  if (/preench/.test(value)) return "preencher";
  if (/apag|exclu|delet|remov/.test(value)) return "apagar";
  if (/pag/.test(value)) return "pagar";
  if (/public/.test(value)) return "publicar";
  if (/escrev|grav|writ|salvar|save/.test(value)) return "escrever";
  if (/^ler\b|leitura|pesquis|search|read/.test(value)) return "ler";
  return "enviar";
}

/**
 * Em que tipo de ação cai uma ferramenta de conector MCP, e se o HELIOS reconheceu a ferramenta.
 * Olha o nome primeiro; se só a descrição acusar algo irreversível, cai no tipo do nome (padrão: enviar).
 * FALHA FECHADA: só é "ler" (known: true) o que começa com um verbo de leitura conhecido.
 * Nome que não casa com nada conhecido devolve { tipo: "escrever", known: false, forceCard: true }: precisa de cartão, mesmo com Autonomia liberada.
 * `forceCard` também vale para verbos de executar código ou mexer em acesso (exec, shell, login, approve...).
 */
function classifyToolDetailed(name, description = "") {
  const original = String(name || "");
  const n = original.toLowerCase();
  // Verbos que executam código ou mexem em acesso/sessão: ficam com cartão mesmo que o tipo esteja liberado em Autonomia.
  const sensitive = nameTokens(original).some((token) => FORCE_CARD_VERBS.has(token));
  const known = (tipo) => ({ tipo, known: true, forceCard: sensitive || tipo === "pagar" });
  if (/(pay|purchase|transfer|checkout|pagar)/.test(n)) return known("pagar");
  if (/(delete|remove|trash|destroy|drop|apagar|excluir)/.test(n)) return known("apagar");
  if (/(publish|post_message|publicar)/.test(n)) return known("publicar");
  if (/(send|enviar)/.test(n)) return known("enviar");
  if (/(write|save|append|mkdir|upload|escrever|gravar|salvar)/.test(n)) return known("escrever");
  const byVerb = classifyByVerb(original);
  if (byVerb) return known(byVerb);
  if (isIrreversible(name, description)) return known(normalizeTipo(name));
  const first = nameTokens(original)[0];
  if (first && READ_VERBS.has(first)) return known("ler");
  return { tipo: "escrever", known: false, forceCard: true };
}

const FORCE_CARD_VERBS = new Set(["exec", "eval", "evaluate", "shell", "bash", "powershell", "cmd", "spawn", "install", "login", "logout", "grant", "authorize", "approve", "sign"]);

function classifyTool(name, description = "") {
  return classifyToolDetailed(name, description).tipo;
}

// Verbos de conectores que mudam algo mas não casavam com as palavras acima
// (create_issue, reply_to_thread, merge_pull_request, cancel_event...). Antes caíam em "ler" e rodavam sem cartão.
const READ_VERBS = new Set(["get", "list", "read", "search", "find", "fetch", "query", "view", "show", "describe", "count", "check", "lookup", "browse", "download", "export", "preview", "ler", "listar", "buscar", "echo", "ping", "status", "info", "help", "version", "whoami", "stat", "inspect", "summarize", "history", "is", "has"]);
const VERBS = [
  ["apagar", ["cancel", "revoke", "purge", "wipe", "clear", "kill", "uninstall", "unsubscribe", "archive", "erase", "unlink", "truncate", "discard", "deactivate", "reset", "ban", "block", "cancelar"]],
  ["pagar", ["buy", "order", "book", "subscribe", "charge", "refund", "donate", "bid", "withdraw", "deposit", "comprar"]],
  ["enviar", ["reply", "respond", "forward", "invite", "notify", "share", "broadcast", "dm", "email", "mail", "sms", "whatsapp", "like", "follow", "react", "vote", "responder", "encaminhar", "navigate", "goto", "open", "visit"]],
  ["publicar", ["comment", "post", "toot", "repost", "retweet", "tweet", "deploy", "release", "merge", "push", "comentar"]],
  ["escrever", ["create", "update", "edit", "modify", "add", "insert", "move", "rename", "set", "patch", "put", "commit", "submit", "label", "assign", "schedule", "import", "run", "execute", "trigger", "start", "stop", "restart", "enable", "disable", "mark", "click", "fill", "press", "drag", "type", "approve", "accept", "confirm", "dismiss", "grant", "authorize", "close", "reopen", "sign", "login", "logout", "exec", "eval", "evaluate", "shell", "bash", "powershell", "cmd", "spawn", "install", "criar", "atualizar", "editar", "agendar"]],
];

function nameTokens(name) {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-zà-ú]+/)
    .filter(Boolean);
}

function classifyByVerb(lowerName) {
  const tokens = nameTokens(lowerName);
  if (!tokens.length || READ_VERBS.has(tokens[0])) return null;
  for (const [tipo, verbs] of VERBS) {
    if (tokens.some((token) => verbs.includes(token))) return tipo;
  }
  return null;
}

module.exports = { isIrreversible, normalizeTipo, classifyTool, classifyToolDetailed, TIPOS };
