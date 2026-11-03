"use strict";

/**
 * Servidor OAuth 2.1 + MCP mock local (DCR, PKCE, refresh, 401, device flow).
 * Sem rede real. Para test/levaP.test.js.
 */
const http = require("node:http");
const crypto = require("node:crypto");

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(text);
}

function form(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const params = new URLSearchParams(raw);
      const out = {};
      for (const [k, v] of params) out[k] = v;
      resolve(out);
    });
  });
}

function createOauthMcpMock({
  dcrAccept = true,
  dcrError = "invalid_redirect_uri",
  requirePkce = true,
  deviceFlow = true,
  resource = "http://127.0.0.1/mcp",
} = {}) {
  const clients = new Map();
  const codes = new Map();
  const refresh = new Map();
  const devices = new Map();
  let accessSeq = 0;
  let force401 = false;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;

    if (req.method === "GET" && path === "/.well-known/oauth-protected-resource") {
      return json(res, 200, {
        resource,
        authorization_servers: [`http://127.0.0.1:${server.address().port}`],
        scopes_supported: ["read", "write"],
      });
    }
    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      const base = `http://127.0.0.1:${server.address().port}`;
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        device_authorization_endpoint: deviceFlow ? `${base}/oauth/device` : undefined,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (req.method === "POST" && path === "/oauth/register") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!dcrAccept) return json(res, 400, { error: dcrError, error_description: "redirect not allowlisted" });
      const id = `client-${crypto.randomBytes(4).toString("hex")}`;
      clients.set(id, { redirect: (body.redirect_uris || [])[0] || "", secret: "" });
      return json(res, 201, { client_id: id, token_endpoint_auth_method: "none" });
    }
    if (req.method === "GET" && path === "/oauth/authorize") {
      const clientId = url.searchParams.get("client_id");
      const redirect = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      if (requirePkce && !challenge) {
        res.writeHead(400); res.end("pkce"); return;
      }
      const code = `code-${crypto.randomBytes(6).toString("hex")}`;
      codes.set(code, { clientId, redirect, challenge, verifier: null });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state || "");
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }
    if (req.method === "POST" && path === "/oauth/device") {
      const body = await form(req);
      const device = `dev-${crypto.randomBytes(6).toString("hex")}`;
      const user = `ABCD-EFGH`;
      devices.set(device, { clientId: body.client_id, approved: true, user });
      return json(res, 200, {
        device_code: device,
        user_code: user,
        verification_uri: `http://127.0.0.1:${server.address().port}/device`,
        interval: 0,
        expires_in: 300,
      });
    }
    if (req.method === "POST" && path === "/oauth/token") {
      const body = await form(req);
      if (body.grant_type === "authorization_code") {
        const entry = codes.get(body.code);
        if (!entry) return json(res, 400, { error: "invalid_grant" });
        if (requirePkce && body.code_verifier) {
          const challenge = crypto.createHash("sha256").update(body.code_verifier).digest("base64")
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
          if (challenge !== entry.challenge) return json(res, 400, { error: "invalid_grant" });
        }
        codes.delete(body.code);
        accessSeq += 1;
        const access = `access-mock-${accessSeq}`;
        const ref = `refresh-mock-${accessSeq}`;
        refresh.set(ref, { clientId: body.client_id });
        return json(res, 200, {
          access_token: access,
          refresh_token: ref,
          expires_in: 3600,
          token_type: "Bearer",
          email: "mock@exemplo.test",
        });
      }
      if (body.grant_type === "refresh_token") {
        if (!refresh.has(body.refresh_token)) return json(res, 400, { error: "invalid_grant" });
        accessSeq += 1;
        return json(res, 200, {
          access_token: `access-mock-${accessSeq}`,
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        const entry = devices.get(body.device_code);
        if (!entry) return json(res, 400, { error: "expired_token" });
        if (!entry.approved) return json(res, 400, { error: "authorization_pending" });
        devices.delete(body.device_code);
        accessSeq += 1;
        return json(res, 200, {
          access_token: `access-mock-${accessSeq}`,
          token_type: "bearer",
          scope: "repo",
          login: "mock-user",
        });
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (req.method === "POST" && path === "/mcp") {
      const auth = String(req.headers.authorization || "");
      if (force401 || !/^Bearer\s+access-mock-/i.test(auth)) {
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="http://127.0.0.1:${server.address().port}/.well-known/oauth-protected-resource"`,
        });
        res.end();
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const msg = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (msg.method === "initialize") {
        return json(res, 200, {
          jsonrpc: "2.0",
          id: msg.id,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock-mcp", version: "1" } },
        }, { "mcp-session-id": "sess-mock" });
      }
      if (msg.method === "tools/list") {
        return json(res, 200, {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [
              { name: "clickup_list_assigned_tasks", description: "List assigned" },
              { name: "clickup_add_comment", description: "Comment" },
              { name: "clickup_update_status", description: "Status" },
              { name: "create_repository", description: "GitHub create repo" },
            ],
          },
        });
      }
      if (msg.method === "tools/call") {
        const name = msg.params?.name;
        let text = "{}";
        if (/assigned|list.*task/i.test(name)) {
          text = JSON.stringify({
            tasks: [{ id: "t-1", name: "Tarefa mock", description: "repo: demo", status: "open", url: "https://app.clickup.com/t/t-1" }],
          });
        } else if (/comment/i.test(name)) text = JSON.stringify({ ok: true });
        else if (/status/i.test(name)) text = JSON.stringify({ ok: true, status: msg.params?.arguments?.status });
        else if (/create.*repo|repo/i.test(name)) text = `https://github.com/mock/${msg.params?.arguments?.name || "repo"}`;
        return json(res, 200, {
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text }] },
        });
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202); res.end(); return;
      }
      return json(res, 200, { jsonrpc: "2.0", id: msg.id, result: {} });
    }
    // Probe MCP URL for discovery (conectores.discover)
    if (req.method === "GET" && path === "/mcp") {
      res.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="http://127.0.0.1:${server.address().port}/.well-known/oauth-protected-resource"`,
      });
      res.end();
      return;
    }
    json(res, 404, { error: "not_found", path });
  });

  return {
    listen: () => new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      server.once("error", reject);
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    url: (pathName = "") => {
      const port = server.address()?.port;
      return `http://127.0.0.1:${port}${pathName}`;
    },
    setForce401: (v) => { force401 = Boolean(v); },
    setDcrAccept: (v) => { dcrAccept = Boolean(v); },
    clients,
  };
}

module.exports = { createOauthMcpMock };
