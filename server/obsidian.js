"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { unsafeReason } = require("./memory");

const SKIP_DIR = new Set([".obsidian", ".git", "node_modules"]);

function titleFromMd(text, filename) {
  const m = String(text || "").match(/^#\s+(.+)$/m);
  if (m) return m[1].trim().slice(0, 120);
  return path.basename(filename, path.extname(filename)).replace(/[-_]+/g, " ").trim().slice(0, 120);
}

function snippet(text, max = 380) {
  const body = String(text || "")
    .replace(/^#.+$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return body.slice(0, max);
}

function walkMd(folder, maxFiles, out, errors) {
  if (out.length >= maxFiles) return;
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch (err) {
    errors.push({ path: folder, error: err.message });
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) break;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      walkMd(full, maxFiles, out, errors);
      continue;
    }
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    out.push(full);
  }
}

/**
 * Importa notas Markdown de um cofre Obsidian para a memória como fatos.
 * @returns {{ imported:number, skipped:number, errors:Array<{path:string, error:string}> }}
 */
function importObsidianVault(folder, { memory, maxFiles = 200 } = {}) {
  if (!memory || typeof memory.remember !== "function") {
    throw Object.assign(new Error("Memória indisponível para importar o Obsidian."), { status: 500 });
  }
  const root = path.resolve(String(folder || ""));
  if (!root || !fs.existsSync(root)) {
    throw Object.assign(new Error("Pasta do Obsidian não encontrada."), { status: 400 });
  }
  const cap = Math.min(Math.max(Number(maxFiles) || 200, 1), 2000);
  const files = [];
  const errors = [];
  walkMd(root, cap, files, errors);

  let imported = 0;
  let skipped = 0;

  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      errors.push({ path: file, error: err.message });
      continue;
    }
    const title = titleFromMd(raw, file);
    const piece = snippet(raw);
    const text = piece ? `${title}: ${piece}` : title;
    if (text.length < 6) {
      skipped += 1;
      continue;
    }
    const bad = unsafeReason(text);
    if (bad) {
      skipped += 1;
      continue;
    }
    try {
      memory.remember({ text, kind: "fato", source: "obsidian" });
      imported += 1;
    } catch (err) {
      if (/curto demais|Não guardo/i.test(err.message)) skipped += 1;
      else errors.push({ path: file, error: err.message });
    }
  }

  return { imported, skipped, errors };
}

module.exports = { importObsidianVault, titleFromMd };
