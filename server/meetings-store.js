"use strict";

const { newId, nowIso, readJson, writeJson } = require("./util");
const { normalizePlaybook } = require("../src/playbooks");

const MAX_SESSIONS = 80;
const MAX_TRANSCRIPT_CHARS = 160000;
const MAX_NOTES_CHARS = 12000;

function normalizeMode(mode) {
  return mode === "livecoding" ? "livecoding" : "meeting";
}

function emptyWrapup() {
  return { resumo: "", decisoes: [], pendencias: [], proximosPassos: [], rascunho: "", edited: false };
}

function normalizeActionItem(item) {
  if (!item) return null;
  if (typeof item === "string") {
    const text = item.trim().slice(0, 400);
    return text ? { text, owner: "", due: "", done: false } : null;
  }
  if (typeof item !== "object") return null;
  const text = String(item.text || "").trim().slice(0, 400);
  if (!text) return null;
  return {
    text,
    owner: String(item.owner || "").trim().slice(0, 80),
    due: String(item.due || "").trim().slice(0, 80),
    done: Boolean(item.done),
  };
}

function normalizeWrapup(wrapup, fallback = emptyWrapup()) {
  if (!wrapup || typeof wrapup !== "object") return fallback;
  return {
    resumo: String(wrapup.resumo ?? fallback.resumo ?? "").slice(0, 8000),
    decisoes: Array.isArray(wrapup.decisoes)
      ? wrapup.decisoes.map((item) => String(item || "").trim().slice(0, 400)).filter(Boolean).slice(0, 25)
      : (fallback.decisoes || []),
    pendencias: Array.isArray(wrapup.pendencias)
      ? wrapup.pendencias.map(normalizeActionItem).filter(Boolean).slice(0, 25)
      : (fallback.pendencias || []),
    proximosPassos: Array.isArray(wrapup.proximosPassos)
      ? wrapup.proximosPassos.map(normalizeActionItem).filter(Boolean).slice(0, 25)
      : (fallback.proximosPassos || []),
    rascunho: String(wrapup.rascunho ?? fallback.rascunho ?? "").slice(0, 4000),
    edited: Boolean(wrapup.edited),
  };
}

function normalizeLine(line) {
  if (!line || typeof line !== "object") return null;
  const text = String(line.text || "").trim();
  if (!text) return null;
  const who = line.who === "me" || line.who === "them" || line.who === "mix" ? line.who : "them";
  return {
    id: Number(line.id) || 0,
    who,
    text: text.slice(0, 4000),
    lang: String(line.lang || "").slice(0, 8),
    pt: String(line.pt || "").slice(0, 4000),
    at: line.at || nowIso(),
  };
}

function clipTranscript(lines) {
  const out = [];
  let chars = 0;
  for (const line of (Array.isArray(lines) ? lines : []).map(normalizeLine).filter(Boolean).reverse()) {
    chars += line.text.length;
    if (chars > MAX_TRANSCRIPT_CHARS) break;
    out.push(line);
  }
  return out.reverse();
}

function mergeLines(existing, incoming) {
  const base = Array.isArray(existing) ? existing.map(normalizeLine).filter(Boolean) : [];
  const next = Array.isArray(incoming) ? incoming.map(normalizeLine).filter(Boolean) : [];
  if (!next.length) return clipTranscript(base);
  const byId = new Map();
  const unnumbered = [];
  for (const line of base) {
    if (line.id > 0) byId.set(line.id, line);
    else unnumbered.push(line);
  }
  for (const line of next) {
    if (line.id > 0) {
      const prev = byId.get(line.id);
      byId.set(line.id, prev ? { ...prev, ...line, pt: line.pt || prev.pt, lang: line.lang || prev.lang, at: prev.at || line.at } : line);
    } else {
      unnumbered.push(line);
    }
  }
  const numbered = [...byId.values()].sort((a, b) => a.id - b.id);
  return clipTranscript([...unnumbered, ...numbered]);
}

function publicSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    objective: row.objective,
    agenda: row.agenda,
    notes: row.notes,
    mode: normalizeMode(row.mode),
    playbook: normalizePlaybook(row.playbook),
    micDeviceId: String(row.micDeviceId || ""),
    screenSourceId: String(row.screenSourceId || ""),
    rollingSummary: String(row.rollingSummary || ""),
    rollingCount: Number(row.rollingCount) || 0,
    status: row.status,
    captureMic: Boolean(row.captureMic),
    captureSystem: Boolean(row.captureSystem),
    captureScreen: Boolean(row.captureScreen),
    consented: Boolean(row.consented),
    example: Boolean(row.example),
    startedAt: row.startedAt || "",
    endedAt: row.endedAt || "",
    durationMs: Number(row.durationMs) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lineCount: Array.isArray(row.lines) ? row.lines.length : 0,
    wrapup: normalizeWrapup(row.wrapup),
    warn: row.warn || "",
  };
}

function createMeetingsStore(dataDir) {
  const file = require("node:path").join(dataDir, "meetings.json");
  let data = readJson(file, { version: 1, sessions: [] });
  if (!Array.isArray(data.sessions)) data = { version: 1, sessions: [] };

  function save() {
    writeJson(file, data);
  }

  function find(id) {
    return data.sessions.find((row) => row.id === id) || null;
  }

  function create(input = {}) {
    const now = nowIso();
    const mode = normalizeMode(input.mode);
    const row = {
      id: newId("mtg"),
      title: String(input.title || "").trim().slice(0, 120) || (mode === "livecoding" ? "Sessão Live Coding" : "Reunião sem título"),
      objective: String(input.objective || "").trim().slice(0, 2000),
      agenda: String(input.agenda || "").trim().slice(0, 4000),
      notes: String(input.notes || "").trim().slice(0, MAX_NOTES_CHARS),
      mode,
      playbook: normalizePlaybook(input.playbook || (mode === "livecoding" ? "entrevista" : "geral")),
      micDeviceId: String(input.micDeviceId || "").slice(0, 200),
      screenSourceId: String(input.screenSourceId || "").slice(0, 200),
      rollingSummary: "",
      rollingCount: 0,
      status: "prep",
      captureMic: input.captureMic !== false,
      captureSystem: input.captureSystem !== false,
      captureScreen: input.captureScreen !== undefined ? Boolean(input.captureScreen) : mode === "livecoding",
      consented: Boolean(input.consented),
      example: false,
      startedAt: "",
      endedAt: "",
      durationMs: 0,
      createdAt: now,
      updatedAt: now,
      lines: [],
      wrapup: emptyWrapup(),
      warn: "",
    };
    data.sessions.unshift(row);
    if (data.sessions.length > MAX_SESSIONS) data.sessions = data.sessions.slice(0, MAX_SESSIONS);
    save();
    return publicSession(row);
  }

  function update(id, patch = {}) {
    const row = find(id);
    if (!row) throw Object.assign(new Error("Reunião não encontrada."), { status: 404 });
    if (typeof patch.title === "string") row.title = patch.title.trim().slice(0, 120) || row.title;
    if (typeof patch.objective === "string") row.objective = patch.objective.trim().slice(0, 2000);
    if (typeof patch.agenda === "string") row.agenda = patch.agenda.trim().slice(0, 4000);
    if (typeof patch.notes === "string") row.notes = patch.notes.slice(0, MAX_NOTES_CHARS);
    if (typeof patch.mode === "string") row.mode = normalizeMode(patch.mode);
    if (typeof patch.playbook === "string") row.playbook = normalizePlaybook(patch.playbook);
    if (typeof patch.micDeviceId === "string") row.micDeviceId = patch.micDeviceId.slice(0, 200);
    if (typeof patch.screenSourceId === "string") row.screenSourceId = patch.screenSourceId.slice(0, 200);
    if (typeof patch.rollingSummary === "string") row.rollingSummary = patch.rollingSummary.slice(0, 1500);
    if (typeof patch.rollingCount === "number") row.rollingCount = Math.max(0, Math.round(patch.rollingCount));
    if (typeof patch.captureMic === "boolean") row.captureMic = patch.captureMic;
    if (typeof patch.captureSystem === "boolean") row.captureSystem = patch.captureSystem;
    if (typeof patch.captureScreen === "boolean") row.captureScreen = patch.captureScreen;
    if (typeof patch.consented === "boolean") row.consented = patch.consented;
    if (typeof patch.warn === "string") row.warn = patch.warn.slice(0, 500);
    if (patch.wrapup && typeof patch.wrapup === "object") {
      row.wrapup = normalizeWrapup({ ...patch.wrapup, edited: patch.wrapup.edited !== false }, row.wrapup);
    }
    row.updatedAt = nowIso();
    save();
    return publicSession(row);
  }

  function start(id) {
    const row = find(id);
    if (!row) throw Object.assign(new Error("Reunião não encontrada."), { status: 404 });
    if (!row.consented) throw Object.assign(new Error("Confirme que as outras pessoas sabem que a conversa pode ser transcrita."), { status: 400 });
    row.status = "live";
    row.startedAt = row.startedAt || nowIso();
    row.endedAt = "";
    row.updatedAt = nowIso();
    save();
    return publicSession(row);
  }

  function pause(id) {
    const row = find(id);
    if (!row) throw Object.assign(new Error("Reunião não encontrada."), { status: 404 });
    if (row.status === "live") row.status = "paused";
    row.updatedAt = nowIso();
    save();
    return publicSession(row);
  }

  function resume(id) {
    const row = find(id);
    if (!row) throw Object.assign(new Error("Reunião não encontrada."), { status: 404 });
    if (row.status === "paused") row.status = "live";
    row.updatedAt = nowIso();
    save();
    return publicSession(row);
  }

  function appendLines(id, lines) {
    const row = find(id);
    if (!row) throw Object.assign(new Error("Reunião não encontrada."), { status: 404 });
    row.lines = clipTranscript([...(row.lines || []), ...(Array.isArray(lines) ? lines : [])]);
    row.updatedAt = nowIso();
    save();
    return publicSession(row);
  }

  function syncLines(id, lines) {
    const row = find(id);
    if (!row) throw Object.assign(new Error("Reunião não encontrada."), { status: 404 });
    row.lines = mergeLines(row.lines, lines);
    row.updatedAt = nowIso();
    save();
    return publicSession(row);
  }

  function end(id, { lines, wrapup, durationMs, warn } = {}) {
    const row = find(id);
    if (!row) throw Object.assign(new Error("Reunião não encontrada."), { status: 404 });
    if (Array.isArray(lines)) {
      row.lines = lines.length ? mergeLines(row.lines, lines) : clipTranscript(row.lines);
    }
    if (wrapup && typeof wrapup === "object") {
      row.wrapup = normalizeWrapup(wrapup, emptyWrapup());
    }
    row.status = "ended";
    row.endedAt = row.endedAt || nowIso();
    if (durationMs != null) row.durationMs = Math.max(0, Number(durationMs) || 0);
    if (typeof warn === "string") row.warn = warn.slice(0, 500);
    row.updatedAt = nowIso();
    save();
    return get(id);
  }

  function get(id) {
    const row = find(id);
    if (!row) return null;
    return { ...publicSession(row), lines: clipTranscript(row.lines) };
  }

  function list() {
    return data.sessions.map(publicSession);
  }

  function remove(id) {
    const before = data.sessions.length;
    data.sessions = data.sessions.filter((row) => row.id !== id);
    if (data.sessions.length === before) throw Object.assign(new Error("Reunião não encontrada."), { status: 404 });
    save();
    return { ok: true };
  }

  return { file, list, get, create, update, start, pause, resume, appendLines, syncLines, end, remove, emptyWrapup };
}

module.exports = { createMeetingsStore, publicSession, emptyWrapup, clipTranscript, mergeLines, normalizeMode, MAX_SESSIONS };
