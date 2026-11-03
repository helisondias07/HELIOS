"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { newId, readJson, writeJson } = require("../server/util");
const { setSecretValues } = require("../server/secret-values");
const { createVaultCrypto } = require("./vault-crypto");

const FORMAT_ASYNC = 2;
/** Leva G: chaves aceitas. As de PUBLIC_KEYS não são segredo (e-mail padrão, id do cliente Google). */
const KEY_NAMES = new Set(["groq", "gemini", "telegram", "googleClientId", "googleClientSecret", "githubClientId", "plataformaEmail", "plataformaSenha", "cpf", "nvidia"]);
const PUBLIC_KEYS = new Set(["plataformaEmail", "googleClientId", "githubClientId"]);
const FORMAT_LEGACY = 1;

const BLOCKED_MESSAGE = "O cofre não abriu (ou só abriu em parte), então o HELIOS não vai gravar nada para não apagar seus dados. "
  + "O arquivo vault.json foi mantido intacto. Reinicie o HELIOS. Se continuar assim, feche o HELIOS e restaure uma cópia: "
  + "troque %APPDATA%\\HELIOS\\vault.json por backups\\vault.pre-async.json ou backups\\vault.unreadable.json. "
  + "Só se não houver jeito, use \"Começar um cofre novo\" na aba Cofre: o HELIOS guarda uma cópia do arquivo ilegível antes.";

function blockedError() {
  return Object.assign(new Error(BLOCKED_MESSAGE), { code: "VAULT_BLOCKED", status: 423 });
}

/**
 * Cofre do HELIOS. Logins, tokens e chaves (Groq/Gemini) ficam criptografados
 * com safeStorage (DPAPI no Windows), pela API assíncrona (veja vault-crypto.js).
 * Sem criptografia, nada é gravado em disco.
 *
 * `createVault` é assíncrono: abre e decifra o cofre uma vez. Depois disso as leituras
 * são síncronas (vêm da memória) e toda gravação é assíncrona e em fila.
 * O vault.json de antes (formato 1, cifrado com a API síncrona) continua abrindo; antes de
 * regravar no formato novo, ele é copiado para backups/vault.pre-async.json.
 */
