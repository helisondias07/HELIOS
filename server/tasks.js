"use strict";

const path = require("node:path");
const { newId, nowIso, readJson, writeJson } = require("./util");

const STATUSES = new Set(["aberta", "feita", "cancelada"]);

function createTasks(dataDir) {
  const file = path.join(dataDir, "tasks.json");
  let items = readJson(file, []);
  if (!Array.isArray(items)) items = [];
  const save = () => writeJson(file, items);

  function add(input = {}) {
    const title = String(input.title || input.titulo || "").trim().slice(0, 140);
    if (title.length < 2) throw Object.assign(new Error("Dê um título à tarefa."), { status: 400 });
    const item = {
      id: newId("task"),
      title,
      detail: String(input.detail || input.detalhe || "").trim().slice(0, 1000),
      status: "aberta",
      createdAt: nowIso(),
    };
    items.unshift(item);
    save();
    return { ...item };
  }

  function update(id, patch = {}) {
    const item = items.find((entry) => entry.id === id);
    if (!item) return null;
    if (patch.status !== undefined) {
      const status = String(patch.status || "");
      if (!STATUSES.has(status)) throw Object.assign(new Error("Status de tarefa inválido."), { status: 400 });
      item.status = status;
      item.updatedAt = nowIso();
    }
    save();
    return { ...item };
  }

  function list() {
    return items.map((item) => ({ ...item }));
  }

  return { add, update, list, file, statuses: STATUSES };
}

module.exports = { createTasks };
