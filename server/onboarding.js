"use strict";

const path = require("node:path");
const { readJson, writeJson } = require("./util");
const { tokens } = require("./memory");
const { HINTS } = require("./gabinete");
const { TEMPLATES } = require("./assistants");

const STARTER = ["caixa-de-entrada", "agenda", "pesquisa"];

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function stem(word) {
  return word.slice(0, 5);
}

function scoreTemplate(text, template) {
  const wanted = new Set(tokens(text).map(stem));
  const bag = [template.name, template.role, HINTS[template.id] || "", String(template.instructions || "").slice(0, 400)].join(" ");
  let score = 0;
  const why = [];
  for (const word of new Set(tokens(bag).map(stem))) {
    if (!wanted.has(word)) continue;
    score += 1;
    why.push(word);
  }
  return { score, why };
}

function proposeTeam(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 1000);
  if (clean.length < 3) throw fail("Conte o objetivo para eu sugerir o time.");
  const aviso = /\b(nota fiscal|nf-e|nfe|logistica|marketplace|mercado livre)\b/i.test(clean)
    ? "Nota fiscal, logística e marketplace não viram assistente novo. O HELIOS só propõe os seis modelos que já existem."
    : "";
  const ranked = TEMPLATES
    .map((template) => ({ template, ...scoreTemplate(clean, template) }))
    .sort((a, b) => b.score - a.score || a.template.name.localeCompare(b.template.name, "pt-BR"));
  const vague = tokens(clean).length < 4 || ranked[0].score < 2;
  const picked = vague
    ? STARTER.map((id) => TEMPLATES.find((item) => item.id === id))
    : ranked.filter((row) => row.score > 0).slice(0, 3).map((row) => row.template);
  const chosen = picked.length ? picked : STARTER.map((id) => TEMPLATES.find((item) => item.id === id));
  return {
    executed: false,
    aviso,
    note: "Nada foi criado. Escolha os modelos e confirme. O clique é a sua aprovação.",
    propostas: chosen.map((template) => {
      const row = ranked.find((item) => item.template.id === template.id);
      return {
        id: template.id,
        name: template.name,
        role: template.role,
        score: row ? row.score : 0,
        porque: vague ? "Trio inicial para quem ainda está descrevendo o trabalho." : `Combina com ${template.name}.`,
      };
    }),
  };
}

function createOnboarding({ dataDir, assistants, routines }) {
  const file = path.join(dataDir, "onboarding.json");
  const saved = readJson(file, { voz: false });
  const flags = { voz: saved.voz === true };
  const save = () => writeJson(file, flags);

  function aplicar(modelos) {
    const ids = [...new Set((Array.isArray(modelos) ? modelos : []).map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) throw fail("Escolha pelo menos um modelo.");
    const created = [];
    const skipped = [];
    for (const id of ids) {
      const template = TEMPLATES.find((item) => item.id === id);
      if (!template) throw fail("Modelo de assistente desconhecido.");
      const exists = assistants.list().find((item) => item.template === id || item.name.toLowerCase() === template.name.toLowerCase());
      if (exists) {
        skipped.push({ id, name: template.name, motivo: "Esse modelo já está no time." });
        continue;
      }
      created.push(assistants.create({ template: id }));
    }
    return { executed: true, created, skipped };
  }

  function checklist() {
    const team = assistants.list().some((item) => item.template);
    const morning = routines.list().some((item) => item.modelo === "digest-manha");
    return {
      itens: [
        { id: "voz", label: "Experimentar a conversa por voz no chat", done: flags.voz === true },
        { id: "time", label: "Ter pelo menos um assistente além do HELIOS", done: team },
        { id: "manha", label: "Instalar o digest da manhã (ele entra pausado)", done: morning },
      ],
    };
  }

  function mark(patch = {}) {
    if (patch.voz !== undefined) flags.voz = patch.voz === true;
    save();
    return checklist();
  }

  return { propose: proposeTeam, aplicar, checklist, mark, file };
}

module.exports = { createOnboarding, proposeTeam, STARTER };
