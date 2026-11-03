"use strict";

/**
 * Máquina de estados da candidatura. A página pode trocar de layout várias
 * vezes; o resultado só é sucesso quando há evidência de envio, nunca apenas
 * porque um botão foi clicado.
 */
const STATES = Object.freeze({
  OPENING: "opening",
  FILLING: "filling",
  REVIEW: "review",
  SUBMITTING: "submitting",
  SUBMITTED: "submitted",
  NEEDS_USER: "needs_user",
  FAILED: "failed",
});

const TERMINAL = new Set([STATES.SUBMITTED, STATES.NEEDS_USER, STATES.FAILED]);

function evidence(kind, detail = "") {
  return { kind: String(kind || "observation"), detail: String(detail || "").slice(0, 500), at: new Date().toISOString() };
}

function pageResult({ url = "", text = "", formVisible = true, challenge = "" } = {}) {
  const body = String(text || "");
  if (challenge) return { state: STATES.NEEDS_USER, reason: String(challenge), evidence: [evidence("challenge", challenge)] };
  if (/(candidatura (foi )?enviada|inscri[cç][aã]o (foi )?(realizada|enviada|conclu[ií]da)|application (was )?(sent|submitted)|you applied|voc[eê] se candidatou|candidatura realizada|obrigado por se candidatar)/i.test(body)) {
    return { state: STATES.SUBMITTED, reason: "O site confirmou o envio.", evidence: [evidence("success-text", body.match(/.{0,80}(candidatura|application|inscri[cç][aã]o).{0,120}/i)?.[0] || "confirmação visível")] };
  }
  if (/success|thank[- ]you|confirmation|submitted/i.test(String(url || "")) && !formVisible) {
    return { state: STATES.SUBMITTED, reason: "A URL e a ausência do formulário indicam confirmação.", evidence: [evidence("success-url", url)] };
  }
  return { state: formVisible ? STATES.FILLING : STATES.REVIEW, reason: "Ainda não há confirmação de envio.", evidence: [evidence("page", `${url} ${formVisible ? "formulário visível" : "formulário não visível"}`)] };
}

function transition(current, event, data = {}) {
  const state = current || STATES.OPENING;
  if (TERMINAL.has(state)) return { state, ...data };
  if (event === "opened") return { state: STATES.FILLING, ...data };
  if (event === "review") return { state: STATES.REVIEW, ...data };
  if (event === "submit") return { state: STATES.SUBMITTING, ...data };
  if (event === "challenge") return { state: STATES.NEEDS_USER, ...data };
  if (event === "submitted") return { state: STATES.SUBMITTED, ...data };
  if (event === "failed") return { state: STATES.FAILED, ...data };
  return { state, ...data };
}

module.exports = { STATES, TERMINAL, evidence, pageResult, transition };
