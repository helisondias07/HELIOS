"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readJson, writeJson } = require("../server/util");

const DEFAULTS = {
  port: 47331,
  closeToTray: true,
  provider: "groq",
  sttModel: "whisper-large-v3-turbo",
  llmModel: "openai/gpt-oss-120b",
  fastModel: "openai/gpt-oss-20b",
  geminiModel: "gemini-flash-lite-latest",
  chunkSeconds: 9,
  translate: true,
  captureMic: true,
  meetingLang: "auto",
  myContext: "",
  meetingContext: "",
  formality: "neutro",
  translateHistory: 3,
  translateContextChars: 1200,
  opacity: 1,
};

const NUMBER_KEYS = new Set(["port", "chunkSeconds", "opacity", "translateHistory", "translateContextChars"]);
const BOOL_KEYS = new Set(["closeToTray", "translate", "captureMic"]);

function createSettings(dir) {
  const file = path.join(dir, "settings.json");
  let data = { ...DEFAULTS, ...readJson(file, {}) };
  fs.mkdirSync(dir, { recursive: true });

  function save() {
    writeJson(file, data);
    return publicView();
  }

  function publicView() {
    return { ...data };
  }

  function update(patch = {}) {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULTS)) continue;
      if (NUMBER_KEYS.has(key)) data[key] = Number(value);
      else if (BOOL_KEYS.has(key)) data[key] = Boolean(value);
      else data[key] = value;
    }
    if (!Number.isInteger(data.port) || data.port < 1024 || data.port > 65535) data.port = DEFAULTS.port;
    data.chunkSeconds = Math.min(15, Math.max(3, Number(data.chunkSeconds) || 9));
    data.opacity = Math.min(1, Math.max(0.3, Number(data.opacity) || 1));
    if (!["groq", "gemini"].includes(data.provider)) data.provider = "groq";
    if (!["auto", "en", "pt"].includes(data.meetingLang)) data.meetingLang = "auto";
    data.myContext = String(data.myContext || "").slice(0, 4000);
    data.meetingContext = String(data.meetingContext || "").slice(0, 800);
    if (!["neutro", "formal", "informal"].includes(data.formality)) data.formality = "neutro";
    data.translateHistory = Math.min(6, Math.max(0, Math.round(Number.isFinite(Number(data.translateHistory)) ? Number(data.translateHistory) : 3)));
    data.translateContextChars = Math.min(3000, Math.max(300, Math.round(Number(data.translateContextChars) || 1200)));
    return save();
  }

  return { get: (key) => data[key], publicView, update, file };
}

module.exports = { createSettings, DEFAULTS };
