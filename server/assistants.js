"use strict";

const path = require("node:path");
const { newId, nowIso, readJson, writeJson } = require("./util");
const { cleanModes } = require("./autonomy");

const DEFAULT_ID = "default";

/** O assistente de sempre. Não fica no arquivo: existe em todo HELIOS, sem migração. */
const DEFAULT_ASSISTANT = Object.freeze({
  id: DEFAULT_ID,
  name: "HELIOS",
  role: "Assistente geral",
  instructions: "",
  mcp: null,
  autonomy: {},
  builtin: true,
  template: null,
});

const TEMPLATES = [
  {
    id: "caixa-de-entrada",
    name: "Caixa de entrada",
    role: "Triagem de e-mails e mensagens",
    instructions: [
      "Você faz a triagem das mensagens do Helison: separa o que é urgente, o que pode esperar e o que é ruído.",
      "Resuma cada item em uma ou duas linhas e proponha a resposta. Nunca envie nada sem o cartão de aprovação.",
      "Se faltar contexto para decidir (quem é a pessoa, qual prazo), use perguntar_ao_helison em vez de chutar.",
    ].join("\n"),
  },
  {
    id: "estudos",
    name: "Estudos",
    role: "Tutor de front-end e inglês",
    instructions: [
      "Você é tutor do Helison, desenvolvedor front-end júnior. Explique em passos curtos, com um exemplo pequeno por conceito.",
      "Depois de explicar, faça uma pergunta de fixação. Monte planos de estudo semanais realistas.",
      "Não entregue o código inteiro quando ele pedir para aprender: guie e deixe ele escrever.",
    ].join("\n"),
  },
  {
    id: "codigo",
    name: "Código",
    role: "Revisão e pequenas mudanças de código",
    instructions: [
      "Você ajuda com código do Helison: revisa, explica e faz mudanças pequenas e focadas.",
      "Prefira o menor ajuste que resolve. Diga o que mudou e como testar. Para gravar um arquivo use escrever_arquivo, que passa pela autonomia.",
      "Nunca invente que rodou testes. Se não rodou, diga.",
    ].join("\n"),
  },
  {
    id: "pesquisa",
    name: "Pesquisa",
    role: "Pesquisa na web com fonte",
    instructions: [
      "Você pesquisa e compara. Toda afirmação importante cita o título e a URL da fonte devolvida pela ferramenta.",
      "Separe fato de opinião, aponte quando as fontes divergem e diga o que não conseguiu confirmar.",
      "Termine com um resumo de três linhas e o que vale checar a mais.",
    ].join("\n"),
  },
  {
    id: "financas-da-casa",
    name: "Finanças da casa",
    role: "Contas, vencimentos e orçamento doméstico",
    instructions: [
      "Você organiza as finanças da casa do Helison: contas a pagar, vencimentos, resumo do mês e metas. Valores sempre em reais (R$).",
      "O HELIOS não move dinheiro e pagar sempre exige o cartão de aprovação. Nunca peça nem guarde número de cartão, senha ou dados de acesso do banco.",
      "Na dúvida sobre um valor ou data, pergunte com perguntar_ao_helison.",
    ].join("\n"),
  },
  {
    id: "agenda",
    name: "Agenda",
    role: "Compromissos, lembretes e rotinas",
    instructions: [
      "Você cuida da agenda do Helison: compromissos, lembretes e conflitos de horário. Use sempre o horário de Brasília (America/Sao_Paulo).",
      "Para lembretes recorrentes, use agendar_rotina. Avise se dois compromissos baterem e sugira alternativas.",
      "Convidar pessoas ou enviar confirmações é enviar: só depois do cartão de aprovação.",
    ].join("\n"),
  },
];

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function cleanText(value, max) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function cleanMcp(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw fail("Conectores permitidos: use uma lista de nomes.");
  const names = value.map((item) => cleanText(item, 40)).filter(Boolean);
  return [...new Set(names)].slice(0, 30);
}

function view(item) {
  return {
    id: item.id,
    name: item.name,
    role: item.role,
    instructions: item.instructions,
    mcp: item.mcp === null || item.mcp === undefined ? null : [...item.mcp],
    autonomy: { ...(item.autonomy || {}) },
    builtin: Boolean(item.builtin),
    template: item.template || null,
    createdBy: item.createdBy ? { assistantId: item.createdBy.assistantId, name: item.createdBy.name } : null,
    pending: item.status === "pendente",
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  };
}

