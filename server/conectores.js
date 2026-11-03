"use strict";

/**
 * Galeria de conectores. O token e o refresh ficam cifrados no cofre (o mesmo sealer do DPAPI).
 * A lista pública não devolve segredo nem client id. Várias contas do mesmo preset são registros separados.
 * O client id, quando o serviço exige, vem da configuração do aplicativo — nunca da tela.
 * Leva P: ClickUp/Vercel via MCP+OAuth (DCR+PKCE); GitHub via Device Flow; fallbacks só em Avançado.
 */
const path = require("node:path");
const { newId, readJson, writeJson } = require("./util");
const { findSecret } = require("./secret-scan");
const flow = require("./oauth-flow");
const { normalizeOAuthClients } = require("./oauth-clients");
const { beginGithubDevice, pollGithubDevice } = require("./github-device");
const { vercelWhoami } = require("./portfolio-runners");

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
    enterAs: "Entrar com ClickUp",
    mcpUrl: "https://mcp.clickup.com/mcp",
    scopes: ["read", "write"],
    featured: true,
  },
  {
    id: "github",
    name: "GitHub",
    blurb: "Repositórios e perfil.",
    kind: "github",
    clientKey: "github",
    enterAs: "Entrar com GitHub",
    mcpUrl: "https://api.githubcopilot.com/mcp/",
    scopes: ["read:user", "user:email", "repo"],
    includeResource: false,
    featured: true,
    authMode: "device",
  },
  {
    id: "vercel",
    name: "Vercel",
    blurb: "Deploy de projetos.",
    kind: "mcp",
    enterAs: "Entrar com Vercel",
    mcpUrl: "https://mcp.vercel.com",
    scopes: [],
    featured: true,
    allowTokenFallback: true,
    allowCliFallback: true,
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

const GITHUB_SETUP = Object.freeze({
  link: "https://github.com/settings/developers",
  passos: [
    "Em GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.",
    "Application name: HELIOS. Homepage: http://127.0.0.1. Authorization callback URL: http://127.0.0.1/callback (não usada no device flow).",
    "Copie só o Client ID (não precisa do secret — device flow não exige).",
    "Cole o Client ID em Avançado ou no campo de configuração do cartão GitHub.",
  ],
});

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
  if (err && err.code === "DCR") return `${text} Nada ficou conectado.`;
  if (/recusou o cadastro/i.test(text)) return "Este aplicativo recusou o HELIOS. Nada ficou conectado.";
  if (/403/.test(text)) return "O serviço recusou a conexão. Tente de novo mais tarde.";
  if (/tempo para autorizar/i.test(text)) return "O tempo para entrar acabou. Tente de novo.";
  if (/cancelad/i.test(text)) return "A entrada foi cancelada.";
  if (/não confere/i.test(text)) return "O retorno do navegador não confere. Tente de novo.";
  return text;
}

const GOOGLE_SETUP = Object.freeze({
  link: "https://console.cloud.google.com/auth/clients/create",
  prazo: "2026-11-11",
  passos: [
    "Crie um projeto no Google Cloud e ative a Gmail API.",
    "Em Público-alvo, deixe como Teste e adicione seus e-mails Gmail como testadores.",
    "Crie um cliente OAuth do tipo App para computador e marque a opção de agente de IA.",
    "Cole aqui o ID e a chave secreta do cliente.",
  ],
});
const GMAIL_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";