async function createVault({ dir, safeStorage }) {
  const file = path.join(dir, "vault.json");
  const backupDir = path.join(dir, "backups");
  const preAsyncBackup = path.join(backupDir, "vault.pre-async.json");
  const unreadableBackup = path.join(backupDir, "vault.unreadable.json");
  fs.mkdirSync(dir, { recursive: true });

  const vcrypto = createVaultCrypto(safeStorage);
  const mode = await vcrypto.mode();
  const encAvailable = () => mode !== "none";
  const targetFormat = mode === "async" ? FORMAT_ASYNC : FORMAT_LEGACY;

  // Arquivo que existe mas não é um JSON de objeto também conta como ilegível: nunca é trocado por um cofre vazio.
  let disk = { version: FORMAT_LEGACY };
  let needsResave = false;
  let unreadable = false;
  if (fs.existsSync(file)) {
    try {
      const rawText = fs.readFileSync(file, "utf8");
      if (rawText.trim()) {
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) disk = parsed;
        else unreadable = true;
      }
    } catch {
      unreadable = true;
    }
  }

  async function dec(blob, fallback) {
    if (!blob || !encAvailable()) return fallback;
    try {
      const out = await vcrypto.decrypt(Buffer.from(blob, "base64"));
      if (out.reEncrypt) needsResave = true;
      return JSON.parse(out.text);
    } catch {
      unreadable = true;
      return fallback;
    }
  }

  async function encText(text) {
    return (await vcrypto.encrypt(text)).toString("base64");
  }

  let logins = await dec(disk.logins, []);
  let tokens = await dec(disk.tokens, []);
  let keys = await dec(disk.keys, {});
  let accounts = await dec(disk.accounts, null);
  if (!Array.isArray(logins)) logins = [];
  if (!Array.isArray(tokens)) tokens = [];
  if (!keys || typeof keys !== "object") keys = {};
  let persisted = encAvailable();
  if (!encAvailable()) {
    logins = [];
    tokens = [];
    keys = {};
    accounts = null;
    persisted = false;
  }

  /**
   * Fase 3: registra os valores secretos só em memória. Se algum aparecer num texto que vai ao modelo, ao histórico, a um log
   * ou a um cartão, o redact() o troca por [segredo]. Nada disso é gravado nem devolvido.
   */
  function publishSecretValues() {
    const values = [];
    for (const entry of logins) if (entry && entry.senha) values.push(entry.senha);
    for (const entry of tokens) if (entry && entry.valor) values.push(entry.valor);
    for (const [name, value] of Object.entries(keys || {})) if (typeof value === "string" && !PUBLIC_KEYS.has(name)) values.push(value);
    for (const account of (accounts && Array.isArray(accounts.accounts) ? accounts.accounts : [])) if (account && account.apiKey) values.push(account.apiKey);
    setSecretValues(`vault:${file}`, values);
  }
  publishSecretValues();

  /** Copia o arquivo atual (só cifrado) uma vez, antes de qualquer regravação que o troque. */
  function backupOnce(target, onlyIf) {
    try {
      if (!fs.existsSync(file) || fs.existsSync(target)) return;
      if (onlyIf && !onlyIf(readJson(file, {}))) return;
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(file, target);
    } catch {
      /* sem cópia, a regravação ainda confere o que gravou */
    }
  }

  async function writeNow() {
    if (!encAvailable()) return { persisted: false };
    // Cofre que existe mas não abriu: nunca grava por cima, mesmo que consiga cifrar.
    if (unreadable) return { persisted: false, blocked: true, error: BLOCKED_MESSAGE };
    try {
      // Foto do estado agora: gravações que chegarem durante a cifra entram na próxima da fila.
      const snap = {
        logins: JSON.stringify(logins),
        tokens: JSON.stringify(tokens),
        keys: JSON.stringify(keys),
        accounts: accounts ? JSON.stringify(accounts) : null,
      };
      const body = {
        logins: await encText(snap.logins),
        tokens: await encText(snap.tokens),
        keys: await encText(snap.keys),
        accounts: snap.accounts ? await encText(snap.accounts) : null,
      };
      // Confere que o que acabou de cifrar abre de volta antes de trocar o arquivo.
      const check = await vcrypto.decrypt(Buffer.from(body.keys, "base64"));
      if (check.text !== snap.keys) return { persisted: false };
      // O arquivo de antes (formato 1) nunca é perdido; se algo não abriu, também guarda uma cópia.
      if (targetFormat === FORMAT_ASYNC) backupOnce(preAsyncBackup, (current) => current.version !== FORMAT_ASYNC);
      writeJson(file, { version: targetFormat, ...body });
      return { persisted: true };
    } catch {
      return { persisted: false };
    }
  }

  // Gravações em fila: duas chamadas seguidas nunca se atropelam. Nunca rejeita.
  let chain = Promise.resolve();
  function save() {
    publishSecretValues();
    const run = chain.then(async () => {
      const out = await writeNow();
      persisted = out.persisted;
      return out;
    });
    chain = run.catch(() => {});
    return run;
  }

  // Cópia do que não abriu, feita já na abertura (só copia; o vault.json fica como está).
  if (unreadable) backupOnce(unreadableBackup);

  const hadSecrets = Boolean(disk.logins || disk.tokens || disk.keys || disk.accounts);
  // Formato antigo (ou chave que girou): regrava já, pelo caminho novo, só se tudo abriu.
  if (encAvailable() && hadSecrets && !unreadable && (needsResave || (mode === "async" && disk.version !== FORMAT_ASYNC))) {
    await save();
  }

  function publicLogin(entry) {
    return { id: entry.id, tipo: "login", nome: entry.nome, usuario: entry.usuario || "", url: entry.url || "", notas: entry.notas || "", categoria: entry.categoria || "", senhaDefinida: Boolean(entry.senha) };
  }

  function publicToken(entry) {
    return { id: entry.id, tipo: "token", nome: entry.nome, notas: entry.notas || "", valorDefinido: Boolean(entry.valor) };
  }

  /** Token já existente, ou novo (só em memória até a fila gravar). Usado nos caminhos síncronos do servidor. */
  function tokenOf(name) {
    if (!keys[name]) {
      keys[name] = crypto.randomBytes(32).toString("base64url");
      save();
    }
    return keys[name];
  }

  /**
   * Cifra e decifra textos avulsos com o mesmo safeStorage do cofre. Usado pelo registro de conectores MCP para guardar
   * env/headers (tokens) cifrados em mcp.json. Não guarda nada aqui dentro.
   */
  const sealer = {
    available: encAvailable,
    seal: (text) => encText(String(text)),
    open: async (blob) => (await vcrypto.decrypt(Buffer.from(String(blob), "base64"))).text,
  };

  return {
    file,
    backupFile: preAsyncBackup,
    sealer,
    mode,
    encryptionAvailable: encAvailable,
    /** true = o vault.json existe mas não abriu; nada é gravado até restaurar ou começar um cofre novo. */
    isBlocked: () => unreadable,
    blockedMessage: () => (unreadable ? BLOCKED_MESSAGE : ""),
    list() {
      return {
        logins: logins.map(publicLogin),
        tokens: tokens.map(publicToken),
        keys: { hasGroqKey: Boolean(keys.groq), hasGeminiKey: Boolean(keys.gemini), hasTelegramKey: Boolean(keys.telegram), hasGoogleClient: Boolean(keys.googleClientId && keys.googleClientSecret), hasGithubClient: Boolean(keys.githubClientId), hasPlatformPassword: Boolean(keys.plataformaSenha), plataformaEmail: keys.plataformaEmail || "", hasCpf: Boolean(keys.cpf), hasNvidiaKey: Boolean(keys.nvidia) },
        persisted,
        blocked: unreadable,
        blockedMessage: unreadable ? BLOCKED_MESSAGE : "",
      };
    },
    /**
     * Ação explícita do usuário: troca um cofre ilegível por um novo, vazio. Antes copia o vault.json
     * para backups/vault.unreadable-<data>.json e confere o tamanho da cópia; se a cópia falhar, nada muda.
     */
    async startFresh() {
      if (!unreadable) throw new Error("O cofre está aberto normalmente; não há o que recomeçar.");
      if (!encAvailable()) throw new Error("Sem criptografia do sistema, o HELIOS não consegue criar um cofre novo.");
      let copy = "";
      if (fs.existsSync(file)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        copy = path.join(backupDir, `vault.unreadable-${stamp}.json`);
        try {
          fs.mkdirSync(backupDir, { recursive: true });
          fs.copyFileSync(file, copy);
          if (fs.statSync(copy).size !== fs.statSync(file).size) throw new Error("tamanho diferente");
        } catch {
          throw new Error("Não consegui copiar o cofre ilegível para backups\\. Nada foi apagado e o cofre continua como estava.");
        }
      }
      const previous = { logins, tokens, keys, accounts };
      const session = {};
      if (keys.mcp) session.mcp = keys.mcp;
      if (keys.api) session.api = keys.api;
      if (keys.mcpRemote) session.mcpRemote = keys.mcpRemote;
      logins = [];
      tokens = [];
      keys = session;
      accounts = null;
      unreadable = false;
      const out = await save();
      if (!out.persisted) {
        ({ logins, tokens, keys, accounts } = previous);
        unreadable = true;
        throw new Error("Não consegui gravar o cofre novo. O cofre antigo continua intacto e a cópia ficou em backups\\.");
      }
      return { ok: true, backup: copy ? path.relative(dir, copy) : "" };
    },
    index() {
      return [
        ...logins.map((entry) => ({ id: entry.id, tipo: "login", nome: entry.nome })),
        ...tokens.map((entry) => ({ id: entry.id, tipo: "token", nome: entry.nome })),
      ];
    },
    getLogin(id) {
      const entry = logins.find((item) => item.id === id);
      return entry ? { ...entry, tipo: "login" } : null;
    },
    findLoginByName(nome) {
      const wanted = String(nome || "").trim().toLowerCase();
      return logins.find((entry) => entry.nome.toLowerCase() === wanted) || null;
    },
    getToken(id) {
      const entry = tokens.find((item) => item.id === id);
      return entry ? { ...entry, tipo: "token" } : null;
    },
    async saveLogin(input) {
      if (unreadable) throw blockedError();
      const nome = String(input.nome || "").trim().slice(0, 80);
      if (nome.length < 2) throw new Error("Dê um nome ao login.");
      let current = input.id ? logins.find((entry) => entry.id === input.id) : null;
      if (!current) {
        current = { id: newId("login"), nome, usuario: "", senha: "", url: "", notas: "" };
        logins.push(current);
      }
      current.nome = nome;
      if (input.usuario !== undefined) current.usuario = String(input.usuario || "").slice(0, 200);
      if (input.senha) current.senha = String(input.senha);
      if (input.url !== undefined) current.url = String(input.url || "").slice(0, 300);
      if (input.notas !== undefined) current.notas = String(input.notas || "").slice(0, 500);
      if (input.categoria !== undefined) current.categoria = input.categoria === "plataforma" ? "plataforma" : "";
      await save();
      return publicLogin(current);
    },
    async saveToken(input) {
      if (unreadable) throw blockedError();
      const nome = String(input.nome || "").trim().slice(0, 80);
      if (nome.length < 2) throw new Error("Dê um nome ao token.");
      let current = input.id ? tokens.find((entry) => entry.id === input.id) : null;
      const valor = String(input.valor || "");
      if (!current) {
        if (!valor) throw new Error("Cole o token.");
        current = { id: newId("token"), nome, valor: "", notas: "" };
        tokens.push(current);
      }
      current.nome = nome;
      if (valor) current.valor = valor;
      if (input.notas !== undefined) current.notas = String(input.notas || "").slice(0, 500);
      await save();
      return publicToken(current);
    },
    async remove(id) {
      if (unreadable) throw blockedError();
      logins = logins.filter((entry) => entry.id !== id);
      tokens = tokens.filter((entry) => entry.id !== id);
      await save();
      return this.list();
    },
    /**
     * Leva G: plataformas de vagas (nome, link de login, login). Sem senha própria, usa a senha padrão das plataformas.
     * Devolve a credencial completa só para o processo principal (navegador das vagas).
     */
    platforms() {
      return logins.filter((entry) => entry.categoria === "plataforma").map((entry) => ({ ...publicLogin(entry), senhaDefinida: Boolean(entry.senha || keys.plataformaSenha), usuario: entry.usuario || keys.plataformaEmail || "" }));
    },
    platformCredential(entry) {
      if (!entry) return null;
      return { usuario: entry.usuario || keys.plataformaEmail || "", senha: entry.senha || (entry.categoria === "plataforma" ? keys.plataformaSenha || "" : "") };
    },
    async savePlatform(input = {}) {
      const nome = String(input.nome || "").trim();
      if (input.url && !/^https:\/\//i.test(String(input.url))) throw new Error("O link de login precisa começar com https://.");
      const existing = logins.find((entry) => entry.nome.toLowerCase() === nome.toLowerCase());
      const out = await this.saveLogin({ id: existing ? existing.id : undefined, nome, url: input.url !== undefined ? String(input.url || "") : undefined, usuario: input.usuario !== undefined ? String(input.usuario || "") : undefined, senha: input.senha, categoria: "plataforma" });
      return { ...out, senhaDefinida: Boolean(out.senhaDefinida || keys.plataformaSenha) };
    },
    async removePlatform(nome) {
      const wanted = String(nome || "").trim().toLowerCase();
      const entry = logins.find((item) => item.categoria === "plataforma" && item.nome.toLowerCase() === wanted);
      if (!entry) return false;
      await this.remove(entry.id);
      return true;
    },
    getKey(name) {
      return keys[name] || "";
    },
    async setKey(name, value) {
      if (!KEY_NAMES.has(name)) throw new Error("chave desconhecida");
      const clean = String(value ?? "").trim();
      if (!clean) delete keys[name];
      else keys[name] = clean;
      return save();
    },
    /** Token do MCP local. Síncrono: o servidor consulta a cada pedido. Se não existia, nasce aqui e a fila grava. */
    mcpToken: () => tokenOf("mcp"),
    /** Token da API local. Mesmo comportamento do mcpToken. */
    apiToken: () => tokenOf("api"),
    /**
     * LEVA O1: token do MCP remoto (túnel futuro). SEPARADO do local.
     * Não nasce sozinho: só existe depois de gerar. Nunca é impresso em log.
     */
    mcpRemoteToken: () => (keys.mcpRemote ? String(keys.mcpRemote) : ""),
    hasMcpRemoteToken: () => Boolean(keys.mcpRemote),
    async mcpAccess() {
      tokenOf("mcp");
      const saved = await save();
      return { token: keys.mcp, persisted: saved.persisted };
    },
    async apiAccess() {
      tokenOf("api");
      const saved = await save();
      return { token: keys.api, persisted: saved.persisted };
    },
    async regenerateMcpToken() {
      keys.mcp = crypto.randomBytes(32).toString("base64url");
      const saved = await save();
      return { token: keys.mcp, persisted: saved.persisted };
    },
    /** Gera (ou regenera) o token remoto. Devolve o valor só nesta resposta para copiar; a UI mostra "definido". */
    async generateMcpRemoteToken() {
      if (unreadable) throw blockedError();
      keys.mcpRemote = crypto.randomBytes(32).toString("base64url");
      const saved = await save();
      return { token: keys.mcpRemote, definido: true, persisted: saved.persisted };
    },
    /** Revoga o token remoto (apaga do cofre). */
    async revokeMcpRemoteToken() {
      if (unreadable) throw blockedError();
      delete keys.mcpRemote;
      const saved = await save();
      return { definido: false, persisted: saved.persisted };
    },
    /** Visão segura: nunca inclui o valor do token remoto. */
    mcpRemoteView() {
      return { definido: Boolean(keys.mcpRemote), persisted };
    },
    /**
     * Copia o token remoto para a área de transferência via callback do main.
     * Sem callback, devolve o token uma vez (só IPC interno — a UI não deve exibir em campo).
     */
    peekMcpRemoteToken() {
      return keys.mcpRemote ? String(keys.mcpRemote) : "";
    },
    getAccounts() {
      return accounts || { version: 1, activeId: null, accounts: [] };
    },
    setAccounts(snapshot) {
      accounts = snapshot || { version: 1, activeId: null, accounts: [] };
      return save();
    },
    /** Espera a fila de gravações esvaziar (usado ao fechar o app e nos testes). */
    flush: () => chain,
  };
}

/** O que a tela de edição pode ver. Senha e valor ficam no processo principal: a tela só sabe se estão "definidos". */
function editorView(entry) {
  if (!entry) return null;
  const view = { ...entry, senhaDefinida: Boolean(entry.senha), valorDefinido: Boolean(entry.valor) };
  delete view.senha;
  delete view.valor;
  return view;
}

module.exports = { createVault, editorView, FORMAT_ASYNC, FORMAT_LEGACY, KEY_NAMES };
