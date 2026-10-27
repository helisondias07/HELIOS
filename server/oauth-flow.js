"use strict";

/**
 * OAuth 2.1 do jeito que o MCP pede: descoberta, cadastro dinâmico quando existe,
 * PKCE S256 e redirect só em 127.0.0.1. Não guarda token. Não registra segredo em log.
 */
const crypto = require("node:crypto");
const http = require("node:http");
const { redact } = require("./util");

const CALLBACK_PATH = "/callback";

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

function randomState() {
  return base64url(crypto.randomBytes(24));
}

function sameState(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function httpsUrl(value, label) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { throw Object.assign(new Error(`${label} inválido.`), { status: 502 }); }
  if (parsed.protocol !== "https:") throw Object.assign(new Error(`${label} precisa ser https.`), { status: 502 });
  return parsed.toString();
}

function resourceMetadataUrl(header, mcpUrl) {
  const match = /resource_metadata="([^"]+)"/i.exec(String(header || ""));
  if (match) return httpsUrl(match[1], "O endereço de descoberta");
  const url = new URL(mcpUrl);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

function authorizationMetadataUrls(issuer) {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  const inserted = `${url.origin}/.well-known/oauth-authorization-server${path}`;
  const suffix = `${url.origin}${path}/.well-known/oauth-authorization-server`;
  return [...new Set([inserted, suffix])];
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 180) }; }
}

function failStatus(res, what) {
  const err = new Error(`${what} respondeu ${res.status}.`);
  err.status = 502;
  return err;
}

async function discover(mcpUrl, fetchImpl) {
  const resource = httpsUrl(mcpUrl, "A URL do conector");
  const probe = await fetchImpl(resource, { method: "GET", headers: { accept: "application/json" }, redirect: "manual" });
  const metadataUrl = resourceMetadataUrl(probe.headers.get("www-authenticate"), resource);
  const metaRes = await fetchImpl(metadataUrl, { headers: { accept: "application/json" } });
  if (!metaRes.ok) throw failStatus(metaRes, "A descoberta do conector");
  const meta = await readJson(metaRes);
  const issuer = Array.isArray(meta.authorization_servers) ? meta.authorization_servers[0] : "";
  if (!issuer) throw Object.assign(new Error("O conector não informou um servidor de autorização."), { status: 502 });
  let as = null;
  let last = 0;
  for (const candidate of authorizationMetadataUrls(issuer)) {
    const res = await fetchImpl(candidate, { headers: { accept: "application/json" } });
    last = res.status;
    if (!res.ok) continue;
    as = await readJson(res);
    break;
  }
  if (!as && /accounts\.google\.com/i.test(issuer)) {
    const res = await fetchImpl("https://accounts.google.com/.well-known/openid-configuration", { headers: { accept: "application/json" } });
    if (res.ok) as = await readJson(res);
  }
  if (!as || !as.authorization_endpoint || !as.token_endpoint) {
    throw Object.assign(new Error(`Não achei os endereços de autorização desse conector (${last || "sem resposta"}).`), { status: 502 });
  }
  httpsUrl(as.authorization_endpoint, "A página de autorização");
  httpsUrl(as.token_endpoint, "O endereço do token");
  if (as.registration_endpoint) httpsUrl(as.registration_endpoint, "O cadastro do cliente");
  return {
    resource: meta.resource || resource,
    scopes: Array.isArray(meta.scopes_supported) ? meta.scopes_supported.map(String) : [],
    issuer,
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint || "",
    deviceEndpoint: as.device_authorization_endpoint || "",
    methods: as.code_challenge_methods_supported || [],
  };
}

async function registerClient(metadata, redirectUri, fetchImpl) {
  if (!metadata.registrationEndpoint) throw Object.assign(new Error("Este conector não aceita cadastro automático. Falta um client id."), { status: 400 });
  const res = await fetchImpl(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "HELIOS",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = await readJson(res);
  if (!res.ok || !body.client_id) throw Object.assign(new Error("O conector recusou o cadastro do HELIOS. Nada foi salvo."), { status: 502 });
  return { clientId: String(body.client_id), clientSecret: body.client_secret ? String(body.client_secret) : "" };
}

function authorizeUrl({ metadata, clientId, redirectUri, challenge, state, scopes, google = false }) {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (scopes.length) url.searchParams.set("scope", scopes.join(" "));
  if (!google) url.searchParams.set("resource", metadata.resource);
  if (google) {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }
  return url.toString();
}

async function postForm(url, fields, fetchImpl) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value) body.set(key, value);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  const payload = await readJson(res);
  return { ok: res.ok, status: res.status, payload };
}

function tokenFrom(payload) {
  if (!payload || !payload.access_token) return null;
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: String(payload.access_token),
    refreshToken: payload.refresh_token ? String(payload.refresh_token) : "",
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    scope: payload.scope ? String(payload.scope) : "",
    accountHint: emailFrom(payload),
  };
}

function emailFrom(payload) {
  const direct = payload.email || payload.user_email || "";
  if (direct) return String(direct).slice(0, 120);
  const token = String(payload.id_token || "");
  const part = token.split(".")[1];
  if (!part) return "";
  try {
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return json.email ? String(json.email).slice(0, 120) : "";
  } catch {
    return "";
  }
}

