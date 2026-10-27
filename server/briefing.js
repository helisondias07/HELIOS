"use strict";

const { redact } = require("./util");

/**
 * Briefing de 4 campos: toda delegação a um ajudante efêmero diz o que perguntar, onde procurar,
 * em que formato entregar e onde parar. Sem os 4, nada é executado e o assistente recebe o erro.
 */
const FIELDS = [
  { key: "pergunta", min: 5, max: 400, help: "a pergunta exata que o ajudante deve responder" },
  { key: "fontes", min: 3, max: 400, help: "onde procurar (sites, conectores, arquivos) e o que ele pode consultar" },
  { key: "formato", min: 3, max: 300, help: "como entregar (ex.: lista de 5 itens, tabela, sim/não com motivo)" },
  { key: "fronteira", min: 5, max: 400, help: "o que NÃO fazer e onde parar (ex.: não enviar nada; parar nas 3 primeiras vagas)" },
];

const cleanText = (value, max) => redact(String(value ?? "").replace(/\s+/g, " ").trim()).slice(0, max);

/** Aceita texto ou lista (fontes costuma vir como lista). */
function asText(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean).join("; ");
  return String(value ?? "");
}

/**
 * @param {object} args argumentos da ferramenta de delegação
 * @returns {{ok:true, briefing:{pergunta:string, fontes:string, formato:string, fronteira:string}} | {ok:false, missing:string[], error:string}}
 */
function validateBriefing(args = {}) {
  const briefing = {};
  const missing = [];
  for (const field of FIELDS) {
    const text = cleanText(asText(args?.[field.key]), field.max);
    if (text.replace(/[\s\p{P}]/gu, "").length < field.min) missing.push(field);
    else briefing[field.key] = text;
  }
  if (missing.length) {
    const names = missing.map((field) => field.key).join(", ");
    const how = missing.map((field) => `${field.key} = ${field.help}`).join("; ");
    return {
      ok: false,
      missing: missing.map((field) => field.key),
      error: `Briefing incompleto: faltam ou estão curtos demais: ${names}. Nada foi executado. Toda delegação precisa dos 4 campos (pergunta, fontes, formato, fronteira). Preencha: ${how}.`,
    };
  }
  return { ok: true, briefing };
}

module.exports = { validateBriefing, FIELDS };