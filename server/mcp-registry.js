"use strict";

const path = require("node:path");
const { newId, nowIso, readJson, writeJson, redact } = require("./util");
const { connectMcp, mcpResultText } = require("./mcp-client");
const { setSecretValues } = require("./secret-values");

function cleanName(name) {
  const value = String(name || "").trim().slice(0, 40);
  if (!/^[\w.-]{2,40}$/.test(value)) throw Object.assign(new Error("Use um nome curto, só letras, números, ponto ou hífen."), { status: 400 });
  return value;
}

/** Erro de conector sem segredo na mensagem (stderr do servidor stdio, resposta HTTP...). */
function safeError(err) {
  const copy = new Error(redact(err && err.message ? err.message : String(err)));
  if (err && err.code !== undefined) copy.code = err.code;
  if (err && err.status !== undefined) copy.status = err.status;
  return copy;
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION/i;

/** Valores de env/headers que valem como segredo (pelo nome, ou por serem longos). "production" ou "info" não entram. */
function secretValuesOf(items) {
  const out = [];
  const take = (name, value) => {
    const text = String(value ?? "").trim();
    if (!text) return;
    if (SECRET_NAME.test(String(name)) || (text.length >= 20 && !/\s/.test(text))) out.push(text);
  };
  for (const item of items) {
    for (const [name, value] of Object.entries(item.env || {})) take(name, value);
    for (const [name, value] of Object.entries(item.headers || {})) {
      take(name, value);
      const scheme = /^\s*\w+\s+(\S.*)$/.exec(String(value ?? ""));
      if (scheme) take(name, scheme[1]);
    }
  }
  return out;
}

function hasSecrets(item) {
  return Boolean((item.env && Object.keys(item.env).length) || (item.headers && Object.keys(item.headers).length) || item.secretsLocked || item.hasHeaders || (item.envNames && item.envNames.length));
}

/** Cópia do conector sem os campos que só existem em memória (estado da cifra). */
function withoutRuntime(item) {
  const copy = { ...item };
  delete copy.encrypted;
  delete copy.secretsLocked;
  delete copy.lockedBlob;
  return copy;
}

function cleanHeaders(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const [name, value] of Object.entries(input).slice(0, 30)) out[String(name).slice(0, 80)] = String(value ?? "").slice(0, 4000);
  return out;
}

function publicServer(item) {
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    command: item.command || "",
    args: item.args || [],
    url: item.url || "",
    hasHeaders: Boolean((item.headers && Object.keys(item.headers).length) || item.hasHeaders),
    envNames: item.type === "stdio" ? (item.env && Object.keys(item.env).length ? Object.keys(item.env) : (Array.isArray(item.envNames) ? item.envNames : [])) : [],
    // true = env/headers estão cifrados no disco (cofre do sistema); false = em texto aberto; null = o conector não tem segredos.
    encrypted: hasSecrets(item) ? item.encrypted === true : null,
    secretsLocked: item.secretsLocked === true,
    status: item.status || "unknown",
    toolCount: item.toolCount || 0,
    tools: item.tools || [],
    error: item.error || "",
    checkedAt: item.checkedAt || null,
    confirmed: item.type !== "stdio" || item.confirmed === true,
    connectionId: item.connectionId || "",
  };
}

/** Variáveis que o usuário quer passar a UM conector stdio: NOME=valor, uma por linha, ou um objeto. */
function cleanEnv(input) {
  if (input === undefined || input === null || input === "") return {};
  let pairs = [];
  if (typeof input === "string") {
    pairs = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const at = line.indexOf("=");
      return at < 0 ? [line, ""] : [line.slice(0, at).trim(), line.slice(at + 1)];
    });
  } else if (typeof input === "object" && !Array.isArray(input)) {
    pairs = Object.entries(input);
  } else {
    throw Object.assign(new Error("As variáveis do conector devem ser NOME=valor, uma por linha."), { status: 400 });
  }
  if (pairs.length > 30) throw Object.assign(new Error("No máximo 30 variáveis por conector."), { status: 400 });
  const out = {};
  for (const [name, value] of pairs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw Object.assign(new Error(`Nome de variável inválido: ${String(name).slice(0, 40)}`), { status: 400 });
    out[name] = String(value ?? "").slice(0, 2000);
  }
  return out;
}

