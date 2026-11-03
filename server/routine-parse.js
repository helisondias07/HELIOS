"use strict";

const fold = (text) =>
  String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const DAY_NAMES = [
  ["domingo", "dom"],
  ["segunda", "seg"],
  ["terca", "ter", "terça"],
  ["quarta", "qua"],
  ["quinta", "qui"],
  ["sexta", "sex"],
  ["sabado", "sab", "sábado"],
];

const DAY_RANGE = [
  { re: /\bseg(?:unda)?\s*a\s*sex(?:ta)?\b/, days: [1, 2, 3, 4, 5] },
  { re: /\bsegunda\s+a\s+sexta\b/, days: [1, 2, 3, 4, 5] },
  { re: /\bdias?\s+uteis\b/, days: [1, 2, 3, 4, 5] },
];

/** @returns {string|null} HH:MM */
function parseClock(text) {
  const raw = String(text || "");
  const t = fold(raw);
  const m =
    t.match(/\b(?:as|às)\s*(\d{1,2})(?::(\d{2}))?\s*h?\b/) ||
    t.match(/\b(\d{1,2}):(\d{2})\b/) ||
    t.match(/\b(\d{1,2})\s*h\b/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = m[2] !== undefined ? Number(m[2]) : 0;
  if (!Number.isInteger(hh) || hh > 23 || !Number.isInteger(mm) || mm > 59) return null;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** @returns {number[]|null} null = nenhum padrão; [] = todos os dias */
function parseWeekdays(text) {
  const raw = String(text || "");
  const t = fold(raw);
  if (/\btodos?\s+os\s+dias\b/.test(t) || /\btodo\s+dia\b/.test(t)) return [];
  for (const row of DAY_RANGE) {
    if (row.re.test(t)) return [...row.days];
  }
  for (let day = 0; day < DAY_NAMES.length; day += 1) {
    const names = DAY_NAMES[day].map(fold);
    for (const name of names) {
      const re = new RegExp(`\\b(toda|todo|cada)\\s+${name}\\b`);
      if (re.test(t)) return [day];
    }
  }
  const found = [];
  for (let day = 0; day < DAY_NAMES.length; day += 1) {
    for (const name of DAY_NAMES[day]) {
      const re = new RegExp(`\\b${fold(name)}\\b`);
      if (re.test(t)) found.push(day);
    }
  }
  if (found.length) return [...new Set(found)].sort((a, b) => a - b);
  return null;
}

function stripSchedule(text) {
  let rest = fold(String(text || ""));
  const chunks = [
    /\ba\s+cada\s+\d+\s+minutos?\b/gi,
    /\btodos?\s+os\s+dias\b/gi,
    /\btodo\s+dia\b/gi,
    /\bseg(?:unda)?\s*a\s*sex(?:ta)?\b/gi,
    /\bsegunda\s+a\s+sexta\b/gi,
    /\bdias?\s+uteis\b/gi,
    /\b(toda|todo|cada)\s+(domingo|segunda|terca|quarta|quinta|sexta|sabado|dom|seg|ter|qua|qui|sex|sab)\b/gi,
    /\bas\s*\d{1,2}(?::\d{2})?\s*h?\b/gi,
    /\b\d{1,2}:\d{2}\b/g,
    /\b\d{1,2}\s*h\b/gi,
  ];
  for (const re of chunks) rest = rest.replace(re, " ");
  return rest.replace(/\s+/g, " ").trim();
}

function parseEveryMinutes(text) {
  const m = fold(text).match(/\ba\s+cada\s+(\d+)\s+minutos?\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > 10080) return null;
  return n;
}

/**
 * Interpreta texto livre em português para campos de rotina (createRoutines.normalize).
 * @returns {{ title:string, prompt:string, clock?:string, everyMinutes?:number, weekdays?:number[], event?:string }}
 */
function parseRoutineText(text, { now: _now } = {}) {
  void _now;
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (source.length < 6) throw new Error("Escreva quando a rotina deve rodar e o que ela deve fazer.");

  const everyMinutes = parseEveryMinutes(source);
  const clock = everyMinutes ? null : parseClock(source);
  let weekdays = everyMinutes ? undefined : parseWeekdays(source);
  if (!everyMinutes && clock && weekdays === null) weekdays = [];

  if (!everyMinutes && !clock) {
    throw new Error("Não entendi o horário. Use algo como \"toda segunda às 9h\", \"todos os dias às 08:30\" ou \"a cada 30 minutos\".");
  }

  const stripped = stripSchedule(source);
  const folded = fold(source);
  const at = folded.lastIndexOf(stripped);
  const task = (at >= 0 ? source.slice(at) : stripped).replace(/\s+/g, " ").trim();
  if (task.length < 4) throw new Error("Diga o que a rotina deve fazer depois do horário ou do intervalo.");

  const prompt = task.slice(0, 1000);
  const title = prompt.slice(0, 80);
  const out = { title, prompt };
  if (everyMinutes) out.everyMinutes = everyMinutes;
  if (clock) {
    out.clock = clock;
    out.weekdays = weekdays ?? [];
  }
  return out;
}

module.exports = { parseRoutineText, parseClock, parseWeekdays };
