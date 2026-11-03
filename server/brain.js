"use strict";

const path = require("node:path");
const { newId, nowIso, readJson, writeJson } = require("./util");
const { unsafeReason, tokens } = require("./memory");

/**
 * Second Brain: notas e conhecimento pesquisável, só neste computador (brain.json).
 * Aceita e-mail no texto (é anotação sua), mas recusa senha, chave e token.
 */
const MAX_NOTES = 2000;
const MAX_BODY = 20000;

function noteUnsafe(text) {
  const reason = unsafeReason(String(text || "").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "email"));
  return reason;
}

function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[,;#]/);
  return [...new Set(list.map((tag) => String(tag).trim().toLowerCase().replace(/\s+/g, "-").slice(0, 30)).filter((tag) => tag.length >= 2))].slice(0, 12);
}

function linksOf(body) {
  const out = [];
  for (const match of String(body || "").matchAll(/\[\[([^\]]{2,80})\]\]/g)) out.push(match[1].trim());
  return [...new Set(out)];
}

function createBrain(dataDir, { onCreate } = {}) {
  const file = path.join(dataDir, "brain.json");
  let data = readJson(file, { version: 1, notes: [] });
  if (!Array.isArray(data.notes)) data = { version: 1, notes: [] };
  const save = () => writeJson(file, data);
  const err = (message, status = 400) => Object.assign(new Error(message), { status });

  function validate(input) {
    const title = String(input.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
    const body = String(input.body || "").trim().slice(0, MAX_BODY);
    if (title.length < 2) throw err("Dê um título à nota.");
    const bad = noteUnsafe(`${title}\n${body}`);
    if (bad) throw err(`Não guardo isso no Second Brain: ${bad}. Use o Cofre.`);
    return { title, body, tags: cleanTags(input.tags) };
  }

  function view(note) {
    return { ...note, links: linksOf(note.body) };
  }

  function list({ tag = "" } = {}) {
    const wanted = String(tag || "").toLowerCase();
    return data.notes
      .filter((note) => !wanted || note.tags.includes(wanted))
      .sort((a, b) => Boolean(b.pinned) - Boolean(a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map(view);
  }

  function get(id) {
    const note = data.notes.find((item) => item.id === id);
    if (!note) return null;
    const backlinks = data.notes.filter((other) => other.id !== id && linksOf(other.body).some((link) => link.toLowerCase() === note.title.toLowerCase())).map((other) => ({ id: other.id, title: other.title }));
    return { ...view(note), backlinks };
  }

  function add(input) {
    if (data.notes.length >= MAX_NOTES) throw err(`O Second Brain está cheio (limite ${MAX_NOTES}).`, 409);
    const clean = validate(input);
    const note = { id: newId("nota"), ...clean, source: input.source === "bot" ? "bot" : "voce", pinned: false, createdAt: nowIso(), updatedAt: nowIso() };
    data.notes.push(note);
    save();
    try { onCreate?.(view(note)); } catch { /* evento é opcional */ }
    return view(note);
  }

  function update(id, patch) {
    const note = data.notes.find((item) => item.id === id);
    if (!note) return null;
    const clean = validate({ title: patch.title ?? note.title, body: patch.body ?? note.body, tags: patch.tags ?? note.tags });
    Object.assign(note, clean);
    if (patch.pinned !== undefined) note.pinned = Boolean(patch.pinned);
    note.updatedAt = nowIso();
    save();
    return view(note);
  }

  function remove(id) {
    const before = data.notes.length;
    data.notes = data.notes.filter((item) => item.id !== id);
    if (data.notes.length === before) return false;
    save();
    return true;
  }

  /** Busca local por palavras: título pesa 3, etiqueta 2, texto 1. Sem nuvem. */
  function search(query, { limit = 20 } = {}) {
    const wanted = tokens(query);
    if (!wanted.length) return [];
    const rows = [];
    for (const note of data.notes) {
      const title = tokens(note.title);
      const body = tokens(note.body);
      let score = 0;
      for (const word of wanted) {
        score += 3 * title.filter((t) => t.startsWith(word)).length;
        score += 2 * note.tags.filter((t) => t.startsWith(word)).length;
        score += Math.min(5, body.filter((t) => t.startsWith(word)).length);
      }
      if (score > 0) rows.push({ note, score });
    }
    rows.sort((a, b) => b.score - a.score || String(b.note.updatedAt).localeCompare(String(a.note.updatedAt)));
    return rows.slice(0, limit).map(({ note, score }) => ({ id: note.id, title: note.title, tags: note.tags, score, snippet: snippet(note.body, wanted) }));
  }

  /** Trecho curto das notas mais relevantes, para o prompt do assistente padrão. */
  function context({ text = "", maxChars = 600 } = {}) {
    const hits = search(text, { limit: 4 });
    const lines = [];
    let used = 0;
    for (const hit of hits) {
      const line = `- ${hit.title}: ${hit.snippet}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length;
    }
    return { text: lines.length ? `Notas do Second Brain:\n${lines.join("\n")}` : "", ids: hits.map((hit) => hit.id) };
  }

  function tags() {
    const count = new Map();
    for (const note of data.notes) for (const tag of note.tags) count.set(tag, (count.get(tag) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([tag, total]) => ({ tag, total }));
  }

  return { list, get, add, update, remove, search, context, tags, file, maxNotes: MAX_NOTES };
}

function snippet(body, wanted) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const plain = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  let at = -1;
  for (const word of wanted) { at = plain.indexOf(word); if (at >= 0) break; }
  const start = Math.max(0, at - 60);
  const piece = text.slice(start, start + 180);
  return `${start > 0 ? "…" : ""}${piece}${start + 180 < text.length ? "…" : ""}`;
}

module.exports = { createBrain, cleanTags, linksOf, noteUnsafe, MAX_NOTES };
