"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { newId, nowIso, readJson, writeJson, redact } = require("./util");
const { unsafeReason, tokens } = require("./memory");

const ITEM_MAX = 600;
const ARCHIVE_MAX = 2000;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const fold = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * Contexto de UM assistente: itens ativos (o que está em andamento, ex.: vagas abertas)
 * e um arquivo morto (o que já terminou). Só o contexto ativo entra no prompt; o arquivo
 * morto nunca é lido sozinho, só por busca explícita.
 */
function createContext(dataDir, key, { getLimit = () => 6000 } = {}) {
  const suffix = key === "default" ? "" : `-${key}`;
  const activeFile = path.join(dataDir, `contexto${suffix}.json`);
  const archiveFile = path.join(dataDir, `arquivo${suffix}.json`);
  let active = readJson(activeFile, { version: 1, items: [] });
  if (!Array.isArray(active.items)) active = { version: 1, items: [] };
  let archive = readJson(archiveFile, { version: 1, items: [] });
  if (!Array.isArray(archive.items)) archive = { version: 1, items: [] };
  const saveActive = () => writeJson(activeFile, active);
  const saveArchive = () => writeJson(archiveFile, archive);

  const lineOf = (item) => `- [${item.id}] ${item.text}`;
  const chars = () => active.items.reduce((sum, item) => sum + lineOf(item).length + 1, 0);

  function items() {
    return [...active.items].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function find(ref) {
    const wanted = String(ref || "").trim();
    if (!wanted) return null;
    const byId = active.items.find((item) => item.id === wanted);
    if (byId) return byId;
    const key2 = fold(wanted);
    const exact = active.items.find((item) => fold(item.text) === key2);
    if (exact) return exact;
    const part = active.items.filter((item) => fold(item.text).includes(key2));
    return part.length === 1 ? part[0] : null;
  }

  /** Move os itens mais antigos para o arquivo morto até caber no limite. */
  function compact({ reason = "compactação automática", limit = getLimit() } = {}) {
    const moved = [];
    const order = [...active.items].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    for (const item of order) {
      if (chars() <= limit) break;
      active.items = active.items.filter((entry) => entry.id !== item.id);
      archive.items.push({ ...item, motivo: reason, archivedAt: nowIso() });
      moved.push(item.id);
    }
    if (moved.length) {
      if (archive.items.length > ARCHIVE_MAX) archive.items.splice(0, archive.items.length - ARCHIVE_MAX);
      saveActive();
      saveArchive();
    }
    return { moved: moved.length, chars: chars(), limit };
  }

  /** Registra (ou atualiza) um item ativo. Recusa texto com cara de segredo. */
  function add(text) {
    const plain = String(text || "").replace(/\s+/g, " ").trim();
    const bad = unsafeReason(plain);
    const clean = redact(plain).slice(0, ITEM_MAX);
    if (clean.length < 4) throw fail("Item curto demais para o contexto.");
    if (bad) throw fail(`Não guardo isso no contexto: ${bad}.`);
    const same = active.items.find((item) => fold(item.text) === fold(clean));
    let item = same;
    if (same) {
      same.updatedAt = nowIso();
    } else {
      item = { id: newId("ctx"), text: clean, createdAt: nowIso(), updatedAt: nowIso() };
      active.items.push(item);
    }
    saveActive();
    const compacted = compact({ reason: "compactação automática (contexto cheio)" });
    return { item, compacted };
  }

  /** Move um item concluído para o arquivo morto. Aceita id ou trecho único do texto. */
  function archiveItem(ref, motivo = "") {
    const item = find(ref);
    if (!item) throw fail("Não achei esse item no contexto ativo. Use o id (ctx_…) ou um trecho único do texto.", 404);
    active.items = active.items.filter((entry) => entry.id !== item.id);
    archive.items.push({ ...item, motivo: redact(String(motivo || "concluído")).slice(0, 200), archivedAt: nowIso() });
    if (archive.items.length > ARCHIVE_MAX) archive.items.splice(0, archive.items.length - ARCHIVE_MAX);
    saveActive();
    saveArchive();
    return item;
  }

  /** Busca no arquivo morto. Só roda quando alguém pede. */
  function searchArchive(query, limit = 5) {
    const wanted = new Set(tokens(query));
    if (!wanted.size) return [];
    return archive.items
      .map((item) => ({ item, score: tokens(`${item.text} ${item.motivo || ""}`).filter((token) => wanted.has(token)).length }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || String(b.item.archivedAt).localeCompare(String(a.item.archivedAt)))
      .slice(0, limit)
      .map((row) => ({ ...row.item }));
  }

  /** Texto do prompt: só os itens ativos, mais novos primeiro, dentro do limite. */
  function promptText(maxChars = getLimit()) {
    const lines = [];
    let used = 0;
    for (const item of items()) {
      const line = lineOf(item);
      if (used + line.length + 1 > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.length ? `## Contexto ativo deste assistente (o que está em andamento)\n${lines.join("\n")}` : "";
  }

  function view() {
    return { chars: chars(), limit: getLimit(), items: active.items.length, archived: archive.items.length };
  }

  return { add, archiveItem, searchArchive, compact, items, promptText, view, chars, files: { active: activeFile, archive: archiveFile } };
}

/** Um contexto por assistente. O padrão fica em contexto.json / arquivo.json. */
function createContexts(dataDir, { getLimit = () => 6000 } = {}) {
  const cache = new Map();
  const keyOf = (id) => {
    const value = String(id || "default");
    if (value === "default") return "default";
    if (!/^[\w-]{3,40}$/.test(value)) throw fail("assistente inválido");
    return value;
  };

  function forAssistant(id) {
    const key = keyOf(id);
    if (!cache.has(key)) cache.set(key, createContext(dataDir, key, { getLimit }));
    return cache.get(key);
  }

  function drop(id) {
    const key = keyOf(id);
    if (key === "default") return false;
    cache.delete(key);
    fs.rmSync(path.join(dataDir, `contexto-${key}.json`), { force: true });
    fs.rmSync(path.join(dataDir, `arquivo-${key}.json`), { force: true });
    return true;
  }

  return { for: forAssistant, drop };
}

module.exports = { createContexts, createContext, ITEM_MAX };
