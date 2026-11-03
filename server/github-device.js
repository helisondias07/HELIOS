"use strict";

/**
 * GitHub OAuth Device Flow (sem client_secret).
 * Endpoints fixos do GitHub — o MCP remoto não oferece DCR.
 * client_id vem de um OAuth App criado uma vez pelo usuário (não é segredo).
 */
const { postForm, tokenFrom, safeError } = (() => {
  // Reusa postForm/tokenFrom do oauth-flow sem circularidade: duplica o mínimo.
  const { redact } = require("./util");
  async function readJson(res) {
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { raw: text.slice(0, 180) }; }
  }
  async function postForm(url, fields, fetchImpl) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) if (value) body.set(key, value);
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
    return { ok: res.ok, status: res.status, payload: await readJson(res) };
  }
  function emailFrom(payload) {
    const direct = payload.email || payload.user_email || payload.login || "";
    return direct ? String(direct).slice(0, 120) : "";
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
  return {
    postForm,
    tokenFrom,
    safeError: (err) => redact(String(err && err.message ? err.message : err)).slice(0, 240),
  };
})();

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const VERIFY_URL = "https://github.com/login/device";

async function beginGithubDevice({ clientId, scopes = [], fetchImpl = globalThis.fetch } = {}) {
  const id = String(clientId || "").trim();
  if (!id) throw Object.assign(new Error("Falta o client id do OAuth App do GitHub."), { status: 409, code: "SETUP" });
  const { ok, payload } = await postForm(DEVICE_CODE_URL, {
    client_id: id,
    scope: (scopes || []).join(" "),
  }, fetchImpl);
  if (!ok || !payload.device_code || !payload.user_code) {
    const msg = payload.error_description || payload.error || "GitHub não abriu o fluxo de dispositivo.";
    throw Object.assign(new Error(String(msg).slice(0, 160)), { status: 502 });
  }
  return {
    deviceCode: String(payload.device_code),
    userCode: String(payload.user_code).slice(0, 20),
    verificationUri: String(payload.verification_uri || payload.verification_uri_complete || VERIFY_URL).slice(0, 200),
    intervalMs: Math.max(50, (Number.isFinite(Number(payload.interval)) ? Number(payload.interval) : 5) * 1000),
    tokenEndpoint: TOKEN_URL,
  };
}

async function pollGithubDevice({
  clientId,
  deviceCode,
  intervalMs = 5000,
  fetchImpl = globalThis.fetch,
  signal = null,
  deadlineMs = 5 * 60 * 1000,
} = {}) {
  let wait = Math.max(50, Number(intervalMs) || 5000);
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error("Conexão cancelada."), { status: 400 });
    if (Date.now() > deadline) throw Object.assign(new Error("O tempo para autorizar acabou."), { status: 408 });
    await new Promise((resolve) => setTimeout(resolve, wait));
    const { ok, payload } = await postForm(TOKEN_URL, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: clientId,
    }, fetchImpl);
    if (ok && payload.access_token) {
      const token = tokenFrom(payload);
      if (!token) throw Object.assign(new Error("GitHub não devolveu um acesso."), { status: 502 });
      return token;
    }
    const err = String(payload.error || "");
    if (err === "authorization_pending") continue;
    if (err === "slow_down") { wait += 5000; continue; }
    if (err === "access_denied") throw Object.assign(new Error("A autorização foi negada."), { status: 400 });
    if (err === "expired_token") throw Object.assign(new Error("O código do dispositivo expirou."), { status: 400 });
    throw Object.assign(new Error(payload.error_description || err || "Falha no device flow."), { status: 400 });
  }
}

module.exports = {
  beginGithubDevice,
  pollGithubDevice,
  DEVICE_CODE_URL,
  TOKEN_URL,
  VERIFY_URL,
  safeError,
};
