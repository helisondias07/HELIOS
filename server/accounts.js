"use strict";

/**
 * Contas do Cursor do HELIOS. A chave fica criptografada pelo app (safeStorage).
 * list() nunca devolve a chave inteira. O SDK sempre recebe apiKey explícita.
 */
const crypto = require("node:crypto");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { redact } = require("./util");
const { findSecret } = require("./secret-scan");

const ENV_ID = "acc_env";
const KINDS = new Set(["login", "apiKey", "env"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_ACCOUNTS = 3;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Mensagem em português para uma falha do login pelo navegador, sem expor detalhes internos. */
function friendlyLoginError(err) {
  const raw = String((err && err.message) || err || "").slice(0, 160);
  return `Não consegui concluir a entrada pelo navegador${raw ? ` (${raw})` : ""}. Tente de novo ou use a chave de API, que é o caminho mais firme.`;
}
const SLOT_NAMES = ["Conta A", "Conta B", "Conta C"];

const USAGE_RE = /usage|quota|cota|limite de uso|out of usage/i;
// Fora de um 429, só trata como "limite de uso" quando a frase deixa isso claro (evita confundir com erro de ferramenta).
const USAGE_STRICT_RE = /usage limit|out of usage|quota exceeded|exceeded.{0,20}quota|spend limit|limite de uso|cota (?:esgotada|excedida)/i;
const RATE_RE = /rate limit|too many requests|\b429\b|muitas requisi/i;
const AUTH_RE = /unauthori[sz]ed|invalid api key|bad api key|\b401\b|not logged in|chave inválida|não autenticad/i;

function looksLikeEmail(value) {
  return EMAIL_RE.test(String(value || "").trim());
}

function sanitizeAccountLabel(raw) {
  const value = String(raw || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!value || looksLikeEmail(value)) return "";
  return value;
}

function classifyAccountError(err) {
  if (!err) return null;
  const message = String(err.message || err).slice(0, 300);
  const byName = err.name === "RateLimitError" ? 429 : err.name === "AuthenticationError" ? 401 : 0;
  const status = Number(err.status || err.statusCode || 0) || byName;
  if (status === 401 || AUTH_RE.test(message)) return { kind: "auth", message };
  if (status === 429 || RATE_RE.test(message)) return { kind: USAGE_RE.test(message) ? "usage" : "rate", message };
  if (USAGE_STRICT_RE.test(message)) return { kind: "usage", message };
  return null;
}

function describeAccountIssue(issue, label) {
  const who = label ? `da conta ${label}` : "da conta do Cursor";
  if (issue?.kind === "usage") return `O limite de uso ${who} acabou.`;
  if (issue?.kind === "rate") return `O Cursor está limitando as requisições ${who} agora.`;
  return `A conexão ${who} expirou ou a chave não vale mais.`;
}

function sdkAdapters({ mock = false } = {}) {
  if (mock) {
    return {
      async validateKey(apiKey) {
        if (/invalid|errada/i.test(apiKey)) throw Object.assign(new Error("API key inválida"), { status: 401 });
        return { email: null, keyName: "demo" };
      },
      async login({ onUrl, signal }) {
        onUrl("https://helios.invalid/login-demonstracao"); /* endereço falso de propósito: só existe no modo demonstração e nunca é aberto */
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 20);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("Login cancelado."));
          });
        });
        return { apiKey: `demo_${crypto.randomBytes(8).toString("hex")}`, email: null, expiresAt: Date.now() + 90 * 864e5 };
      },
    };
  }
  return {
    async validateKey(apiKey) {
      const { Cursor } = await import("@cursor/sdk");
      const me = await Cursor.me({ apiKey });
      return { email: me.userEmail || null, keyName: me.apiKeyName || null };
    },
    async login({ onUrl, signal }) {
      const { Cursor } = await import("@cursor/sdk");
      const res = await Cursor.auth.login({
        store: null,
        openBrowser: false,
        onLoginUrl: onUrl,
        signal,
        apiKeyName: `HELIOS · ${os.hostname()}`.slice(0, 60),
      });
      return { apiKey: res.apiKey, email: res.email || null, expiresAt: res.apiKeyExpiresAtMs || null };
    },
  };
}

function newAccountId() {
  return `acc_${crypto.randomBytes(5).toString("hex")}`;
}

