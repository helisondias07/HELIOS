"use strict";

// Fase 8: conjunto de avaliação local. Uso: npm run eval   (com --groq usa GROQ_API_KEY do ambiente para os casos "llm").
const fs = require("node:fs");
const path = require("node:path");
const { classify } = require("../server/router");
const { screenUserText } = require("../server/credentials");
const { isIrreversible } = require("../server/irreversible");
const { scoreJob } = require("../server/jobs");

const PREFS = { termos: ["desenvolvedor front-end"], incluir: ["remoto"], excluir: ["estágio"] };

async function askGroq(prompt, key) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "llama-3.1-8b-instant", temperature: 0, max_tokens: 60, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return String(data.choices?.[0]?.message?.content || "");
}

/** Roda um caso. Devolve { ok, skip, detalhe }. */
async function runCase(caso, { groqKey = "" } = {}) {
  const e = caso.espera || {};
  const fail = (detalhe) => ({ ok: false, detalhe });
  if (caso.tipo === "roteador") {
    const got = classify(caso.prompt).level;
    if (e.nivel && got !== e.nivel) return fail(`nível ${got}, esperado ${e.nivel}`);
    if (e.nivelNao && got === e.nivelNao) return fail(`nível ${got} não devia ser ${e.nivelNao}`);
    return { ok: true, detalhe: got };
  }
  if (caso.tipo === "segredo") {
    const out = screenUserText(caso.prompt);
    if (e.mascarado !== undefined && out.masked !== e.mascarado) return fail(`mascarado=${out.masked}`);
    for (const bad of e.naoContem || []) if (out.text.includes(bad)) return fail("segredo vazou");
    return { ok: true, detalhe: out.masked ? "mascarado" : "limpo" };
  }
  if (caso.tipo === "irreversivel") {
    const got = Boolean(isIrreversible(caso.prompt));
    return got === e.irreversivel ? { ok: true, detalhe: String(got) } : fail(`irreversível=${got}`);
  }
  if (caso.tipo === "vaga") {
    const [title, location, description] = caso.prompt.split("|").map((part) => part.trim());
    const { score } = scoreJob({ title, company: "", location, description }, { profileText: "front-end React", prefs: PREFS });
    if (e.notaMin !== undefined && score < e.notaMin) return fail(`nota ${score} < ${e.notaMin}`);
    if (e.notaMax !== undefined && score > e.notaMax) return fail(`nota ${score} > ${e.notaMax}`);
    return { ok: true, detalhe: `nota ${score}` };
  }
  if (caso.tipo === "llm") {
    if (!groqKey) return { ok: true, skip: true, detalhe: "pulado (sem --groq/GROQ_API_KEY)" };
    const text = (await askGroq(caso.prompt, groqKey)).toLowerCase();
    for (const want of e.contem || []) if (!text.includes(String(want).toLowerCase())) return fail(`resposta sem "${want}": ${text.slice(0, 80)}`);
    return { ok: true, detalhe: text.slice(0, 60) };
  }
  return fail(`tipo desconhecido: ${caso.tipo}`);
}

async function runAll(file, opts = {}) {
  const { casos } = JSON.parse(fs.readFileSync(file, "utf8"));
  const results = [];
  for (const caso of casos) {
    let r;
    try { r = await runCase(caso, opts); } catch (err) { r = { ok: false, detalhe: err.message }; }
    results.push({ id: caso.id, tipo: caso.tipo, ...r });
  }
  return results;
}

module.exports = { runCase, runAll };

if (require.main === module) {
  const useGroq = process.argv.includes("--groq");
  const file = path.join(__dirname, "..", "evals", "casos.json");
  runAll(file, { groqKey: useGroq ? process.env.GROQ_API_KEY || "" : "" }).then((results) => {
    for (const r of results) console.log(`${r.skip ? "PULOU" : r.ok ? "OK   " : "FALHA"} | ${r.id} (${r.tipo}) | ${r.detalhe || ""}`);
    const failed = results.filter((r) => !r.ok).length;
    const skipped = results.filter((r) => r.skip).length;
    console.log(`resumo: ${results.length - failed - skipped} OK, ${failed} falha(s), ${skipped} pulado(s)`);
    process.exitCode = failed ? 1 : 0;
  });
}
