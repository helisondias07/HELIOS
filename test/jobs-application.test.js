"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { STATES, pageResult, transition } = require("../server/jobs-application");
const { BUTTONS, clickScript } = require("../server/jobs-fill");

test("candidatura só vira enviada com evidência do site", () => {
  assert.equal(pageResult({ text: "Obrigado por se candidatar!" }).state, STATES.SUBMITTED);
  assert.equal(pageResult({ url: "https://site.test/application/success", text: "", formVisible: false }).state, STATES.SUBMITTED);
  assert.equal(pageResult({ text: "Ainda falta responder uma pergunta", formVisible: true }).state, STATES.FILLING);
  assert.equal(pageResult({ text: "", challenge: "captcha" }).state, STATES.NEEDS_USER);
});

test("estados da candidatura não permitem reportar sucesso por clique isolado", () => {
  assert.equal(transition(STATES.OPENING, "opened").state, STATES.FILLING);
  assert.equal(transition(STATES.FILLING, "submit").state, STATES.SUBMITTING);
  assert.equal(transition(STATES.SUBMITTING, "failed").state, STATES.FAILED);
  assert.equal(transition(STATES.SUBMITTED, "failed").state, STATES.SUBMITTED);
});

test("botões de candidatura aceitam labels modernos e atributos de acessibilidade", () => {
  assert.equal(BUTTONS.submit.test("submit application"), true);
  const script = clickScript("submit");
  for (const token of ["aria-label", "data-testid", "role=\"button\"", "scrollIntoView", "getClientRects"]) assert.match(script, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), token);
  assert.throws(() => clickScript("nao-existe"), /desconhecido/);
});
