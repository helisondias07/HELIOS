"use strict";

const { newId, nowIso, readJson, writeJson } = require("./util");

const MAX_SESSIONS = 80;
const MAX_TRANSCRIPT_CHARS = 120000;

function emptyWrapup() {
  return { resumo: "", decisoes: [], pendencias: [], proximosPassos: [], rascunho: "", edited: false };
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

function publicSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    objective: row.objective,
    agenda: row.agenda,
    notes: row.notes,
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
    wrapup: row.wrapup || emptyWrapup(),
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
    const row = {
      id: newId("mtg"),
      title: String(input.title || "").trim().slice(0, 120) || "Reunião sem título",
      objective: String(input.objective || "").trim().slice(0, 2000),
      agenda: String(input.agenda || "").trim().slice(0, 4000),
      notes: String(input.notes || "").trim().slice(0, 4000),
      status: "prep",
      captureMic: input.captureMic !== false,
      captureSystem: input.captureSystem !== false,
      captureScreen: Boolean(input.captureScreen),
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
    if (typeof patch.notes === "string") row.notes = patch.notes.trim().slice(0, 4000);
    if (typeof patch.captureMic === "boolean") row.captureMic = patch.captureMic;
    if (typeof patch.captureSystem === "boolean") row.captureSystem = patch.captureSystem;
    if (typeof patch.captureScreen === "boolean") row.captureScreen = patch.captureScreen;
    if (typeof patch.consented === "boolean") row.consented = patch.consented;
    if (typeof patch.warn === "string") row.warn = patch.warn.slice(0, 500);
    if (patch.wrapup && typeof patch.wrapup === "object") {
      row.wrapup = {
        resumo: String(patch.wrapup.resumo || "").slice(0, 8000),
        decisoes: Array.isArray(patch.wrapup.decisoes) ? patch.wrapup.decisoes.map((item) => String(item).slice(0, 400)).filter(Boolean).slice(0, 20) : row.wrapup.decisoes,
        pendencias: Array.isArray(patch.wrapup.pendencias) ? patch.wrapup.pendencias.slice(0, 20) : row.wrapup.pendencias,
        proximosPassos: Array.isArray(patch.wrapup.proximosPassos) ? patch.wrapup.proximosPassos.slice(0, 20) : row.wrapup.proximosPassos,
        rascunho: String(patch.wrapup.rascunho || "").slice(0, 4000),
        edited: true,
      };
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

  function end(id, { lines, wrapup, durationMs, warn } = {}) {
    const row = find(id);
    if (!row) throw Object.assign(new Error("Reunião não encontrada."), { status: 404 });
    if (Array.isArray(lines)) row.lines = clipTranscript(lines);
    if (wrapup && typeof wrapup === "object") {
      row.wrapup = {
        resumo: String(wrapup.resumo || "").slice(0, 8000),
        decisoes: Array.isArray(wrapup.decisoes) ? wrapup.decisoes.map((item) => String(item).slice(0, 400)).filter(Boolean).slice(0, 20) : [],
        pendencias: Array.isArray(wrapup.pendencias) ? wrapup.pendencias.slice(0, 20) : [],
        proximosPassos: Array.isArray(wrapup.proximosPassos) ? wrapup.proximosPassos.slice(0, 20) : [],
        rascunho: String(wrapup.rascunho || "").slice(0, 4000),
        edited: Boolean(wrapup.edited),
      };
    }
    row.status = "ended";
    row.endedAt = nowIso();
    row.durationMs = Math.max(0, Number(durationMs) || 0);
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

  return { file, list, get, create, update, start, pause, resume, appendLines, end, remove, emptyWrapup };
}

module.exports = { createMeetingsStore, publicSession, emptyWrapup, clipTranscript, MAX_SESSIONS };
