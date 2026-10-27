"use strict";

const path = require("node:path");
const { readJson, writeJson } = require("./util");
const { findSecret } = require("./secret-scan");

function cleanAppName(name) {
  const base = String(name || "").replace(/\.exe$/i, "").trim();
  if (!base || findSecret(base) || !/^[\w .+-]{1,40}$/.test(base)) return "desconhecido";
  return base;
}

function dayKey(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function createDictationStats(dataDir, { now = () => Date.now() } = {}) {
  const file = path.join(dataDir, "ditado.json");

  function load() {
    const saved = readJson(file, {});
    const stats = saved.stats && typeof saved.stats === "object" ? saved.stats : {};
    if (!stats.days || typeof stats.days !== "object") stats.days = {};
    if (!stats.byApp || typeof stats.byApp !== "object") stats.byApp = {};
    return { prefs: saved.prefs, stats };
  }

  function save(bag) {
    writeJson(file, { prefs: bag.prefs, stats: bag.stats });
  }

  function record(input = {}) {
    if (input.text !== undefined || input.texto !== undefined || input.transcript !== undefined) {
      throw Object.assign(new Error("O ditado não guarda o texto falado."), { status: 400 });
    }
    const words = Math.max(0, Math.min(20000, Math.round(Number(input.words) || 0)));
    const chars = Math.max(0, Math.min(80000, Math.round(Number(input.chars) || 0)));
    const fixes = Math.max(0, Math.min(20000, Math.round(Number(input.fixes) || 0)));
    const durationMs = Math.max(0, Math.min(10 * 60 * 1000, Math.round(Number(input.durationMs) || 0)));
    if (!words && !chars) return view();
    const bag = load();
    const day = dayKey(now());
    const row = bag.stats.days[day] || { words: 0, chars: 0, fixes: 0, sessions: 0, durationMs: 0 };
    row.words += words;
    row.chars += chars;
    row.fixes += fixes;
    row.sessions += 1;
    row.durationMs += durationMs;
    bag.stats.days[day] = row;
    const app = cleanAppName(input.app);
    bag.stats.byApp[app] = (bag.stats.byApp[app] || 0) + words;
    const keys = Object.keys(bag.stats.days).sort();
    while (keys.length > 60) {
      delete bag.stats.days[keys.shift()];
    }
    save(bag);
    return view();
  }

  function view() {
    const bag = load();
    const today = dayKey(now());
    const days = bag.stats.days;
    const row = days[today] || { words: 0, chars: 0, fixes: 0, sessions: 0, durationMs: 0 };
    let totalWords = 0;
    let totalFixes = 0;
    let totalMs = 0;
    for (const item of Object.values(days)) {
      totalWords += item.words || 0;
      totalFixes += item.fixes || 0;
      totalMs += item.durationMs || 0;
    }
    const stamps = Object.keys(days).filter((key) => (days[key].words || 0) > 0).sort();
    let streak = 0;
    const cursor = new Date(now());
    if (!days[today] || !days[today].words) cursor.setDate(cursor.getDate() - 1);
    for (let i = 0; i < 60; i += 1) {
      const key = dayKey(cursor.getTime());
      if (!days[key] || !days[key].words) break;
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    const minutes = row.durationMs / 60000;
    const wpm = minutes >= 0.05 ? Math.round(row.words / minutes) : null;
    const byApp = Object.entries(bag.stats.byApp)
      .map(([app, words]) => ({ app, words }))
      .sort((a, b) => b.words - a.words)
      .slice(0, 8);
    return {
      hoje: { ...row, wpm },
      total: { words: totalWords, fixes: totalFixes, durationMs: totalMs, days: stamps.length },
      streak,
      byApp,
      note: "O HELIOS conta palavras e correções. O texto ditado não fica salvo.",
    };
  }

  return { record, view, cleanAppName, file };
}

module.exports = { createDictationStats, cleanAppName };
