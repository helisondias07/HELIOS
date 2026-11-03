"use strict";

/**
 * LEVA M: score de match — pré-filtro por palavras-chave + nota do modelo (opcional).
 * Escolha do idioma do CV (PT/EN) conforme a descrição da vaga.
 */
const { scoreJob } = require("./jobs");

function detectJobLanguage(job = {}) {
  const text = `${job.title || ""} ${job.description || ""} ${job.location || ""}`;
  const enHits = (text.match(/\b(the|and|with|for|remote|engineer|developer|experience|years|requirements)\b/gi) || []).length;
  const ptHits = (text.match(/\b(vaga|remoto|desenvolvedor|experiencia|requisitos|anos|empresa|candidatura)\b/gi) || []).length;
  if (enHits >= 3 && enHits > ptHits) return "en";
  return "pt";
}

function pickCvPath(perfil = {}, job = {}) {
  const lang = detectJobLanguage(job);
  if (lang === "en" && perfil.cvPathEn) return { lang: "en", cvPath: perfil.cvPathEn };
  if (lang === "pt" && perfil.cvPathPt) return { lang: "pt", cvPath: perfil.cvPathPt };
  return { lang, cvPath: perfil.cvPath || perfil.cvPathPt || perfil.cvPathEn || "" };
}

function keywordPass(job, prefs = {}) {
  const { score, motivos } = scoreJob(job, { profileText: "", prefs });
  const min = Number(prefs.notaMinima) || 40;
  return { pass: score >= Math.min(25, min), score, motivos };
}

/**
 * Nota pelo modelo. Se não houver scorer, devolve só o pré-filtro.
 * scorer({ perfil, job }) => { score: 0-100, motivos: string[] }
 */
async function matchScore(job, { prefs = {}, profileText = "", perfil = {}, scorer = null } = {}) {
  const pre = scoreJob(job, { profileText, prefs });
  if (pre.score === 0) {
    return { score: 0, motivos: pre.motivos, prefilter: pre.score, model: null, cv: pickCvPath(perfil, job) };
  }
  let model = null;
  if (typeof scorer === "function") {
    try {
      const r = await scorer({ perfil, job, profileText, prefilter: pre.score });
      if (r && Number.isFinite(Number(r.score))) {
        model = { score: Math.max(0, Math.min(100, Number(r.score))), motivos: Array.isArray(r.motivos) ? r.motivos.slice(0, 8) : [] };
      }
    } catch {
      model = null;
    }
  }
  const score = model ? Math.round((pre.score * 0.4) + (model.score * 0.6)) : pre.score;
  const motivos = [...pre.motivos, ...(model?.motivos || [])].slice(0, 10);
  return { score, motivos, prefilter: pre.score, model, cv: pickCvPath(perfil, job) };
}

module.exports = { detectJobLanguage, pickCvPath, keywordPass, matchScore };