function createConectores({ dataDir, sealer = null, mcp, fetchImpl = globalThis.fetch, openExternal = null, listen = flow.listenLoopback, now = () => Date.now(), oauthClients = {}, getUserClients = () => ({}), log = () => {}, revokeUrl = null } = {}) {
  const file = path.join(dataDir, "conectores.json");
  const shippedClients = normalizeOAuthClients(oauthClients);
  /** Leva G/P: Google e GitHub client id podem vir do cofre (uma vez). */
  const clientsNow = () => {
    let user = {};
    try { user = getUserClients() || {}; } catch { user = {}; }
    const fromUser = normalizeOAuthClients({ google: user.google, github: user.github });
    const secret = String(user.googleSecret || "").trim();
    return {
      ...shippedClients,
      google: shippedClients.google || fromUser.google,
      googleSecret: shippedClients.google ? (oauthClients.googleSecret || "") : (fromUser.google ? secret : ""),
      github: shippedClients.github || fromUser.github || "",
    };
  };
  let items = readJson(file, []);
  if (!Array.isArray(items)) items = [];
  const memory = new Map();
  const pending = new Map();
  const sealerOn = () => Boolean(sealer && typeof sealer.available === "function" && sealer.available());

  function embedded(preset) {
    const clients = clientsNow();
    const id = preset.clientKey ? clients[preset.clientKey] || "" : "";
    let secret = preset.needsSecret ? clients.slackSecret || "" : "";
    if (preset.kind === "google") secret = clients.googleSecret || "";
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
      userCode: item.status === "waiting" && item.userCode ? String(item.userCode).slice(0, 20) : "",
      verificationUri: item.status === "waiting" && item.verificationUri ? String(item.verificationUri).slice(0, 200) : "",
      authMode: item.authMode || "",
      source: item.source || "oauth",
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

  function scopesFor(preset, metadata, item = null) {
    if (preset.scopes && preset.scopes.length) return item && item.compose && preset.id === "gmail" ? [...preset.scopes, GMAIL_COMPOSE] : preset.scopes;
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
    item.verificationUri = "";
    item.accountHint = token.accountHint || item.accountHint || "";
    item.tokenEndpoint = client.tokenEndpoint;
    item.clientId = client.clientId;
    if (!item.source) item.source = "oauth";
    await remember(item, secret);
    if (mcp && item.mcpUrl) {
      const linked = mcp.linkHttp({ name: `${item.presetId}-${item.id.slice(-4)}`, url: item.mcpUrl, connectionId: item.id });
      item.mcpId = linked.id;
      save();
    }
  }

  let vercelCliCache = { at: 0, value: { ok: false, user: "" } };
  function vercelCliStatus() {
    const age = now() - (vercelCliCache.at || 0);
    if (age >= 0 && age < 60_000) return vercelCliCache.value;
    try { vercelCliCache = { at: now(), value: vercelWhoami() }; } catch { vercelCliCache = { at: now(), value: { ok: false, user: "" } }; }
    return vercelCliCache.value;
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
        let registered;
        try {
          registered = await flow.registerClient(metadata, loop.redirectUri, fetchImpl);
        } catch (err) {
          log(`[conectores] ${preset.id}: cadastro dinâmico recusado (${flow.safeError(err)})`);
          throw Object.assign(new Error(`${preset.name} recusou o cadastro do HELIOS.`), { status: 502, code: "DCR" });
        }
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
        scopes: scopesFor(preset, metadata, item),
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

  /** Leva P: GitHub Device Flow — mostra código curto e abre github.com/login/device. Sem secret. */
  async function runGithubDeviceFlow(item, preset, signal) {
    const got = embedded(preset);
    if (!got.id) throw Object.assign(new Error("Configure o Client ID do OAuth App do GitHub (uma vez)."), { status: 409, code: "SETUP" });
    const started = await beginGithubDevice({
      clientId: got.id,
      scopes: scopesFor(preset, { scopes: preset.scopes || [] }, item),
      fetchImpl,
    });
    item.userCode = started.userCode;
    item.verificationUri = started.verificationUri;
    item.authMode = "device";
    save();
    if (openExternal) {
      try { await openExternal(started.verificationUri); } catch { /* usuário abre manualmente */ }
    }
    const token = await pollGithubDevice({
      clientId: got.id,
      deviceCode: started.deviceCode,
      intervalMs: started.intervalMs,
      fetchImpl,
      signal,
    });
    // Tenta enriquecer accountHint com /user se o token já não trouxe login
    if (!token.accountHint) {
      try {
        const res = await fetchImpl("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "HELIOS" },
        });
        if (res.ok) {
          const body = await res.json();
          if (body && body.login) token.accountHint = String(body.login).slice(0, 80);
        }
      } catch { /* opcional */ }
    }
    item.userCode = "";
    item.verificationUri = "";
    await finish(item, token, { clientId: got.id, clientSecret: "", tokenEndpoint: started.tokenEndpoint });
    item.source = "device";
    item.authMode = "device";
    save();
  }

  function defaultLabel(preset) {
    const count = items.filter((item) => item.presetId === preset.id).length;
    return count === 0 ? "pessoal" : `conta ${count + 1}`;
  }

  function launch(item, preset) {
    const controller = new AbortController();
    pending.set(item.id, controller);
    const runner = preset.authMode === "device" || (preset.kind === "github" && preset.authMode !== "code")
      ? () => runGithubDeviceFlow(item, preset, controller.signal)
      : () => runCodeFlow(item, preset);
    const job = runner()
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
      compose: preset.id === "gmail" && input.compose === true,
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

  async function tryRevoke(item) {
    const secret = memory.get(item.id);
    if (!secret?.accessToken) return;
    const endpoint = revokeUrl || item.revokeEndpoint || "";
    if (!endpoint) return;
    try {
      await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          token: secret.accessToken,
          client_id: secret.clientId || item.clientId || "",
        }).toString(),
      });
    } catch {
      /* revogação best-effort; apaga do cofre mesmo assim */
    }
  }

  function remove(id) {
    const item = items.find((entry) => entry.id === id);
    if (!item) return false;
    pending.get(id)?.abort();
    // Revoga em background; não bloqueia a UI e nunca loga o token.
    tryRevoke(item).catch(() => {});
    items = items.filter((entry) => entry.id !== id);
    memory.delete(id);
    if (item.mcpId && mcp) mcp.remove(item.mcpId);
    save();
    return true;
  }

  /**
   * Fallback Avançado: cola PAT/token único (GitHub/Vercel/ClickUp).
   * Guarda só no cofre (sealer); nunca devolve o valor.
   */
  async function saveManualToken(presetId, token, input = {}) {
    const preset = presetById(presetId);
    if (!preset) throw Object.assign(new Error("Conector desconhecido."), { status: 404 });
    const value = String(token || "").trim();
    if (value.length < 8) throw Object.assign(new Error("Cole um token válido."), { status: 400 });
    if (findSecret(String(input.label || ""))) throw Object.assign(new Error("O nome parece conter uma chave."), { status: 400 });
    const label = cleanLabel(input.label, defaultLabel(preset));
    const item = {
      id: newId("con"),
      presetId: preset.id,
      label,
      status: "connected",
      accountHint: input.accountHint || "token manual",
      error: "",
      userCode: "",
      mcpUrl: preset.mcpUrl || "",
      mcpId: "",
      clientId: "",
      tokenEndpoint: "",
      secretsEnc: "",
      persisted: false,
      source: "token",
      authMode: "token",
    };
    items.push(item);
    await finish(item, {
      accessToken: value,
      refreshToken: "",
      expiresAt: null,
      scope: "",
      accountHint: item.accountHint,
    }, { clientId: "", clientSecret: "", tokenEndpoint: "" });
    item.source = "token";
    item.authMode = "token";
    save();
    return publicItem(item);
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

  // LEVA P3: OAuth MCP (ClickUp/GitHub/Vercel) incompleto — UI só com HELIOS_OAUTH_MCP_UI=1.
  const oauthMcpUi = process.env.HELIOS_OAUTH_MCP_UI === "1";

  function view() {
    const vercelCli = vercelCliStatus();
    return {
      oauthMcpUi,
      presets: PRESETS.map((item) => ({
        id: item.id,
        name: item.name,
        blurb: item.blurb,
        kind: item.kind,
        enterAs: item.enterAs || "Conectar",
        featured: item.featured === true,
        oauthUi: oauthMcpUi && item.featured === true,
        configured: isReady(item),
        setup: item.kind === "google" && !isReady(item) ? "google"
          : (item.kind === "github" && !isReady(item) && oauthMcpUi ? "github" : ""),
        googleSetup: item.kind === "google" && !isReady(item) ? GOOGLE_SETUP : undefined,
        githubSetup: item.kind === "github" && !isReady(item) && oauthMcpUi ? GITHUB_SETUP : undefined,
        allowTokenFallback: item.allowTokenFallback === true || item.id === "github" || item.id === "clickup" || item.id === "vercel",
        allowCliFallback: item.allowCliFallback === true,
        authMode: item.authMode || (item.kind === "github" ? "device" : "code"),
      })),
      googleSetup: GOOGLE_SETUP,
      githubSetup: GITHUB_SETUP,
      vercelCli: { disponivel: vercelCli.ok === true, user: vercelCli.user || "" },
      connections: items.map(publicItem),
    };
  }

  /** Contas conectadas de um serviço (para o processo principal ler o Gmail). Sem segredo. */
  const connected = (presetId) => items.filter((item) => item.presetId === presetId && item.status === "connected").map((item) => ({ id: item.id, label: item.label, accountHint: item.accountHint || "" }));

  /** Bearer/token cru para agentes (Oasis/Portfólio). Nunca logar. */
  async function accessToken(presetId) {
    const list = items.filter((item) => item.presetId === presetId && (item.status === "connected" || item.status === "reauth"));
    for (const item of list) {
      const header = await authorization(item.id);
      if (!header) continue;
      return header.replace(/^Bearer\s+/i, "");
    }
    return "";
  }

  return {
    ready, view, connected, start, reconnect, cancel, rename, remove, refresh, authorization,
    saveManualToken, accessToken, tryRevoke, file, PRESETS: view().presets,
  };
}

module.exports = { createConectores, PRESETS, presetById, GITHUB_LOOPBACK_PORT, GOOGLE_SETUP, GITHUB_SETUP };
