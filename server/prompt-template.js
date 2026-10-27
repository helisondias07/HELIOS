"use strict";

/**
 * Modelo padrão de prompt do HELIOS. Todo prompt de assistente, ajudante, consulta e verificador
 * sai daqui, com as mesmas seções, sempre na mesma ordem:
 *   papel -> contexto -> regras -> formato -> objetivo
 * A pergunta/pedido do momento (objetivo) fica por último: é o que o modelo lê por último.
 *
 * `headings`:
 *   - false (padrão): sem títulos, só os blocos em ordem. É o que os prompts antigos usam, então o
 *     texto de assistente e de consulta continua IGUAL ao que sempre foi.
 *   - true: cada seção ganha um título fixo ("## Papel", "## Contexto", "## Regras e limites",
 *     "## Formato de saída" e o título do objetivo).
 */
const SECTIONS = ["papel", "contexto", "regras", "formato", "objetivo"];
const TITLES = { papel: "Papel", contexto: "Contexto", regras: "Regras e limites", formato: "Formato de saída", objetivo: "Objetivo" };

const blocksOf = (value) => (Array.isArray(value) ? value : [value]).map((item) => (item === null || item === undefined || item === false ? "" : String(item))).filter(Boolean);

/**
 * @param {object} spec
 * @param {string|string[]} [spec.papel] quem é o agente
 * @param {string|string[]} [spec.contexto] o que ele precisa saber (blocos separados por linha em branco)
 * @param {string|string[]} [spec.regras] regras e limites
 * @param {string|string[]} [spec.formato] como responder
 * @param {string|string[]} [spec.objetivo] o pedido do momento
 * @param {boolean} [spec.headings]
 * @param {object} [spec.titles] títulos próprios por seção (só valem com headings, ou no objetivo)
 * @param {object} [spec.headingFor] força título ligado/desligado por seção (ex.: { objetivo: true })
 */
function renderPrompt(spec = {}) {
  const parts = [];
  for (const key of SECTIONS) {
    const blocks = blocksOf(spec[key]);
    if (!blocks.length) continue;
    const withTitle = spec.headingFor && key in spec.headingFor ? Boolean(spec.headingFor[key]) : Boolean(spec.headings);
    const body = blocks.join("\n\n");
    parts.push(withTitle ? `## ${(spec.titles && spec.titles[key]) || TITLES[key]}\n${body}` : body);
  }
  return parts.join("\n\n");
}

/** Lista as seções presentes e na ordem em que saíram (útil para teste e depuração). */
function outline(prompt) {
  return String(prompt || "").split("\n").filter((line) => /^## /.test(line)).map((line) => line.slice(3));
}

module.exports = { renderPrompt, outline, SECTIONS, TITLES };