function cleanRecord(record) {
  if (!record || !KINDS.has(record.kind)) return null;
  const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  if (!apiKey) return null;
  return {
    id: typeof record.id === "string" && /^acc_[\w-]+$/.test(record.id) ? record.id : newAccountId(),
    kind: record.kind,
    label: sanitizeAccountLabel(record.label),
    email: record.email ? String(record.email).slice(0, 120) : null,
    apiKey,
    expiresAt: Number(record.expiresAt) || null,
    addedAt: record.addedAt || new Date().toISOString(),
  };
}

function parseAccountsSnapshot(raw) {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    const accounts = (Array.isArray(value?.accounts) ? value.accounts : []).map(cleanRecord).filter(Boolean);
    const activeId = accounts.some((account) => account.id === value?.activeId) ? value.activeId : accounts[0]?.id || null;
    return { accounts, activeId };
  } catch {
    return { accounts: [], activeId: null };
  }
}

const KIND_LABEL = { login: "Login do Cursor", apiKey: "Chave de API", env: "CURSOR_API_KEY do .env" };

function createAccountStore({ initial, persist = null, adapters, log = () => {}, loginTimeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const events = new EventEmitter();
  const start = parseAccountsSnapshot(initial || {});
  let accounts = start.accounts;
  let activeId = start.activeId;
  let login = null;

  const issues = new Map();

  const find = (id) => accounts.find((account) => account.id === id) || null;
  const stored = () => accounts.filter((account) => account.kind !== "env");
  const display = (account) => sanitizeAccountLabel(account?.label) || (account?.kind === "env" ? "Chave do .env" : "Conta");

  function freeSlotName(except = null) {
    const used = new Set(stored().filter((account) => account !== except).map((account) => sanitizeAccountLabel(account.label).toLowerCase()));
    const free = SLOT_NAMES.find((name) => !used.has(name.toLowerCase()));
    return free || `Conta ${stored().length + 1}`;
  }

  // Contas antigas sem apelido ganham Conta A, B, C (só em memória; grava na próxima alteração).
  for (const account of stored()) if (!sanitizeAccountLabel(account.label)) account.label = freeSlotName(account);
  const logName = (account) => `${KIND_LABEL[account.kind] || account.kind} ••••${String(account.apiKey || "").slice(-4)}`;

  function snapshot() {
    return {
      version: 1,
      activeId: find(activeId)?.kind === "env" ? null : activeId,
      accounts: accounts.filter((account) => account.kind !== "env").map((account) => ({ ...account })),
    };
  }

  function changed() {
    if (persist) {
      try { persist(snapshot()); } catch (err) { log(`[contas] não deu para gravar: ${err.message || err}`); }
    }
    events.emit("change");
  }

  function publicAccount(account) {
    const issue = issues.get(account.id) || null;
    return {
      id: account.id,
      kind: account.kind,
      kindLabel: KIND_LABEL[account.kind],
      label: display(account),
      email: account.email || null,
      active: account.id === activeId,
      hasKey: Boolean(account.apiKey),
      // Só os 4 últimos caracteres, como identificação; a chave nunca sai daqui.
      keyHint: account.apiKey ? `••••${account.apiKey.slice(-4)}` : null,
      removable: true,
      replaceable: account.kind !== "env",
      expiresAt: account.expiresAt,
      addedAt: account.addedAt,
      issue: issue ? { kind: issue.kind, at: issue.at } : null,
    };
  }

  function upsert(record) {
    const clean = cleanRecord(record);
    if (!clean) throw Object.assign(new Error("conta inválida"), { status: 400 });
    let target = accounts.find((account) => account.apiKey === clean.apiKey) || null;
    if (target) {
      Object.assign(target, { ...clean, id: target.id, addedAt: target.addedAt, label: sanitizeAccountLabel(clean.label) || target.label });
    } else {
      if (stored().length >= MAX_ACCOUNTS) throw Object.assign(new Error(`Você já tem ${MAX_ACCOUNTS} contas. Remova uma antes de adicionar outra.`), { status: 409 });
      target = clean;
      if (!sanitizeAccountLabel(target.label)) target.label = freeSlotName(target);
      accounts.push(target);
    }
    // Uma conta nova só vira a ativa se ainda não há nenhuma conta ativa guardada: quem troca é você, em "Tornar ativa".
    const current = find(activeId);
    if (!current || current.kind === "env") activeId = target.id;
    issues.delete(target.id);
    changed();
    return target;
  }

  function checkLabel(raw, exceptId = null) {
    const label = sanitizeAccountLabel(raw);
    if (!label) throw Object.assign(new Error("Escolha um apelido curto, sem e-mail (por exemplo, Conta A)."), { status: 400 });
    if (findSecret(label)) throw Object.assign(new Error("O apelido parece conter uma chave ou senha. Use um nome simples, como Conta A."), { status: 400 });
    const clash = accounts.find((account) => account.id !== exceptId && display(account).toLowerCase() === label.toLowerCase());
    if (clash) throw Object.assign(new Error(`Já existe uma conta chamada ${display(clash)}. Escolha outro apelido.`), { status: 409 });
    return label;
  }

  /** Cadastra uma chave nova (até 3 contas) ou, com replaceId, troca a chave de uma conta já cadastrada. */
  async function addApiKey({ apiKey, label = "", replaceId = "" } = {}) {
    const key = String(apiKey || "").trim();
    if (key.length < 12 || /\s/.test(key)) throw Object.assign(new Error("Cole a chave inteira, sem espaços."), { status: 400 });
    const target = replaceId ? find(String(replaceId)) : null;
    if (replaceId && !target) throw Object.assign(new Error("conta não encontrada"), { status: 404 });
    if (target && target.kind === "env") throw Object.assign(new Error("Esta chave vem do arquivo .env. Cadastre uma conta nova aqui em vez de trocar essa."), { status: 400 });
    if (!target && stored().length >= MAX_ACCOUNTS) throw Object.assign(new Error(`Você já tem ${MAX_ACCOUNTS} contas. Remova uma ou troque a chave de uma delas.`), { status: 409 });
    const same = accounts.find((account) => account.apiKey === key && account.id !== target?.id);
    if (same) throw Object.assign(new Error(`Esta chave já está cadastrada como ${display(same)}.`), { status: 409 });
    const wanted = String(label || "").trim() ? checkLabel(label, target?.id || null) : "";
    let info;
    try {
      info = await adapters.validateKey(key);
    } catch (err) {
      const issue = classifyAccountError(err);
      throw Object.assign(new Error(issue?.kind === "auth" ? "O Cursor não aceitou esta chave." : `Não deu para conferir a chave: ${redact(err.message || err)}`), { status: 422 });
    }
    if (target) {
      Object.assign(target, { kind: "apiKey", apiKey: key, email: info?.email || null, expiresAt: null, label: wanted || target.label });
      issues.delete(target.id);
      log(`[contas] chave trocada: ${logName(target)}`);
      changed();
      return publicAccount(target);
    }
    const account = upsert({ kind: "apiKey", apiKey: key, email: info?.email || null, label: wanted });
    log(`[contas] chave adicionada: ${logName(account)}`);
    return publicAccount(account);
  }

  function addEnvKey(apiKey) {
    const key = String(apiKey || "").trim();
    if (!key) return;
    accounts = accounts.filter((account) => account.id !== ENV_ID);
    accounts.push(cleanRecord({ id: ENV_ID, kind: "env", apiKey: key, label: "" }));
    if (!find(activeId)) activeId = ENV_ID;
  }

  function loginStatus() {
    if (!login) return null;
    return { id: login.id, status: login.status, url: login.url, error: login.error, accountId: login.accountId };
  }

  function startLogin() {
    if (login?.status === "waiting") return loginStatus();
    if (stored().length >= MAX_ACCOUNTS) throw Object.assign(new Error(`Você já tem ${MAX_ACCOUNTS} contas. Remova uma antes de entrar com outra.`), { status: 409 });
    const controller = new AbortController();
    const mine = { id: crypto.randomBytes(4).toString("hex"), status: "waiting", url: null, error: null, accountId: null, abort: controller };
    login = mine;
    const timeout = setTimeout(() => {
      if (login !== mine || mine.status !== "waiting") return;
      controller.abort();
      Object.assign(mine, { status: "error", error: "O tempo para entrar acabou. Tente de novo ou use a chave de API." });
      events.emit("change");
    }, loginTimeoutMs);
    if (timeout.unref) timeout.unref();
    events.emit("change");
    adapters.login({
      signal: controller.signal,
      onUrl: (url) => {
        if (login !== mine) return;
        mine.url = /^https:\/\//.test(url) ? url : null;
        events.emit("login-url", mine.url);
        events.emit("change");
      },
    }).then((res) => {
      clearTimeout(timeout);
      if (login !== mine || mine.status !== "waiting") return;
      const account = upsert({ kind: "login", apiKey: res.apiKey, email: res.email || null, expiresAt: res.expiresAt || null });
      Object.assign(mine, { status: "done", accountId: account.id });
      log(`[contas] login concluído: ${logName(account)}`);
      events.emit("change");
    }).catch((err) => {
      clearTimeout(timeout);
      if (login !== mine || mine.status !== "waiting") return;
      const cancelled = controller.signal.aborted;
      Object.assign(mine, { status: cancelled ? "cancelled" : "error", error: cancelled ? "Login cancelado." : friendlyLoginError(err) });
      events.emit("change");
    });
    return loginStatus();
  }

  function cancelLogin() {
    if (login?.status === "waiting") {
      login.abort.abort();
      Object.assign(login, { status: "cancelled", error: "Login cancelado." });
      events.emit("change");
    }
    return loginStatus();
  }

  function setActive(id) {
    if (!find(id)) throw Object.assign(new Error("conta não encontrada"), { status: 404 });
    activeId = id;
    changed();
    log(`[contas] ativa agora: ${logName(find(id))}`);
    return publicAccount(find(id));
  }

  function setLabel(id, rawLabel) {
    const account = find(id);
    if (!account) throw Object.assign(new Error("conta não encontrada"), { status: 404 });
    if (account.kind === "env") throw Object.assign(new Error("Esta conta vem do arquivo .env e não tem apelido editável."), { status: 400 });
    account.label = checkLabel(rawLabel, id);
    changed();
    return publicAccount(account);
  }

  /** Marca que a conta bateu em limite de uso, de taxa ou de autenticação. Só informação: nunca troca de conta. */
  function noteIssue(id, kind) {
    if (!find(id) || !["usage", "rate", "auth"].includes(kind)) return;
    issues.set(id, { kind, at: new Date().toISOString() });
    events.emit("change");
  }

  /** Uma resposta funcionou nesta conta: o aviso de limite some. */
  function noteOk(id) {
    if (issues.delete(id)) events.emit("change");
  }

  /**
   * Sugestão para o botão "Trocar para a Conta B": a próxima conta (em ordem, a partir da atual) que tem chave.
   * Prefere uma que não bateu em limite de uso. Não troca nada.
   */
  function nextAccount(fromId) {
    const list = accounts.filter((account) => account.apiKey);
    const index = list.findIndex((account) => account.id === fromId);
    const ordered = index < 0 ? list : [...list.slice(index + 1), ...list.slice(0, index)];
    const others = ordered.filter((account) => account.id !== fromId);
    const pick = others.find((account) => issues.get(account.id)?.kind !== "usage") || others[0] || null;
    return pick ? { id: pick.id, label: display(pick), limited: issues.get(pick.id)?.kind === "usage" } : null;
  }

  function remove(id) {
    const account = find(id);
    if (!account) throw Object.assign(new Error("conta não encontrada"), { status: 404 });
    accounts = accounts.filter((item) => item.id !== id);
    issues.delete(id);
    if (activeId === id) activeId = accounts[0]?.id || null;
    log(`[contas] removida: ${logName(account)}`);
    changed();
    return { removed: id, activeId };
  }

  return {
    events,
    list: () => accounts.map(publicAccount),
    active: () => find(activeId),
    display,
    addApiKey,
    addEnvKey,
    startLogin,
    cancelLogin,
    loginStatus,
    setActive,
    setLabel,
    noteIssue,
    noteOk,
    nextAccount,
    remove,
    snapshot,
  };
}

module.exports = {
  createAccountStore,
  MAX_ACCOUNTS,
  SLOT_NAMES,
  sdkAdapters,
  classifyAccountError,
  describeAccountIssue,
  sanitizeAccountLabel,
  parseAccountsSnapshot,
  publicSafe: (accounts) => accounts.map((account) => ({ ...account, apiKey: undefined })),
};
