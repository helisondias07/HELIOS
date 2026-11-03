"use strict";

/**
 * Cliente HTTP ClickUp API v2 (token pessoal ou Bearer OAuth).
 * Nunca devolve o token. Em erro de rede, motivo curto.
 */
const CLICKUP_API = "https://api.clickup.com/api/v2";

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function createClickUpHttpClient({ getToken, fetchImpl = fetch } = {}) {
  async function authHeaders() {
    const raw = typeof getToken === "function" ? await getToken() : "";
    const text = String(raw || "").trim();
    if (!text) return null;
    // Cofre: token pessoal (pk_…) → Authorization: <token>
    // Conector OAuth: "Bearer …" ou só o access token
    if (/^bearer\s+/i.test(text)) return { Authorization: text };
    if (text.startsWith("pk_") || text.length > 20) return { Authorization: text };
    return { Authorization: `Bearer ${text}` };
  }

  async function api(pathname, { method = "GET", body } = {}) {
    const headers = await authHeaders();
    if (!headers) throw fail("ClickUp sem token. Configure no cofre ou Conectores.", 503);
    const opts = {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetchImpl(`${CLICKUP_API}${pathname}`, opts);
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
    if (!res.ok) {
      const msg = data?.err || data?.error || `ClickUp HTTP ${res.status}`;
      throw fail(String(msg).slice(0, 160), res.status === 401 ? 401 : 502);
    }
    return data;
  }

  return {
    async listAssigned() {
      const user = await api("/user");
      const userId = user?.user?.id;
      if (!userId) throw fail("ClickUp: usuário não identificado.", 502);
      const teams = await api("/team");
      const teamList = Array.isArray(teams?.teams) ? teams.teams : [];
      const out = [];
      for (const team of teamList.slice(0, 5)) {
        const tid = team.id;
        if (!tid) continue;
        const qs = new URLSearchParams({
          "assignees[]": String(userId),
          include_closed: "false",
          subtasks: "false",
        });
        const page = await api(`/team/${tid}/task?${qs}`);
        for (const t of page?.tasks || []) {
          out.push({
            id: String(t.id),
            name: String(t.name || "").slice(0, 200),
            description: String(t.description || t.text_content || "").slice(0, 4000),
            status: String(t.status?.status || t.status || "").slice(0, 80),
            listName: String(t.list?.name || "").slice(0, 80),
            url: String(t.url || "").slice(0, 300),
            assignees: (t.assignees || []).map((a) => a.id),
          });
        }
      }
      return out;
    },
    async comment(taskId, text) {
      const id = String(taskId || "").trim();
      if (!id) throw fail("taskId obrigatório");
      const comment = String(text || "").trim().slice(0, 2000);
      if (comment.length < 2) throw fail("Comentário vazio");
      await api(`/task/${encodeURIComponent(id)}/comment`, {
        method: "POST",
        body: { comment_text: comment },
      });
      return { ok: true, taskId: id };
    },
    async setStatus(taskId, status) {
      const id = String(taskId || "").trim();
      if (!id) throw fail("taskId obrigatório");
      const st = String(status || "in progress").trim().slice(0, 80);
      await api(`/task/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: { status: st },
      });
      return { ok: true, taskId: id, status: st };
    },
  };
}

module.exports = { createClickUpHttpClient, CLICKUP_API };
