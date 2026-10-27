"use strict";

const path = require("node:path");
const { newId, nowIso, readJson, writeJson } = require("./util");

function isDue(item, at) {
  if (!item.enabled) return false;
  if (item.everyMinutes) {
    const last = item.lastRun ? Date.parse(item.lastRun) : Date.parse(item.createdAt || 0);
    return at - last >= Number(item.everyMinutes) * 60 * 1000;
  }
  if (!item.clock || !/^\d{2}:\d{2}$/.test(item.clock)) return false;
  const date = new Date(at);
  const [hh, mm] = item.clock.split(":").map(Number);
  if (date.getHours() !== hh || date.getMinutes() !== mm) return false;
  if (!item.lastRun) {
    const created = new Date(Date.parse(item.createdAt || 0));
    if (created.toDateString() === date.toDateString()) {
      const createdMin = created.getHours() * 60 + created.getMinutes();
      if (createdMin > hh * 60 + mm) return false;
    }
    return true;
  }
  const prev = new Date(item.lastRun);
  return prev.toDateString() !== date.toDateString();
}

/** Dispara rotinas vencidas. lastRun só muda depois de send() concluir sem erro. */
function dispatchDue({ routines, store, send, at = Date.now() }) {
  const ran = [];
  const skipped = [];
  for (const item of routines.due(at)) {
    let conv = store.list().find((entry) => entry.title === `Rotina: ${item.title}`);
    if (!conv) conv = store.create(`Rotina: ${item.title}`, item.assistantId || undefined);
    try {
      if (item.readOnly) store.update(conv.id, (current) => { current.readOnly = true; });
      send(conv.id, item.prompt, { level: "rapido" });
      routines.markRan(item.id, at);
      ran.push(item.id);
    } catch {
      skipped.push(item.id);
    }
  }
  return { ran, skipped };
}

function view(item) {
  return {
    id: item.id,
    title: item.title,
    prompt: item.prompt,
    everyMinutes: item.everyMinutes,
    clock: item.clock,
    enabled: item.enabled,
    readOnly: item.readOnly === true,
    modelo: item.modelo || null,
    assistantId: item.assistantId || null,
    lastRun: item.lastRun,
    createdAt: item.createdAt,
  };
}

/** Teto de rotinas (ativas e pausadas) e intervalo mínimo das rotinas pedidas por bots. Os dois são configuráveis em Atividade › Limites. */
const DEFAULT_MAX_ROUTINES = 20;
const DEFAULT_BOT_MIN_EVERY = 15;

const MORNING_TITLE = "Digest da manhã";
const MORNING_MODEL = "digest-manha";
const MORNING_PROMPT = [
  "Rotina da manhã do Helison, da Agência Oasis.",
  "Só leitura: o resultado fica nesta conversa e o Helison é quem age fora dela.",
  "Não use o cofre.",
  "Olhe e-mail e mensagens recentes pelos conectores de leitura, e o que houver no X se o conector existir.",
  "Entregue um resumo curto: o que chegou, o que parece urgente e o que pode esperar.",
].join(" ");

function createRoutines(dataDir) {
  const file = path.join(dataDir, "routines.json");
  let items = readJson(file, []);
  if (!Array.isArray(items)) items = [];
  const save = () => writeJson(file, items);

  /** Valida e normaliza um pedido de rotina. Lança erro em português se faltar algo. */
  function normalize(input) {
    const title = String(input.title || "").trim().slice(0, 80);
    const prompt = String(input.prompt || "").trim().slice(0, 1000);
    if (title.length < 2 || prompt.length < 4) throw Object.assign(new Error("Dê um nome e o que a rotina deve fazer."), { status: 400 });
    const every = Number(input.everyMinutes);
    const clock = /^\d{2}:\d{2}$/.test(String(input.clock || "")) ? String(input.clock) : "";
    if (!clock && !(every >= 1 && every <= 10080)) throw Object.assign(new Error("Informe um horário (HH:MM) ou um intervalo em minutos."), { status: 400 });
    return { title, prompt, everyMinutes: clock ? null : every, clock: clock || null };
  }

  /**
   * Confere os tetos antes de criar e devolve o pedido normalizado (ou lança erro em português).
   * `fromBot`: a rotina foi pedida por um assistente; aí vale também o intervalo mínimo.
   */
  function checkLimits(input, { maxRoutines = DEFAULT_MAX_ROUTINES, minEveryMinutes = DEFAULT_BOT_MIN_EVERY, fromBot = false } = {}) {
    const clean = normalize(input);
    if (items.length >= maxRoutines) {
      throw Object.assign(new Error(`Já existem ${items.length} rotinas (limite: ${maxRoutines}). Apague alguma ou aumente o limite em Atividade › Limites.`), { status: 409 });
    }
    if (fromBot && !clean.clock && clean.everyMinutes < minEveryMinutes) {
      throw Object.assign(new Error(`Rotinas pedidas por assistentes precisam de pelo menos ${minEveryMinutes} minutos entre uma execução e outra.`), { status: 400 });
    }
    return clean;
  }

  function add(input) {
    const clean = normalize(input);
    const item = {
      id: newId("rot"),
      title: clean.title,
      prompt: clean.prompt,
      everyMinutes: clean.everyMinutes,
      clock: clean.clock,
      enabled: input.enabled !== false,
      readOnly: input.readOnly === true,
      modelo: input.modelo ? String(input.modelo).slice(0, 40) : null,
      assistantId: input.assistantId ? String(input.assistantId).slice(0, 40) : null,
      lastRun: null,
      createdAt: nowIso(),
    };
    items.push(item);
    save();
    return view(item);
  }

  function update(id, patch) {
    const item = items.find((entry) => entry.id === id);
    if (!item) return null;
    if (patch.enabled !== undefined) item.enabled = Boolean(patch.enabled);
    if (patch.title) item.title = String(patch.title).trim().slice(0, 80);
    if (patch.prompt) item.prompt = String(patch.prompt).trim().slice(0, 1000);
    save();
    return view(item);
  }

  function remove(id) {
    const before = items.length;
    items = items.filter((entry) => entry.id !== id);
    if (items.length !== before) save();
    return items.length !== before;
  }

  function due(at = Date.now()) {
    return items.filter((item) => isDue(item, at)).map(view);
  }

  function installMorning() {
    const existing = items.find((item) => item.modelo === MORNING_MODEL || item.title === MORNING_TITLE);
    if (existing) return view(existing);
    const item = {
      id: newId("rot"),
      title: MORNING_TITLE,
      prompt: MORNING_PROMPT,
      everyMinutes: null,
      clock: "08:00",
      enabled: false,
      readOnly: true,
      modelo: MORNING_MODEL,
      assistantId: null,
      lastRun: null,
      createdAt: nowIso(),
    };
    items.push(item);
    save();
    return view(item);
  }

  function markRan(id, at = Date.now()) {
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    item.lastRun = new Date(at).toISOString();
    save();
  }

  return { list: () => items.map(view), add, checkLimits, update, remove, due, markRan, installMorning, file };
}

module.exports = {
  createRoutines, isDue, dispatchDue, DEFAULT_MAX_ROUTINES, DEFAULT_BOT_MIN_EVERY,
  MORNING_TITLE, MORNING_MODEL, MORNING_PROMPT,
};
