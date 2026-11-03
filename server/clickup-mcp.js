"use strict";

/**
 * Cliente ClickUp preferindo ferramentas do MCP remoto oficial.
 * Sem MCP / sem ferramenta útil → cai na API v2 (compatibilidade com token do cofre).
 * Nunca loga tokens.
 */
const { withRemoteMcp, mcpResultText } = require("./mcp-remote-auth");
const { createClickUpHttpClient } = require("./clickup-http");

const MCP_URL = "https://mcp.clickup.com/mcp";

function pickTool(tools, patterns) {
  const list = Array.isArray(tools) ? tools : [];
  for (const re of patterns) {
    const hit = list.find((t) => re.test(String(t.name || "")));
    if (hit) return hit.name;
  }
  return "";
}

function parseTasksFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  try {
    const json = JSON.parse(raw);
    const arr = Array.isArray(json) ? json
      : Array.isArray(json?.tasks) ? json.tasks
        : Array.isArray(json?.items) ? json.items
          : json?.task ? [json.task] : [];
    return arr.map((t) => ({
      id: String(t.id || t.task_id || "").slice(0, 80),
      name: String(t.name || t.title || "").slice(0, 200),
      description: String(t.description || t.text_content || t.body || "").slice(0, 4000),
      status: String(t.status?.status || t.status || "").slice(0, 80),
      listName: String(t.list?.name || t.list_name || "").slice(0, 80),
      url: String(t.url || t.permalink || "").slice(0, 300),
      assignees: Array.isArray(t.assignees) ? t.assignees.map((a) => a.id || a) : [],
    })).filter((t) => t.id);
  } catch {
    // texto livre: não inventa tarefas
    return [];
  }
}

function createClickUpMcpClient({
  getAuthorization = null,
  refreshAuth = null,
  getToken = null,
  mcpUrl = MCP_URL,
  fetchImpl = globalThis.fetch,
  mcpFactory = withRemoteMcp,
  httpFactory = createClickUpHttpClient,
} = {}) {
  const http = httpFactory({
    getToken: async () => {
      if (typeof getAuthorization === "function") {
        const a = await getAuthorization();
        if (a) return a;
      }
      return typeof getToken === "function" ? getToken() : "";
    },
    fetchImpl,
  });

  async function mcpOrNull() {
    if (typeof getAuthorization !== "function") return null;
    const auth = await getAuthorization();
    if (!auth) return null;
    try {
      return await mcpFactory(mcpUrl, {
        getAuthorization: async () => auth,
        refreshAuth,
        fetchImpl,
      });
    } catch {
      return null;
    }
  }

  return {
    async listAssigned() {
      const mcp = await mcpOrNull();
      if (mcp) {
        try {
          const tools = await mcp.listTools();
          const name = pickTool(tools, [
            /assigned/i,
            /list.*task/i,
            /get.*task/i,
            /search.*task/i,
            /clickup.*task/i,
          ]);
          if (name) {
            const { text } = await mcp.callTool(name, { assigned_to_me: true, assignees: "me" });
            const tasks = parseTasksFromText(text);
            if (tasks.length) return tasks;
            // ferramenta existe mas formato desconhecido → API
          }
        } catch {
          /* cai na API */
        }
      }
      return http.listAssigned();
    },

    async comment(taskId, text) {
      const mcp = await mcpOrNull();
      if (mcp) {
        try {
          const tools = await mcp.listTools();
          const name = pickTool(tools, [/comment/i, /add.*note/i]);
          if (name) {
            await mcp.callTool(name, { task_id: taskId, comment_text: text, text });
            return { ok: true, taskId: String(taskId), via: "mcp" };
          }
        } catch {
          /* API */
        }
      }
      return http.comment(taskId, text);
    },

    async setStatus(taskId, status) {
      const mcp = await mcpOrNull();
      if (mcp) {
        try {
          const tools = await mcp.listTools();
          const name = pickTool(tools, [/status/i, /update.*task/i]);
          if (name) {
            await mcp.callTool(name, { task_id: taskId, status });
            return { ok: true, taskId: String(taskId), status, via: "mcp" };
          }
        } catch {
          /* API */
        }
      }
      return http.setStatus(taskId, status);
    },

    mcpResultText,
  };
}

module.exports = { createClickUpMcpClient, parseTasksFromText, pickTool, MCP_URL };
