"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { newId, nowIso, readJson, writeJson } = require("./util");

function publicMessage(message) {
  if (message.role === "approval") {
    return {
      id: message.id,
      role: "approval",
      kind: message.kind,
      summary: message.summary,
      detail: message.detail || "",
      state: message.state,
      at: message.at,
      result: message.result || "",
      auto: Boolean(message.auto),
      expiresAt: message.expiresAt || null,
    };
  }
  if (message.role === "question") {
    return {
      id: message.id,
      role: "question",
      question: message.question || "",
      options: message.options || [],
      state: message.state,
      answer: message.answer || "",
      parked: message.parked || null,
      at: message.at,
    };
  }
  return {
    id: message.id,
    role: message.role,
    text: message.text || "",
    status: message.status || "done",
    at: message.at,
    model: message.model || null,
    level: message.level || null,
    reason: message.reason || "",
    narration: message.narration || "",
    aviso: message.aviso || "",
    sources: message.sources || [],
    ...(message.accountIssue ? { accountIssue: message.accountIssue } : {}),
  };
}

function publicConv(conv) {
  if (!conv) return null;
  const last = [...conv.messages].reverse().find((message) => message.role === "user" || message.role === "assistant");
  return {
    id: conv.id,
    title: conv.title,
    assistantId: conv.assistantId || "default",
    busy: Boolean(conv.busy),
    readOnly: conv.readOnly === true,
    summary: conv.summary && conv.summary.text
      ? { active: true, text: conv.summary.text, chars: conv.summary.text.length, covered: conv.summary.covered || 0, updatedAt: conv.summary.updatedAt || null, rollovers: conv.summary.rollovers || 0 }
      : null,
    helper: conv.helper ? { id: conv.helper.id, task: conv.helper.task || "", done: Boolean(conv.helper.done) } : null,
    updatedAt: conv.updatedAt,
    createdAt: conv.createdAt,
    preview: last ? String(last.text || last.summary || "").replace(/\s+/g, " ").slice(0, 90) : "",
    messages: conv.messages.map(publicMessage),
  };
}

function createStore(dataDir) {
  const file = path.join(dataDir, "conversations.json");
  let data = readJson(file, { version: 1, items: [] });
  if (!Array.isArray(data.items)) data = { version: 1, items: [] };
  const save = () => writeJson(file, data);

  // Reinício: nada continua rodando depois que o app fecha. Resposta "running" vira erro e a
  // conversa deixa de ficar "ocupada" para sempre (antes, o chat travava depois de um fechamento no meio).
  let interrupted = false;
  for (const conv of data.items) {
    if (!conv || typeof conv !== "object") continue;
    if (!Array.isArray(conv.messages)) conv.messages = [];
    for (const message of conv.messages) {
      if (message && message.role === "assistant" && message.status === "running") {
        message.status = "error";
        message.text = message.text || "Esta resposta foi interrompida porque o HELIOS foi fechado. Envie a mensagem de novo.";
        message.narration = "";
        interrupted = true;
      }
    }
    if (conv.busy) {
      conv.busy = false;
      interrupted = true;
    }
  }
  if (interrupted) save();

  // Migração v1 -> v2: toda conversa antiga passa a ser do assistente padrão.
  // Guarda uma cópia do arquivo antigo uma única vez, antes de mexer.
  const legacy = data.items.filter((conv) => !conv.assistantId);
  if (legacy.length) {
    const backup = path.join(dataDir, "conversations.pre-assistentes.json");
    try {
      if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
    } catch {
      /* sem cópia, a migração ainda é só acrescentar um campo */
    }
    for (const conv of legacy) conv.assistantId = "default";
    data.version = 2;
    save();
  }

  function get(id) {
    return data.items.find((conv) => conv.id === id) || null;
  }

  function create(title, assistantId) {
    const conv = {
      id: newId("conv"),
      title: String(title || "Nova conversa").slice(0, 80),
      assistantId: String(assistantId || "default"),
      messages: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      busy: false,
      agentId: null,
      agentModel: null,
    };
    data.items.unshift(conv);
    save();
    return conv;
  }

  function update(id, fn) {
    const conv = get(id);
    if (!conv) return null;
    fn(conv);
    conv.updatedAt = nowIso();
    save();
    return conv;
  }

  function remove(id) {
    const before = data.items.length;
    data.items = data.items.filter((conv) => conv.id !== id);
    if (data.items.length !== before) save();
    return data.items.length !== before;
  }

  /** Move as conversas de um assistente removido para outro. */
  function reassign(fromId, toId) {
    let moved = 0;
    for (const conv of data.items) {
      if (conv.assistantId === fromId) {
        conv.assistantId = toId;
        moved += 1;
      }
    }
    if (moved) save();
    return moved;
  }

  function list() {
    return [...data.items].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  return { list, get, create, update, remove, reassign, file };
}

module.exports = { createStore, publicConv, publicMessage };
