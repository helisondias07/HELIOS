"use strict";

const path = require("node:path");
const { newId, nowIso, readJson, writeJson, redact } = require("./util");
const { unsafeReason } = require("./memory");

/**
 * Tarefas "estacionadas": quando um assistente, ajudante ou rotina não consegue continuar
 * (falta aprovação, informação ou bateu num limite), o estado fica em disco e a tarefa termina limpa.
 * A Caixa de entrada mostra a pergunta exata e o botão "Retomar", que continua do estado salvo.
 * O estado é só texto curto (objetivo, passos feitos, o que falta): nunca senha, token ou chave.
 */
const MOTIVOS = {
  aprovacao: "falta uma aprovação",
  informacao: "falta uma informação",
  limite: "um limite foi atingido",
  outro: "outro motivo",
};
const OPEN_MAX = 30;
const LIST_MAX = 8;

const fold = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const oneLine = (text, max) => redact(String(text ?? "").replace(/\s+/g, " ").trim()).slice(0, max);

function cleanList(input, max) {
  const raw = Array.isArray(input) ? input : typeof input === "string" && input.trim() ? [input] : [];
  return raw.map((item) => oneLine(item, max)).filter(Boolean).slice(0, LIST_MAX);
}

function cleanMotivo(value) {
  const key = String(value || "").toLowerCase();
  if (MOTIVOS[key]) return key;
  if (/aprov/.test(key)) return "aprovacao";
  if (/info|dado|resposta/.test(key)) return "informacao";
  if (/limit|tempo/.test(key)) return "limite";
  return "outro";
}

/** Valida e limpa o que o agente quer guardar. Texto com cara de segredo é recusado, não gravado. */
function normalize(input = {}) {
  const objetivo = oneLine(input.objetivo, 300);
  const pergunta = oneLine(input.pergunta, 500);
  if (objetivo.length < 5) throw fail("Diga o objetivo da tarefa (objetivo).");
  if (pergunta.length < 3) throw fail("Escreva a pergunta exata que o Helison precisa responder (pergunta).");
  const feito = cleanList(input.feito, 200);
  const falta = cleanList(input.falta, 200);
  const raw = [input.objetivo, input.pergunta, ...(Array.isArray(input.feito) ? input.feito : [input.feito]), ...(Array.isArray(input.falta) ? input.falta : [input.falta])];
  for (const piece of raw) {
    const bad = unsafeReason(String(piece ?? ""));
    if (bad && bad !== "tem um e-mail") throw fail(`Não guardo isso no estado da tarefa: ${bad}. Reescreva sem segredos.`);
  }
  return { objetivo, pergunta, feito, falta, motivo: cleanMotivo(input.motivo) };
}

function createParking(dataDir, { now = () => Date.now() } = {}) {
  const file = path.join(dataDir, "estacionadas.json");
  const saved = readJson(file, { version: 1, items: [] });
  // Arquivo editado à mão: só entra o que tem forma de tarefa, sempre limpo de novo.
  const items = (Array.isArray(saved.items) ? saved.items : [])
    .filter((item) => item && typeof item.id === "string" && typeof item.objetivo === "string")
    .map((item) => ({
      id: String(item.id).slice(0, 40),
      assistantId: String(item.assistantId || "default").slice(0, 40),
      convId: String(item.convId || "").slice(0, 60),
      questionId: String(item.questionId || "").slice(0, 60),
      origin: String(item.origin || "conversa").slice(0, 20),
      objetivo: oneLine(item.objetivo, 300),
      pergunta: oneLine(item.pergunta, 500),
      feito: cleanList(item.feito, 200),
      falta: cleanList(item.falta, 200),
      motivo: cleanMotivo(item.motivo),
      state: ["estacionada", "retomada", "descartada"].includes(item.state) ? item.state : "estacionada",
      createdAt: item.createdAt || nowIso(),
      updatedAt: item.updatedAt || item.createdAt || nowIso(),
      resumedAt: item.resumedAt || null,
      resumes: Number(item.resumes) > 0 ? Math.round(Number(item.resumes)) : 0,
    }));
  const save = () => writeJson(file, { version: 1, items });

  const get = (id) => items.find((item) => item.id === id) || null;
  const open = () => items.filter((item) => item.state === "estacionada");

  function view(item) {
    return {
      id: item.id,
      assistantId: item.assistantId,
      convId: item.convId,
      questionId: item.questionId,
      origin: item.origin,
      objetivo: item.objetivo,
      pergunta: item.pergunta,
      feito: item.feito,
      falta: item.falta,
      motivo: item.motivo,
      motivoLabel: MOTIVOS[item.motivo],
      state: item.state,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      resumedAt: item.resumedAt,
      resumes: item.resumes,
    };
  }

  /** Salva (ou atualiza, se a mesma conversa estacionou o mesmo objetivo) uma tarefa. */
  function park({ assistantId, convId, origin, ...input }) {
    const clean = normalize(input);
    const same = open().find((item) => item.convId === convId && fold(item.objetivo) === fold(clean.objetivo));
    if (same) {
      Object.assign(same, clean, { updatedAt: nowIso() });
      save();
      return { entry: same, updated: true };
    }
    const mine = open().filter((item) => item.assistantId === (assistantId || "default")).length;
    if (mine >= OPEN_MAX) throw fail(`Já existem ${mine} tarefas estacionadas deste assistente. Peça ao Helison para retomar ou descartar algumas na Caixa de entrada.`);
    const at = new Date(now()).toISOString();
    const entry = {
      id: newId("est"),
      assistantId: String(assistantId || "default"),
      convId: String(convId || ""),
      questionId: "",
      origin: String(origin || "conversa"),
      ...clean,
      state: "estacionada",
      createdAt: at,
      updatedAt: at,
      resumedAt: null,
      resumes: 0,
    };
    items.push(entry);
    save();
    return { entry, updated: false };
  }

  function attach(id, questionId) {
    const item = get(id);
    if (!item) return null;
    item.questionId = String(questionId || "");
    save();
    return item;
  }

  function markResumed(id) {
    const item = get(id);
    if (!item || item.state !== "estacionada") return null;
    item.state = "retomada";
    item.resumedAt = new Date(now()).toISOString();
    item.resumes += 1;
    item.updatedAt = item.resumedAt;
    save();
    return item;
  }

  function discard(id) {
    const item = get(id);
    if (!item || item.state !== "estacionada") return null;
    item.state = "descartada";
    item.updatedAt = new Date(now()).toISOString();
    save();
    return item;
  }

  /** Bloco de texto com o estado salvo, para o agente continuar de onde parou. */
  function stateBlock(item) {
    const lines = [
      "[TAREFA ESTACIONADA - retome deste estado salvo]",
      `Objetivo: ${item.objetivo}`,
      `Motivo da parada: ${MOTIVOS[item.motivo]}.`,
      item.feito.length ? `Já feito:\n${item.feito.map((step) => `- ${step}`).join("\n")}` : "Já feito: nada registrado.",
      item.falta.length ? `Falta:\n${item.falta.map((step) => `- ${step}`).join("\n")}` : "Falta: o que o objetivo ainda pede.",
      "Continue só do que falta e não repita o que já foi feito. Enviar, apagar, pagar, publicar e preencher login continuam passando por cartão de aprovação.",
    ];
    return lines.join("\n");
  }

  return {
    park,
    attach,
    get,
    markResumed,
    discard,
    stateBlock,
    open: () => open().map(view),
    list: () => items.map(view),
    hasOpenFor: (convId) => open().some((item) => item.convId === convId),
    file,
  };
}

module.exports = { createParking, MOTIVOS, OPEN_MAX };