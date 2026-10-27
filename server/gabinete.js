"use strict";

const { tokens } = require("./memory");

/**
 * "Chefe de gabinete": dado um pedido em linguagem natural, SUGERE qual assistente especialista
 * deve cuidar dele. Nunca executa nada, nunca cria conversa e não lê memória nem segredos:
 * só compara as palavras do pedido com nome, função e instruções dos assistentes que já existem.
 */

// Palavras que costumam indicar cada modelo de assistente (ajuda quando o nome foi trocado).
const HINTS = {
  "caixa-de-entrada": "email e-mail emails mensagem mensagens inbox triagem responder resposta caixa remetente",
  estudos: "estudar estudo curso aprender aula prova ingles frontend html css javascript react exercicio",
  codigo: "codigo bug erro funcao repositorio programar teste testes refatorar commit script biblioteca",
  pesquisa: "pesquisar pesquisa buscar procurar comparar fonte noticia melhor alternativa avaliacao",
  "financas-da-casa": "conta contas boleto fatura orcamento gasto gastos vencimento vence dinheiro mercado salario despesa pagar pagamento",
  agenda: "agenda reuniao compromisso lembrete horario calendario marcar agendar",
};

const stem = (word) => word.slice(0, 5);

function words(text) {
  return [...new Set(tokens(text).map(stem))];
}

/** Pontua um assistente: nome pesa 3, função 2, modelo (dicas) 2, instruções 1. Cada palavra conta uma vez. */
function scoreAssistant(requestStems, assistant) {
  const weights = new Map();
  const add = (text, weight) => {
    for (const w of words(text)) weights.set(w, Math.max(weights.get(w) || 0, weight));
  };
  add(assistant.name, 3);
  add(assistant.role, 2);
  if (assistant.template && HINTS[assistant.template]) add(HINTS[assistant.template], 2);
  add(String(assistant.instructions || "").slice(0, 600), 1);
  let score = 0;
  const why = [];
  for (const w of requestStems) {
    const weight = weights.get(w);
    if (!weight) continue;
    score += weight;
    why.push(w);
  }
  return { score, why };
}

const brief = (item) => ({ assistantId: item.id, name: item.name, role: item.role || "" });

/**
 * @param {string} text pedido do usuário
 * @param {Array} list assistentes (inclui o padrão)
 * @returns {{executed:false, suggestion:object|null, alternatives:object[], note:string}}
 */
function suggest(text, list) {
  const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 1000);
  if (clean.length < 3) throw Object.assign(new Error("Escreva o pedido para eu sugerir quem cuida dele."), { status: 400 });
  const specialists = list.filter((item) => !item.builtin);
  const fallback = list.find((item) => item.builtin) || { id: "default", name: "HELIOS", role: "Assistente geral" };
  const request = words(clean);
  const ranked = specialists
    .map((item) => ({ item, ...scoreAssistant(request, item) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  const best = ranked[0];
  const second = ranked[1];
  const base = { executed: false, note: "É só uma sugestão: nada foi enviado nem executado. Você escolhe quem cuida." };
  if (!best || best.score < 2) {
    return { ...base, suggestion: { ...brief(fallback), confidence: "baixa", why: [], reason: specialists.length ? "Nenhum especialista combina bem com o pedido, então o assistente geral é o mais seguro." : "Você ainda não tem assistentes especialistas. O assistente geral cuida." }, alternatives: ranked.slice(0, 2).map((row) => ({ ...brief(row.item), score: row.score })) };
  }
  const margin = best.score - (second ? second.score : 0);
  const confidence = best.score >= 5 && margin >= 2 ? "alta" : best.score >= 3 && margin >= 1 ? "media" : "baixa";
  return {
    ...base,
    suggestion: { ...brief(best.item), confidence, score: best.score, why: best.why.slice(0, 6), reason: `Combina com ${best.item.name}${best.item.role ? ` (${best.item.role})` : ""}.` },
    alternatives: [...ranked.slice(1, 3).map((row) => ({ ...brief(row.item), score: row.score })), ...(confidence === "alta" ? [] : [{ ...brief(fallback), score: 0 }])],
  };
}

module.exports = { suggest, HINTS };