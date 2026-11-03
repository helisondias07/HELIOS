"use strict";

/**
 * Cliente MCP remoto (Streamable HTTP) com Bearer OAuth.
 * Em 401 tenta refresh via `refreshAuth` e repete uma vez.
 * Tokens nunca entram em log — só o header Authorization em memória.
 */
const { connectMcp, mcpResultText } = require("./mcp-client");

async function withRemoteMcp(url, {
  getAuthorization,
  refreshAuth = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
} = {}) {
  const target = String(url || "").trim();
  if (!/^https:\/\//i.test(target) && !/^http:\/\/127\.0\.0\.1(?::\d+)?\//i.test(target)) {
    throw Object.assign(new Error("URL MCP remota inválida."), { status: 400 });
  }

  async function authHeader() {
    const raw = typeof getAuthorization === "function" ? await getAuthorization() : "";
    const text = String(raw || "").trim();
    if (!text) return "";
    return /^bearer\s+/i.test(text) ? text : `Bearer ${text}`;
  }

  async function open() {
    const bearer = await authHeader();
    const headers = bearer ? { Authorization: bearer } : {};
    return connectMcp("remote", { type: "http", url: target, headers }, { timeoutMs, fetchImpl });
  }

  async function run(fn) {
    let conn;
    try {
      conn = await open();
      return await fn(conn);
    } catch (err) {
      const status = err && (err.status || err.code);
      if ((status === 401 || status === 403) && typeof refreshAuth === "function") {
        try { await refreshAuth(); } catch { /* refresh falhou — propaga o 401 original */ }
        try { if (conn) conn.close(); } catch { /* */ }
        conn = await open();
        return await fn(conn);
      }
      throw err;
    } finally {
      try { if (conn) conn.close(); } catch { /* */ }
    }
  }

  return {
    listTools: () => run(async (conn) => conn.tools || []),
    callTool: (name, args) => run(async (conn) => {
      const result = await conn.call(name, args || {});
      return { text: mcpResultText(result), raw: result };
    }),
  };
}

module.exports = { withRemoteMcp, mcpResultText };
