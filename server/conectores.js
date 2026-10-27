"use strict";

/**
 * Galeria de conectores. O token e o refresh ficam cifrados no cofre (o mesmo sealer do DPAPI).
 * A lista pública não devolve segredo. Várias contas do mesmo preset são registros separados.
 */
const path = require("node:path");
const { newId, readJson, writeJson } = require("./util");
const { findSecret } = require("./secret-scan");
const flow = require("./oauth-flow");

const PRESETS = [
  {
    id: "cursor",
    name: "Cursor",
    blurb: "Entra pelo navegador com o login oficial do SDK. Sem chave colada.",
    needsClientId: false,
    kind: "cursor",
  },
  {
    id: "gmail",
    name: "Gmail",
    blurb: "Lê a caixa. Várias contas Google, cada uma com o próprio nome.",
    needsClientId: true,
    clientHint: "Client id do app Desktop (….apps.googleusercontent.com)",
    kind: "google",
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
    limitation: "O Google não deixa um aplicativo de terceiros se cadastrar sozinho. Crie um cliente OAuth do tipo computador no Google Cloud e cole só o client id. O HELIOS não pede client secret: o retorno é PKCE em 127.0.0.1. O escopo é só leitura.",
  },
  {
    id: "clickup",
    name: "ClickUp",
    blurb: "Tarefas e documentos. O cadastro do HELIOS é automático.",
    needsClientId: false,
    kind: "mcp",
    mcpUrl: "https://mcp.clickup.com/mcp",
    scopes: ["read", "write"],
  },
  {
    id: "linear",
    name: "Linear",
    blurb: "Issues. O cadastro do HELIOS é automático.",
    needsClientId: false,
    kind: "mcp",
    mcpUrl: "https://mcp.linear.app/mcp",
    scopes: ["read", "write"],
  },
  {
    id: "github",
    name: "GitHub",
    blurb: "Repositórios. Você cola o client id de um OAuth App.",
    needsClientId: true,
    clientHint: "Client id do OAuth App",
    kind: "device",
    mcpUrl: "https://api.githubcopilot.com/mcp/",
    scopes: ["read:user", "user:email", "repo"],
    limitation: "O GitHub não oferece cadastro dinâmico. Crie um OAuth App e cole só o client id. O HELIOS abre o fluxo de dispositivo (um código curto na tela) e não guarda client secret.",
  },
  {
    id: "figma",
    name: "Figma",
    blurb: "Arquivos. O cadastro é tentado; a Figma pode recusar.",
    needsClientId: false,
    kind: "mcp",
    mcpUrl: "https://mcp.figma.com/mcp",
    scopes: ["mcp:connect"],
    limitation: "A Figma publica cadastro dinâmico, mas só libera clientes do catálogo dela. Se recusar, o cartão mostra o erro e nada fica conectado.",
  },
  {
    id: "notion",
    name: "Notion",
    blurb: "Páginas. Depende da descoberta OAuth responder.",
    needsClientId: false,
    kind: "mcp",
    mcpUrl: "https://mcp.notion.com/mcp",
    scopes: [],
    limitation: "A descoberta da Notion às vezes responde 403. Nesse caso o HELIOS avisa e não inventa um token.",
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

function cleanClientId(preset, raw) {
  const value = String(raw || "").trim();
  if (!preset.needsClientId) return "";
  if (!value) throw Object.assign(new Error(`Para ${preset.name}, cole o client id. O HELIOS não traz um embutido.`), { status: 400 });
  if (/\s/.test(value) || value.length > 200 || /secret|gsk_|crsr_|cursor_/i.test(value)) {
    throw Object.assign(new Error("Isso não parece um client id. Não cole chave nem client secret."), { status: 400 });
  }
  if (preset.kind === "google" && !/\.apps\.googleusercontent\.com$/i.test(value)) {
    throw Object.assign(new Error("O client id do Gmail termina em .apps.googleusercontent.com."), { status: 400 });
  }
  return value;
}

function createConectores({ dataDir, sealer = null, mcp, fetchImpl = globalThis.fetch, openExternal = null, listen = flow.listenLoopback, now = () => Date.now() } = {}) {
  const file = path.join(dataDir, "conectores.json");
  let items = readJson(file, []);
  if (!Array.isArray(items)) items = [];
  const memory = new Map();
  const pending = new Map();
  const sealerOn = () => Boolean(sealer && typeof sealer.available === "function" && sealer.available());

  function publicItem(item) {
    const secret = memory.get(item.id);
    return {
      id: item.id,
      presetId: item.presetId,
      label: item.label,
      status: item.status,
      accountHint: item.accountHint || "",
      error: item.error || "",
      userCode: item.userCode || "",
      needsClientId: Boolean(presetById(item.presetId)?.needsClientId),
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
    item.error = flow.safeError(err);
    item.userCode = "";
    save();
  }

  async function runCodeFlow(item, preset, clientId) {
    const loop = await listen({ timeoutMs: 5 * 60 * 1000 });
    try {
      const metadata = await flow.discover(preset.mcpUrl, fetchImpl);
      const redirectUri = loop.redirectUri;
      let clientSecret = "";
      let usedClient = clientId;
      if (metadata.registrationEndpoint && !preset.needsClientId) {
        const registered = await flow.registerClient(metadata, redirectUri, fetchImpl);
        usedClient = registered.clientId;
        clientSecret = registered.clientSecret;
      }
      const code = flow.pkce();
      const state = flow.randomState();
      const url = flow.authorizeUrl({
        metadata,
        clientId: usedClient,
        redirectUri,
        challenge: code.challenge,
        state,
        scopes: scopesFor(preset, metadata),
        google: preset.kind === "google",
      });
      item.authorizeUrl = url;
      if (openExternal) await openExternal(url);
      const back = await loop.wait();
      if (!flow.sameState(back.state, state)) throw Object.assign(new Error("O retorno do navegador não confere."), { status: 400 });
      const token = await flow.exchangeCode({
        tokenEndpoint: metadata.tokenEndpoint,
        clientId: usedClient,
        clientSecret,
        code: back.code,
        redirectUri,
        verifier: code.verifier,
        fetchImpl,
      });
      await finish(item, token, { clientId: usedClient, clientSecret, tokenEndpoint: metadata.tokenEndpoint });
    } finally {
      loop.close();
    }
  }

  async function runDeviceFlow(item, preset, clientId) {
    const metadata = await flow.discover(preset.mcpUrl, fetchImpl);
    const device = await flow.beginDevice({ metadata, clientId, scopes: scopesFor(preset, metadata), fetchImpl });
    item.userCode = device.userCode;
    item.status = "waiting";
    save();
    if (openExternal) await openExternal(device.verificationUri);
    const controller = pending.get(item.id);
    const token = await flow.pollDevice({
      tokenEndpoint: metadata.tokenEndpoint,
      clientId,
      deviceCode: device.deviceCode,
      intervalMs: device.intervalMs,
      fetchImpl,
      signal: controller?.signal,
    });
    await finish(item, token, { clientId, clientSecret: "", tokenEndpoint: metadata.tokenEndpoint });
  }

  function start(presetId, input = {}) {
    const preset = presetById(presetId);
    if (!preset || preset.kind === "cursor") throw Object.assign(new Error("Conector desconhecido."), { status: 404 });
    const clientId = cleanClientId(preset, input.clientId);
    const label = cleanLabel(input.label, `${preset.name} ${items.filter((item) => item.presetId === preset.id).length + 1}`);
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
      clientId,
      tokenEndpoint: "",
      secretsEnc: "",
      persisted: false,
    };
    items.push(item);
    save();
    const controller = new AbortController();
    pending.set(item.id, controller);
    const job = (preset.kind === "device" ? runDeviceFlow(item, preset, clientId) : runCodeFlow(item, preset, clientId))
      .catch((err) => { if (item.status === "waiting") fail(item, err); })
      .finally(() => pending.delete(item.id));
    job.catch(() => {});
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
        needsClientId: item.needsClientId,
        clientHint: item.clientHint || "",
        limitation: item.limitation || "",
        kind: item.kind,
      })),
      connections: items.map(publicItem),
    };
  }

  return { ready, view, start, cancel, rename, remove, refresh, authorization, file, PRESETS: view().presets };
}

module.exports = { createConectores, PRESETS, presetById };
