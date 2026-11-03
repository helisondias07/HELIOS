"use strict";

/**
 * Runners reais (com aprovação) para Portfólio: GitHub via MCP/token e Vercel via CLI ou token.
 * Nunca lê token de outros apps; nunca loga segredos.
 */
const { spawnSync } = require("node:child_process");
const { withRemoteMcp } = require("./mcp-remote-auth");

const GITHUB_MCP = "https://api.githubcopilot.com/mcp/";

function redactErr(err) {
  return String(err && err.message ? err.message : err).replace(/ghp_[A-Za-z0-9]+|gho_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+/gi, "[redacted]").slice(0, 160);
}

function vercelWhoami({ spawn = spawnSync } = {}) {
  try {
    const r = spawn("vercel", ["whoami"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 12000,
      env: { ...process.env },
    });
    if (r.status !== 0) return { ok: false, user: "" };
    const user = String(r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
    return { ok: Boolean(user), user: user.slice(0, 80) };
  } catch (err) {
    return { ok: false, user: "", erro: redactErr(err) };
  }
}

function createGithubMcpRunner({
  getAuthorization,
  refreshAuth = null,
  mcpUrl = GITHUB_MCP,
  fetchImpl = globalThis.fetch,
  mcpFactory = withRemoteMcp,
} = {}) {
  return async function runGh({ projeto }) {
    const slug = String(projeto?.slug || "").trim();
    if (!slug) return { ok: false, motivo: "slug_ausente" };
    try {
      const mcp = await mcpFactory(mcpUrl, { getAuthorization, refreshAuth, fetchImpl });
      const tools = await mcp.listTools();
      const createName = (tools.find((t) => /create.*repo|repo.*create/i.test(t.name)) || {}).name;
      if (!createName) {
        return { ok: false, motivo: "mcp_sem_create_repo", tokenDefinido: true };
      }
      const { text } = await mcp.callTool(createName, {
        name: slug,
        private: false,
        description: String(projeto?.resumo || projeto?.titulo || slug).slice(0, 200),
      });
      const urlMatch = String(text || "").match(/https:\/\/github\.com\/[^\s"'<>]+/i);
      const url = urlMatch ? urlMatch[0].replace(/[.,)]+$/, "") : `https://github.com/${slug}`;
      return { ok: true, via: "mcp", url, detail: String(text || "").slice(0, 200) };
    } catch (err) {
      return { ok: false, motivo: "github_mcp_erro", erro: redactErr(err) };
    }
  };
}

function createVercelCliRunner({ spawn = spawnSync } = {}) {
  return async function runVercel({ projeto, token = "" }) {
    const dir = String(projeto?.path || "").trim();
    if (!dir) return { ok: false, motivo: "path_ausente" };
    const who = vercelWhoami({ spawn });
    const env = { ...process.env };
    // Só injeta token se o usuário configurou no HELIOS — nunca lê token do CLI alheio.
    if (token) env.VERCEL_TOKEN = String(token);
    else if (!who.ok) return { ok: false, motivo: "vercel_cli_nao_logado" };

    try {
      const r = spawn("vercel", ["deploy", "--yes", "--prod"], {
        cwd: dir,
        encoding: "utf8",
        windowsHide: true,
        timeout: 180000,
        env,
      });
      const out = `${r.stdout || ""}\n${r.stderr || ""}`;
      if (r.status !== 0) {
        return { ok: false, motivo: "vercel_deploy_falhou", erro: redactErr(out).slice(0, 160) };
      }
      const urlMatch = out.match(/https:\/\/[^\s]+\.vercel\.app[^\s]*/i);
      return {
        ok: true,
        via: token ? "token" : "cli",
        url: urlMatch ? urlMatch[0].replace(/[.,)]+$/, "") : "",
        user: who.user || "",
      };
    } catch (err) {
      return { ok: false, motivo: "vercel_cli_erro", erro: redactErr(err) };
    }
  };
}

module.exports = {
  vercelWhoami,
  createGithubMcpRunner,
  createVercelCliRunner,
  GITHUB_MCP,
};
