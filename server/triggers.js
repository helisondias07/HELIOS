"use strict";

/**
 * LEVA L: gatilhos agendados e por evento, idempotentes e persistentes.
 * Conteúdo do evento (ex.: corpo de e-mail) é dado NÃO confiável: nunca concede
 * permissão nova nem muda escopo do agente.
 */
const path = require("node:path");
const { newId, nowIso, readJson, writeJson, redact } = require("./util");

const KINDS = new Set(["agendado", "evento"]);
const MODES = new Set(["individual", "combinado"]);
const OCC_STATUS = new Set(["aceita", "em_fila", "rodando", "feita", "pulada", "falhou"]);

function fail(msg, status = 400) {
  return Object.assign(new Error(msg), { status });
}

function occurrenceKey(triggerId, key) {
  return `${triggerId}::${String(key || "").slice(0, 200)}`;
}

function createTriggers(dataDir) {
  const dir = path.join(dataDir, "gatilhos");
  const file = path.join(dir, "triggers.json");
  const occFile = path.join(dir, "occurrences.json");
  require("node:fs").mkdirSync(dir, { recursive: true });

  let data = readJson(file, { version: 1, items: [] });
  if (!Array.isArray(data.items)) data = { version: 1, items: [] };
  let occ = readJson(occFile, { version: 1, items: [], keys: {} });
  if (!Array.isArray(occ.items)) occ = { version: 1, items: [], keys: {} };
  if (!occ.keys || typeof occ.keys !== "object") occ.keys = {};

  const save = () => writeJson(file, data);
  const saveOcc = () => writeJson(occFile, occ);

  function view(item) {
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      enabled: item.enabled !== false,
      paused: item.enabled === false,
      assistantId: item.assistantId || "default",
      mode: item.mode || "individual",
      clock: item.clock || null,
      everyMinutes: item.everyMinutes || null,
      weekdays: Array.isArray(item.weekdays) ? item.weekdays : [],
      event: item.event || null,
      prompt: item.prompt,
      missPolicy: item.missPolicy || "recover", // recover | skip
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      lastOccurrenceAt: item.lastOccurrenceAt || null,
      source: item.source || "user",
    };
  }

  function list() {
    return data.items.map(view).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function get(id) {
    const item = data.items.find((x) => x.id === id);
    return item ? view(item) : null;
  }

  function add(input = {}) {
    const title = redact(String(input.title || "").trim()).slice(0, 80);
    const prompt = redact(String(input.prompt || "").trim()).slice(0, 2000);
    if (title.length < 2) throw fail("Dê um nome ao gatilho.");
    if (prompt.length < 4) throw fail("Escreva o que o agente deve fazer.");
    const kind = KINDS.has(input.kind) ? input.kind : (input.event ? "evento" : "agendado");
    const mode = MODES.has(input.mode) ? input.mode : "individual";
    const item = {
      id: newId("trg"),
      title,
      kind,
      enabled: input.enabled !== false,
      assistantId: String(input.assistantId || "default").slice(0, 40),
      mode,
      clock: kind === "agendado" && input.clock ? String(input.clock).slice(0, 5) : null,
      everyMinutes: kind === "agendado" && input.everyMinutes ? Math.max(1, Number(input.everyMinutes) || 0) : null,
      weekdays: Array.isArray(input.weekdays) ? input.weekdays.map(Number).filter((d) => d >= 0 && d <= 6) : [],
      event: kind === "evento" ? String(input.event || "").slice(0, 60) : null,
      prompt,
      missPolicy: input.missPolicy === "skip" ? "skip" : "recover",
      source: String(input.source || "user").slice(0, 40),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastOccurrenceAt: null,
    };
    if (kind === "evento" && !item.event) throw fail("Informe o evento.");
    if (kind === "agendado" && !item.clock && !item.everyMinutes) throw fail("Informe horário ou intervalo.");
    data.items.push(item);
    save();
    return view(item);
  }

  function pause(id) {
    const item = data.items.find((x) => x.id === id);
    if (!item) throw fail("Gatilho não encontrado.", 404);
    item.enabled = false;
    item.updatedAt = nowIso();
    save();
    return view(item);
  }

  function resume(id) {
    const item = data.items.find((x) => x.id === id);
    if (!item) throw fail("Gatilho não encontrado.", 404);
    item.enabled = true;
    item.updatedAt = nowIso();
    save();
    return view(item);
  }

  function remove(id) {
    const before = data.items.length;
    data.items = data.items.filter((x) => x.id !== id);
    if (data.items.length === before) return false;
    save();
    return true;
  }

  /**
   * Admite uma ocorrência. Idempotente pela chave.
   * `payload` é tratado como dado não confiável (nunca altera permissões).
   */
  function admit(triggerId, { key, payload = "", at = Date.now() } = {}) {
    const item = data.items.find((x) => x.id === triggerId);
    if (!item) throw fail("Gatilho não encontrado.", 404);
    if (item.enabled === false) return { admitted: false, reason: "pausado", occurrence: null };
    const occKey = occurrenceKey(triggerId, key || `${at}`);
    if (occ.keys[occKey]) {
      const existing = occ.items.find((o) => o.id === occ.keys[occKey]);
      return { admitted: false, reason: "duplicada", occurrence: existing ? { ...existing } : null };
    }
    // Payload nunca vira concessão de permissão / escopo.
    const safePayload = redact(String(payload || "")).slice(0, 4000);
    const row = {
      id: newId("occ"),
      triggerId,
      key: occKey,
      status: "aceita",
      payload: safePayload,
      untrusted: true,
      grantsNothing: true,
      at: new Date(at).toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    occ.items.push(row);
    occ.keys[occKey] = row.id;
    item.lastOccurrenceAt = row.at;
    item.updatedAt = nowIso();
    save();
    saveOcc();
    return { admitted: true, reason: "nova", occurrence: { ...row } };
  }

  function mark(occId, status, extra = {}) {
    if (!OCC_STATUS.has(status)) throw fail("Status de ocorrência inválido.");
    const row = occ.items.find((o) => o.id === occId);
    if (!row) throw fail("Ocorrência não encontrada.", 404);
    row.status = status;
    if (status === "rodando") row.startedAt = nowIso();
    if (status === "feita" || status === "falhou" || status === "pulada") row.finishedAt = nowIso();
    if (extra.error) row.error = redact(String(extra.error)).slice(0, 400);
    saveOcc();
    return { ...row };
  }

  function occurrences({ triggerId, limit = 50 } = {}) {
    return occ.items
      .filter((o) => !triggerId || o.triggerId === triggerId)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, limit)
      .map((o) => ({ ...o }));
  }

  /** Agenda: gera chave estável por dia+horário (ou intervalo). */
  function dueScheduled(at = Date.now()) {
    const date = new Date(at);
    const out = [];
    for (const item of data.items) {
      if (item.kind !== "agendado" || item.enabled === false) continue;
      if (Array.isArray(item.weekdays) && item.weekdays.length && !item.weekdays.includes(date.getDay())) continue;
      let key;
      if (item.everyMinutes) {
        const slot = Math.floor(at / (item.everyMinutes * 60 * 1000));
        key = `interval:${slot}`;
      } else if (item.clock && /^\d{2}:\d{2}$/.test(item.clock)) {
        const [hh, mm] = item.clock.split(":").map(Number);
        if (date.getHours() !== hh || date.getMinutes() !== mm) continue;
        key = `clock:${date.toISOString().slice(0, 10)}:${item.clock}`;
      } else continue;
      out.push({ trigger: view(item), key });
    }
    return out;
  }

  /** Evento externo → candidatos (payload não confiável). */
  function forEvent(eventName) {
    const ev = String(eventName || "").slice(0, 60);
    return data.items.filter((item) => item.kind === "evento" && item.enabled !== false && item.event === ev).map(view);
  }

  /**
   * Recuperação após reinício: ocorrências aceitas/em_fila voltam; com missPolicy=skip
   * as agendadas atrasadas demais são puladas.
   */
  function recover({ now = Date.now(), maxAgeMs = 24 * 3600e3 } = {}) {
    const recovered = [];
    const skipped = [];
    for (const row of occ.items) {
      if (!["aceita", "em_fila", "rodando"].includes(row.status)) continue;
      const age = now - Date.parse(row.at || 0);
      const trg = data.items.find((t) => t.id === row.triggerId);
      if (trg && trg.missPolicy === "skip" && age > maxAgeMs) {
        row.status = "pulada";
        row.finishedAt = nowIso();
        row.error = "ocorrência perdida após reinício (política pular)";
        skipped.push(row.id);
        continue;
      }
      if (row.status === "rodando") row.status = "em_fila";
      recovered.push(row.id);
    }
    if (recovered.length || skipped.length) saveOcc();
    return { recovered, skipped };
  }

  /** Dispara ocorrências devidas (agenda) de forma idempotente. */
  function tickScheduled(at = Date.now()) {
    const admitted = [];
    const dupes = [];
    for (const row of dueScheduled(at)) {
      const r = admit(row.trigger.id, { key: row.key, payload: "", at });
      if (r.admitted) admitted.push(r.occurrence);
      else dupes.push(r.occurrence);
    }
    return { admitted, dupes };
  }

  /** Dispara gatilhos de evento com chave estável (ex.: id da mensagem Gmail). */
  function tickEvent(eventName, { key, payload = "", at = Date.now() } = {}) {
    const admitted = [];
    const dupes = [];
    const rejected = [];
    for (const trg of forEvent(eventName)) {
      // Conteúdo do evento NÃO altera escopo: só vai no payload marcado untrusted.
      const r = admit(trg.id, { key: key || `${eventName}:${at}`, payload, at });
      if (r.admitted) admitted.push({ trigger: trg, occurrence: r.occurrence });
      else if (r.reason === "duplicada") dupes.push({ trigger: trg, occurrence: r.occurrence });
      else rejected.push({ trigger: trg, reason: r.reason });
    }
    return { admitted, dupes, rejected };
  }

  function pendingWork() {
    return occ.items.filter((o) => ["aceita", "em_fila"].includes(o.status)).map((o) => {
      const trg = data.items.find((t) => t.id === o.triggerId);
      return { occurrence: { ...o }, trigger: trg ? view(trg) : null };
    });
  }

  return {
    list, get, add, pause, resume, remove,
    admit, mark, occurrences, dueScheduled, forEvent,
    recover, tickScheduled, tickEvent, pendingWork,
    view, file, occFile,
  };
}

module.exports = { createTriggers, occurrenceKey, KINDS, MODES };
