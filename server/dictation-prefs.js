"use strict";

const path = require("node:path");
const { readJson, writeJson } = require("./util");
const { STYLES } = require("./dictation");

const RESERVED = new Set([
  "CommandOrControl+Shift+Space",
  "CommandOrControl+Shift+1",
  "CommandOrControl+Shift+2",
  "CommandOrControl+Shift+3",
  "CommandOrControl+Shift+Enter",
  "CommandOrControl+Shift+A",
  "CommandOrControl+Shift+E",
  "CommandOrControl+Shift+R",
  "CommandOrControl+Shift+T",
  "CommandOrControl+Shift+W",
  "CommandOrControl+Shift+Up",
  "CommandOrControl+Shift+Down",
  "CommandOrControl+Shift+Left",
  "CommandOrControl+Shift+Right",
]);

const DEFAULTS = {
  enabled: false,
  mode: "alternar",
  accelerator: "CommandOrControl+Shift+D",
  cleanup: true,
  style: "padrao",
  glossary: "",
  snippets: "",
};

function validAccelerator(value) {
  const text = String(value || "");
  if (!/^(?:CommandOrControl|Command|Control|Ctrl|Alt|Shift)(?:\+(?:CommandOrControl|Command|Control|Ctrl|Alt|Shift))*\+[A-Za-z0-9]$/.test(text)) return "";
  if (RESERVED.has(text)) return "";
  return text;
}

function createDictationPrefs(dataDir) {
  const file = path.join(dataDir, "ditado.json");
  const saved = readJson(file, {});
  const data = { ...DEFAULTS, ...(saved.prefs || {}) };

  function view() {
    return {
      enabled: data.enabled === true,
      mode: data.mode === "segurar" ? "segurar" : "alternar",
      accelerator: validAccelerator(data.accelerator) || DEFAULTS.accelerator,
      cleanup: data.cleanup !== false,
      style: STYLES.includes(data.style) ? data.style : "padrao",
      glossary: String(data.glossary || "").slice(0, 2000),
      snippets: String(data.snippets || "").slice(0, 2000),
    };
  }

  function update(patch = {}) {
    if (patch.enabled !== undefined) data.enabled = patch.enabled === true;
    if (patch.mode !== undefined) data.mode = patch.mode === "segurar" ? "segurar" : "alternar";
    if (patch.accelerator !== undefined) {
      const accel = validAccelerator(patch.accelerator);
      if (!accel) throw Object.assign(new Error("Atalho inválido ou já usado pelo modo de reunião. Exemplo: CommandOrControl+Shift+D."), { status: 400 });
      data.accelerator = accel;
    }
    if (patch.cleanup !== undefined) data.cleanup = patch.cleanup !== false;
    if (patch.style !== undefined) {
      if (!STYLES.includes(patch.style)) throw Object.assign(new Error("Estilo desconhecido."), { status: 400 });
      data.style = patch.style;
    }
    if (patch.glossary !== undefined) data.glossary = String(patch.glossary || "").slice(0, 2000);
    if (patch.snippets !== undefined) data.snippets = String(patch.snippets || "").slice(0, 2000);
    const prefs = view();
    writeJson(file, { prefs, ...(readJson(file, {}).stats ? { stats: readJson(file, {}).stats } : {}) });
    return prefs;
  }

  return { view, update, file };
}

module.exports = { createDictationPrefs, validAccelerator, DEFAULTS, RESERVED };