/**
 * Registro de conectores MCP.
 *
 * `env` (stdio) e `headers` (http) costumam guardar tokens. Com um `sealer` (o safeStorage do cofre do HELIOS) eles vão para o
 * disco só cifrados (`secretsEnc`); em memória ficam abertos, porque o conector precisa deles para conectar. Nunca saem pela API:
 * a lista mostra só os NOMES das variáveis e se há headers.
 *   sealer = { available(): boolean, seal(texto): Promise<string base64>, open(base64): Promise<string> }
 * Sem sealer (testes, ou sistema sem cofre) o comportamento antigo continua: texto aberto no disco.
 * Registro antigo em texto aberto é migrado no primeiro `ready()` com sealer disponível, conferindo que abre de volta antes de trocar o arquivo.
 * Se um bloco cifrado não abrir (outro usuário do Windows, cofre trocado), o conector fica com `secretsLocked`, o bloco é preservado
 * no disco e nunca é sobrescrito.
 */
function createMcpRegistry(dataDir, { connect = connectMcp, sealer = null, headerFor = null } = {}) {
  const file = path.join(dataDir, "mcp.json");
  let items = readJson(file, []);
  if (!Array.isArray(items)) items = [];
  const sealerOn = () => Boolean(sealer && typeof sealer.available === "function" && sealer.available());
  const sealedCache = new Map();
  // Até o ready() abrir os blocos cifrados, todo conector com bloco fica "trancado" e o bloco é preservado.
  for (const item of items) {
    if (typeof item.secretsEnc === "string" && item.secretsEnc) {
      item.secretsLocked = true;
      item.lockedBlob = item.secretsEnc;
      item.env = {};
      item.headers = {};
      delete item.secretsEnc;
    }
  }

  /** Fase 3: os valores de env/headers dos conectores nunca podem voltar numa saída que vai ao modelo, histórico ou log. */
  function publish() {
    setSecretValues(`mcp:${file}`, secretValuesOf(items));
  }
  publish();

  const lockedError = () => new Error("Não consegui abrir as credenciais deste conector com o cofre do sistema. Remova e cadastre o conector de novo.");

  async function openAll() {
    if (!sealerOn()) return;
    for (const item of items) {
      if (!item.secretsLocked || !item.lockedBlob) continue;
      try {
        const text = await sealer.open(item.lockedBlob);
        const parsed = JSON.parse(text);
        item.env = parsed && typeof parsed.env === "object" && parsed.env ? parsed.env : {};
        item.headers = parsed && typeof parsed.headers === "object" && parsed.headers ? parsed.headers : {};
        item.secretsLocked = false;
        item.encrypted = true;
        sealedCache.set(item.id, { plain: text, blob: item.lockedBlob });
        delete item.lockedBlob;
      } catch {
        /* continua trancado: o bloco cifrado fica como está */
      }
    }
    publish();
  }

  /** Forma que vai para o disco. Com sealer: sem env/headers, só `secretsEnc`. */
  async function toDisk(item, canSeal) {
    const { env, headers, secretsLocked, lockedBlob } = item;
    const rest = withoutRuntime(item);
    delete rest.env;
    delete rest.headers;
    const envNames = Object.keys(env || {});
    const hasHeaders = Boolean(headers && Object.keys(headers).length);
    if (secretsLocked && lockedBlob) return { ...rest, envNames: item.envNames || [], hasHeaders: Boolean(item.hasHeaders), secretsEnc: lockedBlob };
    if (!envNames.length && !hasHeaders) return { ...rest, env: {}, headers: {} };
    if (canSeal) {
      try {
        const plain = JSON.stringify({ env: env || {}, headers: headers || {} });
        let cached = sealedCache.get(item.id);
        if (!cached || cached.plain !== plain) {
          const blob = await sealer.seal(plain);
          if ((await sealer.open(blob)) !== plain) throw new Error("a conferência da cifra falhou");
          cached = { plain, blob };
          sealedCache.set(item.id, cached);
        }
        const live = items.find((entry) => entry.id === item.id);
        if (live) live.encrypted = true;
        return { ...rest, envNames, hasHeaders, secretsEnc: cached.blob };
      } catch {
        /* sem cifra agora: guarda como antes em vez de perder as credenciais */
      }
    }
    const live = items.find((entry) => entry.id === item.id);
    if (live) live.encrypted = false;
    return { ...rest, env: env || {}, headers: headers || {} };
  }

  let opened = null;
  let ready = null;
  const openOnce = () => (opened || (opened = openAll()));
  let chain = Promise.resolve();
  function save() {
    if (!sealer) {
      writeJson(file, items.map((item) => {
        const rest = withoutRuntime(item);
        if (item.secretsLocked && item.lockedBlob) return { ...rest, env: undefined, headers: undefined, secretsEnc: item.lockedBlob };
        return rest;
      }));
      return Promise.resolve();
    }
    chain = chain.then(async () => {
      await openOnce();
      const canSeal = sealerOn();
      const snapshot = items.map((item) => ({ ...item, env: { ...(item.env || {}) }, headers: { ...(item.headers || {}) } }));
      const out = [];
      for (const item of snapshot) out.push(await toDisk(item, canSeal));
      writeJson(file, out);
    }).catch(() => {});
    return chain;
  }

  /** Abre os blocos cifrados e migra o que ainda está em texto aberto. Chame uma vez antes de usar. */
  function whenReady() {
    if (!ready) {
      ready = (async () => {
        await openOnce();
        if (sealerOn() && items.some((item) => !item.secretsLocked && hasSecrets(item) && item.encrypted !== true)) await save();
      })();
    }
    return ready;
  }

  function list() {
    return items.map(publicServer);
  }

  function add(input) {
    const name = cleanName(input.name);
    if (items.some((item) => item.name === name)) throw Object.assign(new Error("Já existe um conector com esse nome."), { status: 409 });
    const type = input.type === "http" ? "http" : "stdio";
    const item = {
      id: newId("mcp"),
      name,
      type,
      command: type === "stdio" ? String(input.command || "").trim() : "",
      args: type === "stdio" ? (Array.isArray(input.args) ? input.args.map(String) : String(input.args || "").split(/\s+/).filter(Boolean)) : [],
      url: type === "http" ? String(input.url || "").trim() : "",
      env: type === "stdio" ? cleanEnv(input.env) : {},
      headers: type === "http" ? cleanHeaders(input.headers) : {},
      toolCount: 0,
      tools: [],
      error: "",
      checkedAt: null,
      confirmed: type !== "stdio",
      status: type === "stdio" ? "aguardando" : "unknown",
    };
    if (type === "stdio" && !item.command) throw Object.assign(new Error("Informe o comando do servidor stdio."), { status: 400 });
    if (type === "http" && !/^https?:\/\//i.test(item.url)) throw Object.assign(new Error("Informe a URL http(s) do servidor."), { status: 400 });
    items.push(item);
    publish();
    save();
    return publicServer(item);
  }

  function remove(id) {
    const before = items.length;
    items = items.filter((item) => item.id !== id);
    if (items.length === before) return false;
    publish();
    save();
    return true;
  }

  async function configOf(item) {
    if (item.secretsLocked) throw lockedError();
    if (item.type === "http") {
      const headers = { ...(item.headers || {}) };
      if (item.connectionId && headerFor) {
        const bearer = await headerFor(item.connectionId);
        if (bearer) headers.Authorization = bearer;
      }
      return { type: "http", url: item.url, headers };
    }
    return { type: "stdio", command: item.command, args: item.args || [], env: item.env || {} };
  }

  /** Liga (ou atualiza) um MCP http a uma conta da galeria. O token não fica neste registro. */
  function linkHttp({ name, url, connectionId }) {
    const clean = cleanName(name);
    const target = String(url || "").trim();
    if (!/^https:\/\//i.test(target)) throw Object.assign(new Error("A URL do conector precisa ser https."), { status: 400 });
    let item = items.find((entry) => entry.connectionId === connectionId) || items.find((entry) => entry.name === clean);
    if (!item) {
      item = {
        id: newId("mcp"), name: clean, type: "http", command: "", args: [], url: target,
        env: {}, headers: {}, connectionId, toolCount: 0, tools: [], error: "", checkedAt: null,
        confirmed: true, status: "unknown",
      };
      items.push(item);
    } else {
      Object.assign(item, { name: clean, type: "http", url: target, connectionId, confirmed: true });
    }
    publish();
    save();
    return publicServer(item);
  }

  function confirm(id) {
    const item = items.find((entry) => entry.id === id);
    if (!item) throw Object.assign(new Error("conector não encontrado"), { status: 404 });
    item.confirmed = true;
    if (item.status === "aguardando") item.status = "unknown";
    save();
    return publicServer(item);
  }

  async function test(id) {
    const item = items.find((entry) => entry.id === id);
    if (!item) throw Object.assign(new Error("conector não encontrado"), { status: 404 });
    if (item.type === "stdio" && item.confirmed !== true) {
      throw Object.assign(new Error("Confirme o comando na janela do HELIOS antes de testar."), { status: 409 });
    }
    try {
      const conn = await connect(item.name, await configOf(item), { timeoutMs: 12000, initTimeoutMs: 8000 });
      item.status = "online";
      item.toolCount = conn.tools.length;
      item.tools = conn.tools.map((tool) => ({ name: tool.name, description: redact(String(tool.description || "")).slice(0, 180) }));
      item.error = "";
      item.checkedAt = nowIso();
      try { conn.close(); } catch { /* ignora */ }
    } catch (err) {
      item.status = "offline";
      item.toolCount = 0;
      item.tools = [];
      item.error = redact(err.message || err).slice(0, 300);
      item.checkedAt = nowIso();
    }
    save();
    return publicServer(item);
  }

  async function call(name, tool, args) {
    const item = items.find((entry) => entry.name === name || entry.id === name);
    if (!item) throw new Error(`conector "${name}" não está configurado`);
    if (item.type === "stdio" && item.confirmed !== true) {
      throw new Error("Confirme o comando na janela do HELIOS antes de chamar este conector.");
    }
    let conn;
    try {
      conn = await connect(item.name, await configOf(item), { timeoutMs: 20000, initTimeoutMs: 8000 });
    } catch (err) {
      throw safeError(err);
    }
    try {
      const result = await conn.call(tool, args || {});
      // Fase 3: a saída do conector passa por redact() já na origem, antes de qualquer contexto, histórico ou log.
      return redact(mcpResultText(result));
    } catch (err) {
      throw safeError(err);
    } finally {
      try { conn.close(); } catch { /* ignora */ }
    }
  }

  function findTool(serverName, toolName) {
    const item = items.find((entry) => entry.name === serverName);
    if (!item || (item.type === "stdio" && item.confirmed !== true)) return null;
    return (item.tools || []).find((tool) => tool.name === toolName) || null;
  }

  return { list, add, remove, confirm, test, call, findTool, linkHttp, ready: whenReady, flush: () => chain, file };
}

module.exports = { createMcpRegistry, publicServer };
