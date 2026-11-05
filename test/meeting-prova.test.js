"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const prompts = require("../src/meeting-prompts");
const providers = require("../src/providers");
const { VISION_MODEL } = require("../src/meeting-host");

const host = fs.readFileSync(path.join(__dirname, "../src/meeting-host.js"), "utf8");
const LINES = [{ who: "them", text: "Can you tell me about your experience with Wake?" }];

test("Ada questão 19: gabarito é V, V, F, V, F", () => {
  assert.equal(prompts.ADA_Q19.length, 5);
  assert.equal(prompts.verdictLine(prompts.ADA_Q19), "Verdadeiro, verdadeiro, falso, verdadeiro, falso.");
});

test("tela de prova: o prompt manda julgar cada item e proíbe todas falsas", () => {
  assert.match(prompts.SCREEN_EXAM, /CADA afirmação/);
  assert.match(prompts.SCREEN_EXAM, /todas são falsas/);
  assert.match(prompts.SCREEN_EXAM, /Verdadeiro, verdadeiro, falso, verdadeiro, falso/);
  const ask = prompts.ask(LINES, "qual a resposta da questão?", { withScreen: true })[1].content;
  assert.match(ask, /CADA afirmação/);
  assert.doesNotMatch(ask, /até 20 palavras/);
  const plain = prompts.ask(LINES, "o que é CDN?")[1].content;
  assert.match(plain, /texto corrido/i);
  assert.doesNotMatch(plain, /bullet/);
  const sug = prompts.suggest(LINES, { lang: "pt", withScreen: true })[1].content;
  assert.match(sug, /CADA afirmação/);
  assert.match(sug, /MESMA correção/);
});

test("visão: a imagem entra no pedido, com temperatura baixa e modelo mais capaz", () => {
  const body = providers.toGemini(
    [{ role: "system", content: "leia a prova" }, { role: "user", content: "responda" }],
    "QUFB",
    { temperature: 0.1, maxOutputTokens: 1400 },
  );
  const parts = body.contents[0].parts;
  assert.equal(parts[0].text, "responda");
  assert.equal(parts[1].inline_data.mime_type, "image/jpeg");
  assert.equal(parts[1].inline_data.data, "QUFB");
  assert.equal(body.generationConfig.temperature, 0.1);
  assert.ok(body.generationConfig.maxOutputTokens >= 1400);
  const sem = providers.toGemini([{ role: "user", content: "oi" }], null);
  assert.equal(sem.contents[0].parts.length, 1);
  assert.equal(sem.generationConfig.temperature, 0.4);
  assert.equal(VISION_MODEL, "gemini-2.5-flash");
  assert.match(host, /\[VISION_MODEL, current\.geminiModel\]/);
  assert.match(host, /temperature: imageBase64 \? 0\.1/);
  assert.match(host, /toJPEG\(88\)/);
});
