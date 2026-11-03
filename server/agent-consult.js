"use strict";

const { newId, nowIso, redact } = require("./util");

const fold = (text) =>
  String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const ROUTES = [
  { id: "vagas", re: /\b(vagas?|emprego|curriculo|curriculum|linkedin|inscri|candidat|cv\b)/ },
  { id: "portfolio", re: /\b(portfolio|portfólio|projeto\s+de\s+portf)/ },
  { id: "lojas-wake", re: /\b(wake|lojas?|e-?commerce|vtex|template\s+da\s+loja)/ },
];

/**
 * Escolhe o assistente mais adequado pelo texto, sem expor lógica interna ao usuário.
 * @returns {{ assistantId:string, reason:string }}
 */
function routeAssistant(text, assistants = []) {
  const t = fold(text);
  const ids = new Set((assistants || []).map((a) => a.id));
  for (const row of ROUTES) {
    if (!row.re.test(t)) continue;
    if (ids.has(row.id)) {
      const name = assistants.find((a) => a.id === row.id)?.name || row.id;
      return { assistantId: row.id, reason: `Pedido combina com ${name}.` };
    }
  }
  const fallback = assistants.find((a) => a.builtin || a.id === "default") || assistants[0];
  if (fallback) return { assistantId: fallback.id, reason: `Assistente geral (${fallback.name || fallback.id}).` };
  return { assistantId: "default", reason: "Assistente geral HELIOS." };
}

function createAgentConsult({ agents, askFn, openWorker } = {}) {
  void openWorker;
  void agents;
  const log = [];

  async function consultar({ fromAgentId, toAssistantId, pergunta, parentAgentId }) {
    const from = String(fromAgentId || parentAgentId || "").slice(0, 40);
    const to = String(toAssistantId || "default").slice(0, 40);
    const q = redact(String(pergunta || "").replace(/\s+/g, " ").trim()).slice(0, 800);
    if (!from) throw Object.assign(new Error("Informe qual agente consulta."), { status: 400 });
    if (q.length < 3) throw Object.assign(new Error("Escreva a pergunta."), { status: 400 });

    // LEVA L: falha contida — nunca propaga exceção que derrube o pai; devolve ok:false.
    let resposta;
    let ok = true;
    let error = "";
    try {
      if (typeof askFn === "function") {
        const raw = await askFn(to, q);
        if (raw && typeof raw === "object" && raw.ok === false) {
          ok = false;
          error = redact(String(raw.error || "consulta falhou")).slice(0, 500);
          resposta = "";
        } else {
          resposta = redact(String(raw || "").trim()).slice(0, 4000);
        }
      } else {
        resposta = "Consulta registrada; resposta indisponível neste ambiente de teste.";
      }
    } catch (err) {
      ok = false;
      error = redact(String(err && err.message || err)).slice(0, 500);
      resposta = "";
    }

    const entry = {
      id: newId("cns"),
      fromAgentId: from,
      toAssistantId: to,
      pergunta: q,
      resposta,
      ok,
      error: error || null,
      contained: !ok,
      at: nowIso(),
    };
    log.push(entry);
    return { ...entry };
  }

  function list(agentId) {
    const key = String(agentId || "");
    return log
      .filter((entry) => !key || entry.fromAgentId === key)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .map((entry) => ({ ...entry }));
  }

  return { consultar, list };
}

module.exports = { createAgentConsult, routeAssistant };
