"use strict";

/**
 * Galeria de conectores. O token e o refresh ficam cifrados no cofre (o mesmo sealer do DPAPI).
 * A lista pública não devolve segredo nem client id. Várias contas do mesmo preset são registros separados.
 * O client id, quando o serviço exige, vem da configuração do aplicativo — nunca da tela.
 */
const path = require("node:path");
const { newId, readJson, writeJson } = require("./util");
const { findSecret } = require("./secret-scan");
const flow = require("./oauth-flow");
const { normalizeOAuthClients } = require("./oauth-clients");

const GITHUB_LOOPBACK_PORT = 47332;

const PRESETS = [
  {
    id: "gmail",
    name: "Gmail",
    blurb: "Lê a caixa de entrada.",
    kind: "google",
    clientKey: "google",
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
    includeResource: false,
  },
  {
    id: "gcalendar",
    name: "Google Calendar",
    blurb: "Lê a agenda.",
    kind: "google",
    clientKey: "google",
    mcpUrl: "https://calendarmcp.googleapis.com/mcp/v1",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.readonly"],
    includeResource: false,
  },
  {
    id: "gdrive",
    name: "Google Drive",
    blurb: "Lê os arquivos.",
    kind: "google",
    clientKey: "google",
    mcpUrl: "https://drivemcp.googleapis.com/mcp/v1",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.readonly"],
    includeResource: false,
  },
  {
    id: "clickup",
    name: "ClickUp",
    blurb: "Tarefas e documentos.",
    kind: "mcp",
    mcpUrl: "https://mcp.clickup.com/mcp",
    scopes: ["read", "write"],
  },
  {
    id: "github",
    name: "GitHub",
    blurb: "Repositórios e perfil.",
    kind: "github",
    clientKey: "github",
    mcpUrl: "https://api.githubcopilot.com/mcp/",
    scopes: ["read:user", "user:email", "repo"],
    redirectPort: GITHUB_LOOPBACK_PORT,
    includeResource: false,
  },
  {
    id: "figma",
    name: "Figma",
    blurb: "Arquivos de design.",
    kind: "mcp",
    mcpUrl: "https://mcp.figma.com/mcp",
    scopes: ["mcp:connect"],
  },
  {
    id: "notion",
    name: "Notion",
    blurb: "Páginas e bases.",
    kind: "mcp",
    mcpUrl: "https://mcp.notion.com/mcp",
    scopes: [],
  },
  {
    id: "slack",
    name: "Slack",
    blurb: "Canais e conversas.",
    kind: "slack",
    clientKey: "slack",
    needsSecret: true,
    mcpUrl: "https://mcp.slack.com/mcp",
    scopes: ["channels:history", "channels:read", "users:read", "users:read.email", "search:read.public"],
  },
  {
    id: "linear",
    name: "Linear",
    blurb: "Issues do time.",
    kind: "mcp",
    mcpUrl: "https://mcp.linear.app/mcp",
    scopes: ["read", "write"],
  },
  {
    id: "cursor",
    name: "Cursor",
    blurb: "A conta que move o agente.",
    kind: "cursor",
  },
];

function presetById(id) {
  return PRESETS.find((item) => item.id === id) || null;
}

function cleanLabel(raw, fallback) {
  const value = String(raw || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!value) return fallback;
  if (findSecret(value)) throw Object.assign(new Error("O nome parece conter uma chave. Use um apelido curto."), { status: 400 });
  return value;
}

function humanError(err) {
  if (err && err.code === "EADDRINUSE") return "A entrada não conseguiu abrir o retorno neste computador. Feche o outro HELIOS e tente de novo.";
  const text = flow.safeError(err);
  if (/recusou o cadastro/i.test(text)) return "Este aplicativo recusou o HELIOS. Nada ficou conectado.";
  if (/403/.test(text)) return "O serviço recusou a conexão. Tente de novo mais tarde.";
  if (/tempo para autorizar/i.test(text)) return "O tempo para entrar acabou. Tente de novo.";
  if (/cancelad/i.test(text)) return "A entrada foi cancelada.";
  if (/não confere/i.test(text)) return "O retorno do navegador não confere. Tente de novo.";
  return text;
}

