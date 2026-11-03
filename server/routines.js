"use strict";

const path = require("node:path");
const { newId, nowIso, readJson, writeJson } = require("./util");

/** Eventos que podem disparar uma rotina (Fase 5). */
const EVENTS = {
  app_iniciou: "Quando o HELIOS abre",
  reuniao_terminou: "Quando uma reunião termina",
  nota_criada: "Quando uma nota entra no Second Brain",
};
/** Um evento não dispara a mesma rotina de novo antes disso (evita rajada e laço). */
const EVENT_COOLDOWN_MS = 60 * 1000;

function isDue(item, at) {
  if (!item.enabled) return false;
  if (item.event) return false;
  if (Array.isArray(item.weekdays) && item.weekdays.length && !item.weekdays.includes(new Date(at).getDay())) return false;
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

/** Dispara as rotinas ligadas a um evento. Mesmo contrato de dispatchDue. */
function dispatchEvent({ routines, store, send, event, detail = "", at = Date.now() }) {
  const ran = [];
  const skipped = [];
  for (const item of routines.forEvent(event, at)) {
    let conv = store.list().find((entry) => entry.title === `Rotina: ${item.title}`);
    if (!conv) conv = store.create(`Rotina: ${item.title}`, item.assistantId || undefined);
    try {
      if (item.readOnly) store.update(conv.id, (current) => { current.readOnly = true; });
      const extra = String(detail || "").trim().slice(0, 400);
      send(conv.id, extra ? `${item.prompt}\n\nEvento: ${EVENTS[event]}. ${extra}` : item.prompt, { level: "rapido" });
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
    event: item.event || null,
    weekdays: Array.isArray(item.weekdays) ? item.weekdays : [],
    trigger: item.event ? "evento" : item.clock ? "horario" : "intervalo",
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

const BRIEF_TITLE = "Morning Brief";
const BRIEF_MODEL = "morning-brief";
const BRIEF_PROMPT = [
  "Morning Brief do Helison. Só leitura: nada é enviado, publicado ou apagado.",
  "Não use o cofre.",
  "Monte um resumo em português, curto e em tópicos:",
  "1) Agenda do dia (se houver conector de calendário);",
  "2) E-mails e mensagens que pedem resposta;",
  "3) Tarefas do ClickUp para hoje ou atrasadas (se houver conector);",
  "4) Pendências abertas da memória e notas recentes do Second Brain;",
  "5) Uma sugestão do que fazer primeiro.",
  "Se uma fonte não estiver conectada, diga numa linha e siga.",
].join(" ");

const MONITOR_MODEL = "monitor";
function monitorPrompt(target) {
  return [
    `Monitor: verifique ${target}.`,
    "Só leitura: não envie, não publique, não se inscreva e não compre nada; qualquer ação vira cartão de aprovação.",
    "Compare com a última verificação nesta conversa.",
    "Se nada mudou, responda apenas \"Sem novidades.\"",
    "Se mudou, diga o que mudou em até 3 linhas, com o link da fonte.",
  ].join(" ");
}

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
    const weekdays = normalizeWeekdays(input.weekdays);
    if (input.trigger === "evento" || input.event) {
      const event = String(input.event || "");
      if (!EVENTS[event]) throw Object.assign(new Error("Escolha um evento válido para a rotina."), { status: 400 });
      return { title, prompt, everyMinutes: null, clock: null, event, weekdays: [] };
    }
    const every = Number(input.everyMinutes);
    const clock = /^\d{2}:\d{2}$/.test(String(input.clock || "")) ? String(input.clock) : "";
    if (clock) {
      const [hh, mm] = clock.split(":").map(Number);
      if (hh > 23 || mm > 59) throw Object.assign(new Error("Horário inválido. Use HH:MM, de 00:00 a 23:59."), { status: 400 });
    }
    if (!clock && !(every >= 1 && every <= 10080)) throw Object.assign(new Error("Informe um horário (HH:MM), um intervalo em minutos ou um evento."), { status: 400 });
    return { title, prompt, everyMinutes: clock ? null : every, clock: clock || null, event: null, weekdays: clock ? weekdays : [] };
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
    if (fromBot && !clean.clock && !clean.event && clean.everyMinutes < minEveryMinutes) {
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
      event: clean.event,
      weekdays: clean.weekdays,
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
    if (patch.weekdays !== undefined && item.clock) item.weekdays = normalizeWeekdays(patch.weekdays);
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

  function forEvent(event, at = Date.now()) {
    if (!EVENTS[event]) return [];
    return items
      .filter((item) => item.enabled && item.event === event)
      .filter((item) => !item.lastRun || at - Date.parse(item.lastRun) >= EVENT_COOLDOWN_MS)
      .map(view);
  }

  /** Morning Brief: entra pausado, 07:30 de segunda a sexta, só leitura. */
  function installBrief({ clock = "07:30", weekdays = [1, 2, 3, 4, 5] } = {}) {
    const existing = items.find((item) => item.modelo === BRIEF_MODEL);
    if (existing) return view(existing);
    const okClock = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(clock)) ? String(clock) : "07:30";
    const item = {
      id: newId("rot"), title: BRIEF_TITLE, prompt: BRIEF_PROMPT, everyMinutes: null, clock: okClock, event: null,
      weekdays: normalizeWeekdays(weekdays), enabled: false, readOnly: true, modelo: BRIEF_MODEL, assistantId: null, lastRun: null, createdAt: nowIso(),
    };
    items.push(item);
    save();
    return view(item);
  }

  /** Monitor: vigia algo a cada N minutos (mínimo 15), só leitura, entra pausado. */
  function installMonitor({ target, everyMinutes = 60, title } = {}) {
    const what = String(target || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (what.length < 4) throw Object.assign(new Error("Diga o que o Monitor deve vigiar."), { status: 400 });
    const every = Math.max(15, Math.min(10080, Number(everyMinutes) || 60));
    const item = {
      id: newId("rot"), title: String(title || `Monitor: ${what}`).trim().slice(0, 80), prompt: monitorPrompt(what), everyMinutes: every, clock: null, event: null,
      weekdays: [], enabled: false, readOnly: true, modelo: MONITOR_MODEL, assistantId: null, lastRun: null, createdAt: nowIso(),
    };
    items.push(item);
    save();
    return view(item);
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

  return { list: () => items.map(view), add, checkLimits, update, remove, due, forEvent, markRan, installMorning, installBrief, installMonitor, file };
}

function normalizeWeekdays(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[,\s]+/);
  return [...new Set(list.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
}

module.exports = {
  createRoutines, isDue, dispatchDue, dispatchEvent, normalizeWeekdays, monitorPrompt, EVENTS, EVENT_COOLDOWN_MS,
  BRIEF_TITLE, BRIEF_MODEL, BRIEF_PROMPT, MONITOR_MODEL, DEFAULT_MAX_ROUTINES, DEFAULT_BOT_MIN_EVERY,
  MORNING_TITLE, MORNING_MODEL, MORNING_PROMPT,
};
