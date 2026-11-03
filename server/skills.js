"use strict";

const path = require("node:path");
const { newId, nowIso, readJson, writeJson } = require("./util");
const { maskSecrets } = require("./secret-scan");
const { safeRel } = require("./livecoding");

const BAD_EXT = /\.(exe|ps1|js|bat|cmd|sh|dll)$/i;
const BAD_KEY = new Set(["__proto__", "constructor", "prototype"]);

const OASIS_SKILL = `---
name: pagina-oasis
description: Landing curta de uma linha de tênis, para o Helison estudar a estrutura da página.
---
Ajude o Helison a desenhar uma landing de uma linha de tênis da Agência Oasis.
Fale em português, nestas seções: promessa, prova, produto e chamada.
Sugira um título, três benefícios e o texto de um botão.
Não publique nada e não grave arquivo. O Helison escreve o HTML.
Pare e pergunte antes de passar dessas quatro seções.
`;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function badKeys(value) {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some((key) => BAD_KEY.has(key));
}

function clip(value, max) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function parseSkillMd(markdown) {
  const text = String(markdown || "").replace(/^\uFEFF/, "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split(/\n/)) {
    const found = line.match(/^([A-Za-z][\w-]{0,40}):\s*(.*)$/);
    if (!found) continue;
    if (BAD_KEY.has(found[1])) return null;
    meta[found[1]] = found[2].trim();
  }
  return { name: meta.name || "", description: meta.description || "", body: match[2].trim() };
}

function fromFiles(files) {
  if (!Array.isArray(files) || !files.length) return null;
  const parts = [];
  for (const file of files) {
    if (badKeys(file)) throw fail("O pacote de skill tem um campo não permitido.");
    const rel = safeRel(file.caminho || file.path || "");
    if (!rel) throw fail("A skill tem um caminho inválido. Use só arquivos relativos, sem pasta oculta.");
    if (BAD_EXT.test(rel)) throw fail("A skill não pode trazer programa executável. Só texto de instrução.");
    const body = clip(file.conteudo || file.contents || "", 8000);
    if (!body) throw fail(`O arquivo ${rel} está vazio.`);
    parts.push(`# ${rel}\n${body}`);
  }
  const joined = parts.join("\n\n");
  const parsed = parseSkillMd(joined);
  if (parsed && parsed.name) return parsed;
  return { name: "", description: "", body: joined };
}

function normalizeImport(input) {
  if (badKeys(input)) throw fail("O pacote de skill tem um campo não permitido.");
  let parsed = null;
  if (input && input.markdown) parsed = parseSkillMd(input.markdown);
  if (!parsed && input && input.arquivos) parsed = fromFiles(input.arquivos);
  if (!parsed && input && (input.nome || input.name)) {
    parsed = {
      name: input.nome || input.name,
      description: input.descricao || input.description || "",
      body: input.instrucoes || input.body || "",
    };
  }
  if (!parsed) throw fail("Não reconheci a skill. Envie um SKILL.md com nome e descrição, ou nome e instruções.");
  const name = clip(parsed.name, 60);
  const description = clip(parsed.description, 240);
  const maskedBody = maskSecrets(clip(parsed.body, 8000));
  const maskedDescription = maskSecrets(description);
  if (name.length < 2 || maskedBody.length < 8) throw fail("A skill precisa de nome e de um texto de instrução.");
  if (BAD_EXT.test(name) || !safeRel(`${name.replace(/\s+/g, "-").toLowerCase()}.md`)) {
    throw fail("Esse nome de skill não serve.");
  }
  const avisos = [];
  if (maskedBody !== clip(parsed.body, 8000) || maskedDescription !== description) {
    avisos.push("Tirei trechos com cara de segredo. Nada foi executado.");
  }
  return {
    name,
    description: maskedDescription || "Instrução extra para um assistente.",
    body: maskedBody,
    avisos,
  };
}

function createSkills(dataDir) {
  const file = path.join(dataDir, "skills.json");
  let items = readJson(file, []);
  if (!Array.isArray(items)) items = [];
  const save = () => writeJson(file, items);

  function view(item, withBody) {
    const base = {
      id: item.id,
      name: item.name,
      description: item.description,
      assistantId: item.assistantId || null,
      origem: item.origem || "importada",
      createdAt: item.createdAt,
    };
    if (withBody) base.instrucoes = item.body;
    return base;
  }

  function visible(assistantId) {
    return items.filter((item) => !item.assistantId || item.assistantId === assistantId);
  }

  function preview(input) {
    const clean = normalizeImport(input || {});
    return {
      ok: true,
      executed: false,
      name: clean.name,
      description: clean.description,
      instrucoes: clean.body,
      avisos: clean.avisos,
      note: "Prévia. Nada foi gravado e nada foi executado. A skill não ganha ferramenta nem autonomia.",
    };
  }

  function add(clean, { origem = "importada", assistantId = null } = {}) {
    const item = {
      id: newId("skill"),
      name: clean.name,
      description: clean.description,
      body: clean.body,
      assistantId: assistantId ? String(assistantId).slice(0, 40) : null,
      origem,
      createdAt: nowIso(),
    };
    items.unshift(item);
    save();
    return view(item, true);
  }

  function apply(input) {
    if (!input || input.confirmar !== true) throw fail("Confirme a prévia para gravar a skill.");
    const clean = normalizeImport(input);
    return add(clean, { origem: "importada", assistantId: input.assistantId || null });
  }

  function installOasis() {
    const found = items.find((item) => item.origem === "pagina-oasis");
    if (found) return view(found, true);
    return add(normalizeImport({ markdown: OASIS_SKILL }), { origem: "pagina-oasis" });
  }

  function read(id, assistantId) {
    const item = items.find((entry) => entry.id === id);
    if (!item) return null;
    if (item.assistantId && assistantId && item.assistantId !== assistantId) return null;
    return view(item, true);
  }

  function catalog(assistantId) {
    return visible(assistantId).map((item) => `${item.name} (${item.id}): ${item.description}`);
  }

  function detach(assistantId) {
    let changed = false;
    for (const item of items) {
      if (item.assistantId === assistantId) {
        item.assistantId = null;
        changed = true;
      }
    }
    if (changed) save();
    return changed;
  }

  function remove(id) {
    const before = items.length;
    items = items.filter((item) => item.id !== id);
    if (items.length !== before) save();
    return items.length !== before;
  }

  return {
    list: (assistantId) => (assistantId ? visible(assistantId) : items).map((item) => view(item, false)),
    preview,
    apply,
    installOasis,
    read,
    catalog,
    detach,
    remove,
    file,
  };
}

const { createSkillFs, parseFrontmatter } = require("./skill-fs");

module.exports = {
  createSkills,
  parseSkillMd,
  normalizeImport,
  OASIS_SKILL,
  createSkillFs,
  parseFrontmatter,
};