async function exchangeCode({ tokenEndpoint, clientId, clientSecret, code, redirectUri, verifier, fetchImpl }) {
  const { ok, payload } = await postForm(tokenEndpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: verifier,
  }, fetchImpl);
  const token = ok ? tokenFrom(payload) : null;
  if (!token) throw Object.assign(new Error("A troca do código não devolveu um acesso. Nada foi salvo."), { status: 502 });
  return token;
}

async function refreshAccess({ tokenEndpoint, clientId, clientSecret, refreshToken, fetchImpl }) {
  const { ok, status, payload } = await postForm(tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }, fetchImpl);
  if (!ok) {
    const invalid = payload.error === "invalid_grant" || status === 400 || status === 401;
    throw Object.assign(new Error(invalid ? "A sessão expirou. Conecte de novo." : "Não consegui renovar o acesso."), { status: invalid ? 401 : 502, code: invalid ? "REAUTH" : "REFRESH" });
  }
  const token = tokenFrom(payload);
  if (!token) throw Object.assign(new Error("A renovação não devolveu um acesso."), { status: 502, code: "REFRESH" });
  if (!token.refreshToken) token.refreshToken = refreshToken;
  return token;
}

function listenLoopback({ timeoutMs = 5 * 60 * 1000 } = {}) {
  let settled;
  const done = new Promise((resolve, reject) => { settled = { resolve, reject }; });
  const server = http.createServer((req, res) => {
    let parsed;
    try { parsed = new URL(req.url, "http://127.0.0.1"); } catch { parsed = null; }
    const finish = (status, text) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!doctype html><meta charset="utf-8"><title>HELIOS</title><p>${text}</p>`);
    };
    if (!parsed || req.method !== "GET" || parsed.pathname !== CALLBACK_PATH) {
      finish(404, "Endereço inesperado.");
      return;
    }
    const error = parsed.searchParams.get("error");
    if (error) {
      finish(200, "A autorização foi cancelada. Pode fechar esta aba e voltar ao HELIOS.");
      settled.reject(Object.assign(new Error("A autorização foi cancelada."), { status: 400 }));
      server.close();
      return;
    }
    const code = parsed.searchParams.get("code") || "";
    const state = parsed.searchParams.get("state") || "";
    if (!code || !state) {
      finish(400, "Faltou o código de retorno.");
      return;
    }
    finish(200, "Pode fechar esta aba e voltar ao HELIOS.");
    settled.resolve({ code, state });
    server.close();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const timer = setTimeout(() => {
        settled.reject(Object.assign(new Error("O tempo para autorizar acabou."), { status: 408 }));
        server.close();
      }, timeoutMs);
      if (timer.unref) timer.unref();
      resolve({
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        wait: () => done.finally(() => clearTimeout(timer)),
        close: () => server.close(),
      });
    });
  });
}

async function beginDevice({ metadata, clientId, scopes, fetchImpl }) {
  if (!metadata.deviceEndpoint) throw Object.assign(new Error("Este conector não tem fluxo de dispositivo."), { status: 400 });
  const { ok, payload } = await postForm(metadata.deviceEndpoint, {
    client_id: clientId,
    scope: scopes.join(" "),
  }, fetchImpl);
  if (!ok || !payload.device_code || !payload.user_code) {
    throw Object.assign(new Error("O conector não abriu o fluxo de dispositivo."), { status: 502 });
  }
  return {
    deviceCode: String(payload.device_code),
    userCode: String(payload.user_code).slice(0, 20),
    verificationUri: httpsUrl(payload.verification_uri || payload.verification_url, "A página de verificação"),
    intervalMs: (Number(payload.interval) > 0 ? Number(payload.interval) : 5) * 1000,
  };
}

async function pollDevice({ tokenEndpoint, clientId, deviceCode, intervalMs, fetchImpl, signal, deadlineMs = 5 * 60 * 1000 }) {
  let wait = intervalMs;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error("Conexão cancelada."), { status: 400 });
    if (Date.now() > deadline) throw Object.assign(new Error("O tempo para autorizar acabou."), { status: 408 });
    await new Promise((resolve) => setTimeout(resolve, wait));
    const { ok, payload } = await postForm(tokenEndpoint, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: clientId,
    }, fetchImpl);
    if (ok) {
      const token = tokenFrom(payload);
      if (!token) throw Object.assign(new Error("O dispositivo não devolveu um acesso."), { status: 502 });
      return token;
    }
    if (payload.error === "authorization_pending") continue;
    if (payload.error === "slow_down") { wait += 5000; continue; }
    throw Object.assign(new Error(payload.error === "access_denied" ? "A autorização foi negada." : "O código do dispositivo expirou."), { status: 400 });
  }
}

function safeError(err) {
  return redact(String(err && err.message ? err.message : err)).slice(0, 240);
}

module.exports = {
  pkce,
  randomState,
  sameState,
  discover,
  registerClient,
  authorizeUrl,
  exchangeCode,
  refreshAccess,
  listenLoopback,
  beginDevice,
  pollDevice,
  safeError,
  CALLBACK_PATH,
};