function createConectores({ dataDir, sealer = null, mcp, fetchImpl = globalThis.fetch, openExternal = null, listen = flow.listenLoopback, now = () => Date.now(), oauthClients = {} } = {}) {
  const file = path.join(dataDir, "conectores.json");
  const clients = normalizeOAuthClients(oauthClients);
  let items = readJson(file, []);
  if (!Array.isArray(items)) items = [];
  const memory = new Map();
  const pending = new Map();
  const sealerOn = () => Boolean(sealer && typeof sealer.available === "function" && sealer.available());

  function embedded(preset) {
    const id = preset.clientKey ? clients[preset.clientKey] || "" : "";
    const secret = preset.needsSecret ? clients.slackSecret || "" : "";
    return { id, secret };
  }

  function isReady(preset) {
    if (!preset || !preset.clientKey) return true;
    const got = embedded(preset);
    if (!got.id) return false;
    if (preset.needsSecret && !got.secret) return false;
    return true;
  }

  function publicItem(item) {
    const secret = memory.get(item.id);
    return {
      id: item.id,
      presetId: item.presetId,
      label: item.label,
      status: item.status,
      accountHint: item.accountHint || "",
      error: item.error || "",
      persisted: item.persisted === true,
      mcpId: item.mcpId || "",
      hasRefresh: Boolean(secret?.refreshToken),
    };
  }

  function save() {
    const disk = items.map((item) => {
      const copy = { ...item };
      delete copy.userCode;
      return copy;
    });
    writeJson(file, disk);
  }

  async function remember(item, secret) {
    memory.set(item.id, secret);
    if (!sealerOn()) {
      item.persisted = false;
      item.secretsEnc = "";
      save();
      return;
    }
    const blob = await sealer.seal(JSON.stringify(secret));
    const opened = await sealer.open(blob);
    if (opened !== JSON.stringify(secret)) throw Object.assign(new Error("Não consegui conferir a cifra do cofre."), { status: 500 });
    item.secretsEnc = blob;
    item.persisted = true;
    save();
  }

  async function openOne(item) {
    if (memory.has(item.id) || !item.secretsEnc || !sealerOn()) return;
    try {
      memory.set(item.id, JSON.parse(await sealer.open(item.secretsEnc)));
    } catch {
      item.status = "reauth";
      item.error = "Não consegui abrir esta conta com o cofre. Conecte de novo.";
    }
  }

  async function ready() {
    for (const item of items) await openOne(item);
  }

  function scopesFor(preset, metadata) {
    if (preset.scopes && preset.scopes.length) return preset.scopes;
    return (metadata.scopes || []).slice(0, 8);
  }

  async function finish(item, token, client) {
    const secret = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken || "",
      expiresAt: token.expiresAt,
      clientSecret: client.clientSecret || "",
      clientId: client.clientId,
      scope: token.scope || "",
    };
    item.status = "connected";
    item.error = "";
    item.userCode = "";
    item.accountHint = token.accountHint || item.accountHint || "";
    item.tokenEndpoint = client.tokenEndpoint;
    item.clientId = client.clientId;
    await remember(item, secret);
    if (mcp && item.mcpUrl) {
      const linked = mcp.linkHttp({ name: `${item.presetId}-${item.id.slice(-4)}`, url: item.mcpUrl, connectionId: item.id });
      item.mcpId = linked.id;
      save();
    }
  }

  function fail(item, err) {
    item.status = err?.code === "REAUTH" ? "reauth" : "error";
    item.error = humanError(err);
    item.userCode = "";
    save();
  }

  async function runCodeFlow(item, preset) {
    let loop;
    try {
      try {
        loop = await listen({ timeoutMs: 5 * 60 * 1000, port: preset.redirectPort || 0 });
      } catch (err) {
        if (err && err.code === "EADDRINUSE") {
          throw Object.assign(new Error("porta de retorno ocupada"), { code: "EADDRINUSE" });
        }
        throw err;
      }
      const metadata = await flow.discover(preset.mcpUrl, fetchImpl);
      const got = embedded(preset);
      let clientSecret = got.secret;
      let usedClient = got.id;
      if (!usedClient && metadata.registrationEndpoint) {
        const registered = await flow.registerClient(metadata, loop.redirectUri, fetchImpl);
        usedClient = registered.clientId;
        clientSecret = registered.clientSecret || clientSecret;
      }
      if (!usedClient) throw Object.assign(new Error("Este conector ainda não está disponível neste HELIOS."), { status: 409 });
      const code = flow.pkce();
      const state = flow.randomState();
      const url = flow.authorizeUrl({
        metadata,
        clientId: usedClient,
        redirectUri: loop.redirectUri,
        challenge: code.challenge,
        state,
        scopes: scopesFor(preset, metadata),
        google: preset.kind === "google",
        includeResource: preset.includeResource !== false,
      });
      if (openExternal) await openExternal(url);
      const back = await loop.wait();
      if (!flow.sameState(back.state, state)) throw Object.assign(new Error("O retorno do navegador não confere."), { status: 400 });
      const token = await flow.exchangeCode({
        tokenEndpoint: metadata.tokenEndpoint,
        clientId: usedClient,
        clientSecret,
        code: back.code,
        redirectUri: loop.redirectUri,
        verifier: code.verifier,
        fetchImpl,
      });
      await finish(item, token, { clientId: usedClient, clientSecret, tokenEndpoint: metadata.tokenEndpoint });
    } finally {
      if (loop) loop.close();
    }
  }

  function defaultLabel(preset) {
    const count = items.filter((item) => item.presetId === preset.id).length;
    return count === 0 ? "pessoal" : `conta ${count + 1}`;
  }

  function launch(item, preset) {
    const controller = new AbortController();
    pending.set(item.id, controller);
    const job = runCodeFlow(item, preset)
      .catch((err) => { if (item.status === "waiting") fail(item, err); })
      .finally(() => pending.delete(item.id));
    job.catch(() => {});
  }

  function start(presetId, input = {}) {
    const preset = presetById(presetId);
    if (!preset || preset.kind === "cursor") throw Object.assign(new Error("Conector desconhecido."), { status: 404 });
    if (!isReady(preset)) throw Object.assign(new Error("Este conector ainda não está disponível neste HELIOS."), { status: 409 });
    const label = cleanLabel(input.label, defaultLabel(preset));
    const item = {
      id: newId("con"),
      presetId: preset.id,
      label,
      status: "waiting",
      accountHint: "",
      error: "",
      userCode: "",
      mcpUrl: preset.mcpUrl,
      mcpId: "",
      clientId: "",
      tokenEndpoint: "",
      secretsEnc: "",
      persisted: false,
    };
    items.push(item);
    save();
    launch(item, preset);
    return publicItem(item);
  }

  function reconnect(id) {
    const item = items.find((entry) => entry.id === id);
    if (!item) throw Object.assign(new Error("conta não encontrada"), { status: 404 });
    const preset = presetById(item.presetId);
    if (!preset || !isReady(preset)) throw Object.assign(new Error("Este conector ainda não está disponível neste HELIOS."), { status: 409 });
    pending.get(id)?.abort();
    item.status = "waiting";
    item.error = "";
    item.userCode = "";
    save();
    launch(item, preset);
    return publicItem(item);
  }

  function cancel(id) {
    const item = items.find((entry) => entry.id === id);
    if (!item) throw Object.assign(new Error("conta não encontrada"), { status: 404 });
    pending.get(id)?.abort();
    if (item.status === "waiting") {
      item.status = "error";
      item.error = "Conexão cancelada.";
      item.userCode = "";
      save();
    }
    return publicItem(item);
  }

  function rename(id, label) {
    const item = items.find((entry) => entry.id === id);
    if (!item) throw Object.assign(new Error("conta não encontrada"), { status: 404 });
    item.label = cleanLabel(label, "");
    if (!item.label) throw Object.assign(new Error("Escolha um nome."), { status: 400 });
    save();
    return publicItem(item);
  }

  function remove(id) {
    const item = items.find((entry) => entry.id === id);
    if (!item) return false;
    pending.get(id)?.abort();
    items = items.filter((entry) => entry.id !== id);
    memory.delete(id);
    if (item.mcpId && mcp) mcp.remove(item.mcpId);
    save();
    return true;
  }

  async function refresh(id) {
    const item = items.find((entry) => entry.id === id);
    if (!item) throw Object.assign(new Error("conta não encontrada"), { status: 404 });
    await openOne(item);
    const secret = memory.get(id);
    if (!secret?.refreshToken || !item.tokenEndpoint) {
      item.status = "reauth";
      item.error = "Esta conta precisa entrar de novo.";
      save();
      throw Object.assign(new Error(item.error), { status: 401, code: "REAUTH" });
    }
    try {
      const token = await flow.refreshAccess({
        tokenEndpoint: item.tokenEndpoint,
        clientId: secret.clientId || item.clientId,
        clientSecret: secret.clientSecret || "",
        refreshToken: secret.refreshToken,
        fetchImpl,
      });
      await finish(item, token, { clientId: secret.clientId || item.clientId, clientSecret: secret.clientSecret || "", tokenEndpoint: item.tokenEndpoint });
      return publicItem(item);
    } catch (err) {
      fail(item, err);
      throw err;
    }
  }

  async function authorization(id) {
    const item = items.find((entry) => entry.id === id);
    if (!item || item.status === "error") return "";
    await openOne(item);
    const secret = memory.get(id);
    if (!secret?.accessToken) {
      item.status = "reauth";
      item.error = "Esta conta precisa entrar de novo.";
      save();
      return "";
    }
    if (secret.expiresAt && secret.expiresAt <= now() + 60_000 && secret.refreshToken) {
      try { await refresh(id); } catch { return ""; }
    }
    const current = memory.get(id);
    return current?.accessToken ? `Bearer ${current.accessToken}` : "";
  }

  function view() {
    return {
      presets: PRESETS.map((item) => ({
        id: item.id,
        name: item.name,
        blurb: item.blurb,
        kind: item.kind,
        configured: isReady(item),
      })),
      connections: items.map(publicItem),
    };
  }

  return { ready, view, start, reconnect, cancel, rename, remove, refresh, authorization, file, PRESETS: view().presets };
}

module.exports = { createConectores, PRESETS, presetById, GITHUB_LOOPBACK_PORT };