function createAssistants(dataDir) {
  const file = path.join(dataDir, "assistants.json");
  const saved = readJson(file, { version: 1, items: [] });
  let items = Array.isArray(saved.items) ? saved.items.filter((item) => item && typeof item.id === "string" && item.id !== DEFAULT_ID) : [];
  const save = () => writeJson(file, { version: 1, items });

  // Assistente criado por um bot só passa a existir (aparece, é resolvido, recebe conversa) depois da aprovação.
  const isActive = (item) => item.status !== "pendente";
  const list = () => [view(DEFAULT_ASSISTANT), ...items.filter(isActive).map(view)];
  const listPending = () => items.filter((item) => !isActive(item)).map(view);

  function get(id) {
    if (!id || id === DEFAULT_ID) return view(DEFAULT_ASSISTANT);
    const found = items.find((item) => item.id === id && isActive(item));
    return found ? view(found) : null;
  }

  /** Assistente (ativo ou pendente) pelo id. Serve para o cartão de aprovação. */
  function getAny(id) {
    const found = items.find((item) => item.id === id);
    return found ? view(found) : get(id);
  }

  /** Assistente da conversa. Id ausente ou desconhecido cai no padrão: conversa antiga nunca fica sem dono. */
  function resolve(id) {
    return get(id) || view(DEFAULT_ASSISTANT);
  }

  /** Acha por id ou por nome (sem diferenciar maiúsculas). */
  function find(ref) {
    const key = String(ref || "").trim().toLowerCase();
    if (!key) return null;
    return list().find((item) => item.id.toLowerCase() === key || item.name.toLowerCase() === key) || null;
  }

  function fields(input, base = {}) {
    const name = input.name !== undefined ? cleanText(input.name, 40) : base.name;
    if (!name || name.length < 2) throw fail("Dê um nome ao assistente (2 a 40 letras).");
    const taken = [view(DEFAULT_ASSISTANT), ...items.map(view)].find((item) => item.name.toLowerCase() === name.toLowerCase() && item.id !== base.id);
    if (taken) throw fail("Já existe um assistente com esse nome.", 409);
    return {
      name,
      role: input.role !== undefined ? cleanText(input.role, 120) : (base.role || ""),
      instructions: input.instructions !== undefined ? cleanText(input.instructions, 2000) : (base.instructions || ""),
      mcp: input.mcp !== undefined ? cleanMcp(input.mcp) : (base.mcp ?? null),
      autonomy: input.autonomy !== undefined ? cleanModes(input.autonomy) : { ...(base.autonomy || {}) },
    };
  }

  function create(input = {}) {
    const template = input.template ? TEMPLATES.find((item) => item.id === input.template) : null;
    if (input.template && !template) throw fail("Modelo de assistente desconhecido.");
    const seed = template ? { name: template.name, role: template.role, instructions: template.instructions } : {};
    const data = fields({ ...seed, ...input }, {});
    const item = { id: newId("ast"), ...data, template: template ? template.id : null, createdAt: nowIso(), updatedAt: nowIso() };
    items.push(item);
    save();
    return view(item);
  }

  function update(id, patch = {}) {
    if (!id || id === DEFAULT_ID) throw fail("O assistente padrão não pode ser editado. Crie outro a partir de um modelo.", 400);
    const item = items.find((entry) => entry.id === id && isActive(entry));
    if (!item) return null;
    Object.assign(item, fields(patch, item), { updatedAt: nowIso() });
    save();
    return view(item);
  }

  function remove(id) {
    if (!id || id === DEFAULT_ID) throw fail("O assistente padrão não pode ser removido.", 400);
    const before = items.length;
    items = items.filter((entry) => entry.id !== id);
    if (items.length === before) return false;
    save();
    return true;
  }

  /** Quantos assistentes foram criados por bots (aprovados ou ainda pendentes). */
  const createdByBots = () => items.filter((item) => item.createdBy).length;

  /** Um bot propõe um assistente. Fica pendente até o Helison aprovar no cartão. */
  function propose(input = {}, createdBy) {
    const data = fields(input, {});
    const item = {
      id: newId("ast"),
      ...data,
      template: null,
      createdBy: { assistantId: String(createdBy.assistantId), name: String(createdBy.name) },
      status: "pendente",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    items.push(item);
    save();
    return view(item);
  }

  function approve(id) {
    const item = items.find((entry) => entry.id === id && !isActive(entry));
    if (!item) return null;
    delete item.status;
    item.updatedAt = nowIso();
    save();
    return view(item);
  }

  /** Nega (ou cancela) um assistente pendente: ele nunca chega a existir. */
  function reject(id) {
    const before = items.length;
    items = items.filter((entry) => !(entry.id === id && !isActive(entry)));
    if (items.length === before) return false;
    save();
    return true;
  }

  return { list, listPending, get, getAny, resolve, find, create, update, remove, propose, approve, reject, createdByBots, templates: () => TEMPLATES.map((item) => ({ ...item })), file };
}

module.exports = { createAssistants, DEFAULT_ID, TEMPLATES };
