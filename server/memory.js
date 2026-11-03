"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { newId, nowIso, readJson, writeJson, redact } = require("./util");

const KINDS = ["fato", "preferencia", "regra", "pendencia"];
const LEAN_MAX_ACTIVE = 120;
const MAX_ITEMS = 300;
const STOP = new Set("a o e de da do das dos em no na nos nas um uma para pra por com sem que se ao aos as os ou mais como quando onde qual eu voce vc me te ja nao sim tem ser estar the and of to in is it on for".split(" "));

function tokens(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** Recusa texto com cara de segredo. Devolve o motivo ou "". */
function unsafeReason(text) {
  const value = String(text || "");
  if (/\b(sk-|gsk_|crsr_|key_|ghp_|glpat-|figd_|AIza)[\w-]{8,}/i.test(value)) return "parece uma chave ou token";
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(value)) return "tem um e-mail";
  if (/\b(?:senha|password)\b\s*[:=]/i.test(value)) return "parece uma senha";
  if (/\b[A-Za-z0-9+/_-]{40,}\b/.test(value)) return "parece um segredo";
  if (redact(value) !== value) return "parece conter senha, chave ou token";
  return "";
}

function createMemory(dataDir, fileName = "memory.json") {
  const file = path.join(dataDir, fileName);
  let data = readJson(file, { version: 1, items: [] });
  if (!Array.isArray(data.items)) data = { version: 1, items: [] };
  const save = () => writeJson(file, data);
  // Memória enxuta: item fechado sai do prompt e vai para o arquivo (memory*.arquivo.json). Nada é apagado.
  const archiveFile = file.replace(/\.json$/, ".arquivo.json");
  let archive = null;
  const loadArchive = () => {
    if (!archive) {
      archive = readJson(archiveFile, { version: 1, items: [] });
      if (!Array.isArray(archive.items)) archive = { version: 1, items: [] };
    }
    return archive;
  };
  const saveArchive = () => writeJson(archiveFile, loadArchive());

  function moveToArchive(item, reason) {
    loadArchive().items.push({ ...item, status: "fechado", closedAt: nowIso(), archiveReason: reason });
    data.items = data.items.filter((entry) => entry.id !== item.id);
  }

  /** Fecha um item: some do prompt e fica no arquivo, de onde pode voltar. */
  function close(id, reason = "fechado") {
    const item = data.items.find((entry) => entry.id === id);
    if (!item) return false;
    moveToArchive(item, reason);
    saveArchive();
    save();
    return true;
  }

  function restore(id) {
    const arch = loadArchive();
    const item = arch.items.find((entry) => entry.id === id);
    if (!item) return false;
    arch.items = arch.items.filter((entry) => entry.id !== id);
    const { closedAt, archiveReason, ...rest } = item;
    void closedAt; void archiveReason;
    data.items.push({ ...rest, status: "aberto", updatedAt: nowIso() });
    saveArchive();
    save();
    return true;
  }

  function archived() {
    return [...loadArchive().items].sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)));
  }

  /**
   * Enxuga: arquiva o que já está fechado e, se passar do teto ativo, os itens mais antigos
   * (regras ficam). Devolve quantos foram para o arquivo.
   */
  function compact({ maxActive = LEAN_MAX_ACTIVE } = {}) {
    let moved = 0;
    for (const item of data.items.filter((entry) => entry.status === "fechado")) { moveToArchive(item, "fechado"); moved += 1; }
    const extra = data.items.length - maxActive;
    if (extra > 0) {
      const old = data.items
        .filter((entry) => entry.kind !== "regra")
        .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
        .slice(0, extra);
      for (const item of old) { moveToArchive(item, "antigo"); moved += 1; }
    }
    if (moved) { saveArchive(); save(); }
    return { moved, active: data.items.length, archived: loadArchive().items.length };
  }

  function list() {
    return [...data.items].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function remember({ text, kind = "fato", source = "bot" }) {
    const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (clean.length < 6) throw Object.assign(new Error("texto curto demais para lembrar"), { status: 400 });
    const bad = unsafeReason(clean);
    if (bad) throw Object.assign(new Error(`Não guardo isso na memória: ${bad}.`), { status: 400 });
    const k = KINDS.includes(kind) ? kind : "fato";
    const same = data.items.find((item) => overlap(item.text, clean) >= 0.75);
    if (same) {
      same.text = clean;
      same.kind = k;
      same.updatedAt = nowIso();
      save();
      return { item: same, updated: true };
    }
    const item = { id: newId("mem"), kind: k, status: "aberto", text: clean, source, createdAt: nowIso(), updatedAt: nowIso() };
    data.items.push(item);
    if (data.items.length > LEAN_MAX_ACTIVE) compact();
    if (data.items.length > MAX_ITEMS) data.items.splice(0, data.items.length - MAX_ITEMS);
    save();
    return { item, updated: false };
  }

  /** Importação aditiva: só acrescenta. Nunca atualiza nem apaga item existente e nunca passa do teto. */
  function addImported({ text, kind = "fato" }) {
    const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (clean.length < 6) throw Object.assign(new Error("texto curto demais para lembrar"), { status: 400 });
    const bad = unsafeReason(clean);
    if (bad) throw Object.assign(new Error(`Não guardo isso na memória: ${bad}.`), { status: 400 });
    if (data.items.length >= MAX_ITEMS) throw Object.assign(new Error(`A memória está cheia (limite ${MAX_ITEMS}).`), { status: 409 });
    if (data.items.some((item) => overlap(item.text, clean) >= 0.75)) return { item: null, duplicate: true };
    const item = { id: newId("mem"), kind: KINDS.includes(kind) ? kind : "fato", text: clean, source: "importado", createdAt: nowIso(), updatedAt: nowIso() };
    data.items.push(item);
    save();
    return { item, duplicate: false };
  }

  function forget(id) {
    const before = data.items.length;
    data.items = data.items.filter((item) => item.id !== id);
    if (data.items.length === before) return false;
    save();
    return true;
  }

  function context({ text = "", maxChars = 800 } = {}) {
    const wanted = new Set(tokens(text));
    const ranked = list()
      .filter((item) => item.status !== "fechado")
      .map((item) => {
        const own = tokens(item.text);
        let score = 0;
        for (const token of own) if (wanted.has(token)) score += 1;
        return { item, score };
      })
      .sort((a, b) => b.score - a.score || String(b.item.updatedAt).localeCompare(String(a.item.updatedAt)));
    const lines = [];
    let used = 0;
    const ids = [];
    for (const row of ranked) {
      if (wanted.size && row.score === 0 && lines.length >= 2) break;
      const line = `- (${row.item.kind}) ${row.item.text}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      ids.push(row.item.id);
      used += line.length;
      if (lines.length >= 8) break;
    }
    return { text: lines.length ? `Memória sobre o Helison:\n${lines.join("\n")}` : "", ids };
  }

  return { list, remember, addImported, forget, context, close, restore, archived, compact, file, archiveFile, maxItems: MAX_ITEMS, maxActive: LEAN_MAX_ACTIVE };
}

function overlap(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const token of A) if (B.has(token)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * Uma memória por assistente. O assistente padrão continua no memory.json de sempre
 * (nada a migrar); os outros ficam em memory-<id>.json e não se misturam.
 * LEVA L: prefere backend híbrido (SQLite FTS5 + vetores) quando node:sqlite está disponível.
 */
function createMemories(dataDir) {
  let hybrid = null;
  try {
    require("node:sqlite");
    hybrid = require("./memory-hybrid").createHybridMemories(dataDir);
  } catch {
    hybrid = null;
  }
  if (hybrid) return hybrid;

  const cache = new Map();
  const keyOf = (id) => {
    const value = String(id || "default");
    if (value === "default") return "default";
    if (!/^[\w-]{3,40}$/.test(value)) throw Object.assign(new Error("assistente inválido"), { status: 400 });
    return value;
  };
  const fileOf = (key) => (key === "default" ? "memory.json" : `memory-${key}.json`);

  function forAssistant(id) {
    const key = keyOf(id);
    if (!cache.has(key)) cache.set(key, createMemory(dataDir, fileOf(key)));
    return cache.get(key);
  }

  /** Apaga a memória de um assistente removido. O padrão nunca é apagado. */
  function drop(id) {
    const key = keyOf(id);
    if (key === "default") return false;
    cache.delete(key);
    fs.rmSync(path.join(dataDir, fileOf(key)), { force: true });
    fs.rmSync(path.join(dataDir, fileOf(key).replace(/\.json$/, ".arquivo.json")), { force: true });
    return true;
  }

  return { for: forAssistant, drop, backend: "json" };
}

module.exports = { createMemory, createMemories, unsafeReason, tokens, overlap, MAX_ITEMS, LEAN_MAX_ACTIVE };
