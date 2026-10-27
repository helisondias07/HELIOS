"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { applyMeetingProtection, meetingBrowserOptions, mainBrowserOptions } = require("../src/meeting-window");
const { createSettings } = require("../src/settings-store");
const { roteiro, suggest } = require("../src/meeting-prompts");
const { cleanHallucination, normLang, guessLang, stripCites, readSSE } = require("../src/providers");
const { isDuplicate, newSince, shownCursor, claimTranslate } = require("../renderer/meeting/lineutil");

test("a pílula fica fora da captura e da barra de tarefas", () => {
  const calls = [];
  const win = {
    setContentProtection(value) { calls.push(["protect", value]); },
    setSkipTaskbar(value) { calls.push(["skip", value]); },
    setAlwaysOnTop(value, level) { calls.push(["top", value, level]); },
    setVisibleOnAllWorkspaces(value) { calls.push(["spaces", value]); },
  };
  const on = applyMeetingProtection(win, {});
  assert.equal(on.contentProtection, true);
  assert.equal(on.skipTaskbar, true);
  assert.deepEqual(calls[0], ["protect", true]);
  assert.deepEqual(calls[1], ["skip", true]);
  assert.equal(calls[2][2], "screen-saver");
  const pill = meetingBrowserOptions();
  assert.equal(pill.skipTaskbar, true);
  assert.equal(pill.frame, false);
  assert.equal(pill.alwaysOnTop, true);
  assert.equal(pill.hasShadow, false);
  assert.equal(pill.width, 920);
  assert.equal(pill.resizable, true);
  assert.ok(pill.minWidth >= 640);
  const main = mainBrowserOptions();
  assert.equal(main.skipTaskbar, false);
  assert.equal(main.title, "HELIOS");
  const off = applyMeetingProtection(win, { HELIOS_NO_PROTECT: "1" });
  assert.equal(off.contentProtection, false);
});

test("configurações recusam porta inválida e cortam o contexto", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helios-set-"));
  const settings = createSettings(root);
  settings.update({ port: 80, opacity: 9, provider: "outro", meetingLang: "fr", chunkSeconds: 1, myContext: "x".repeat(5000), translate: true });
  assert.equal(settings.get("port"), 47331);
  assert.equal(settings.get("opacity"), 1);
  assert.equal(settings.get("provider"), "groq");
  assert.equal(settings.get("meetingLang"), "auto");
  assert.equal(settings.get("chunkSeconds"), 3);
  assert.equal(settings.get("translate"), true);
  assert.equal(settings.get("myContext").length, 4000);
  const disk = JSON.parse(fs.readFileSync(settings.file, "utf8"));
  assert.equal(disk.groq, undefined);
  assert.equal(disk.gemini, undefined);
});

test("o roteiro é para o Helison perguntar, em português", () => {
  const messages = roteiro([{ who: "them", text: "Can you walk me through the header?" }], "entrevista");
  const blob = messages.map((item) => item.content).join("\n");
  assert.match(blob, /português/);
  assert.match(blob, /entrevista/);
  assert.match(blob, /Não responda no lugar dele/);
  const sug = suggest([{ who: "them", text: "What did you ship?" }], { lang: "en" });
  assert.match(sug.map((item) => item.content).join("\n"), /EN:/);
});

test("transcrição descarta alucinação e o stream junta o texto", async () => {
  assert.equal(cleanHallucination("Thanks for watching."), "");
  assert.equal(cleanHallucination("vamos revisar o botão"), "vamos revisar o botão");
  assert.equal(normLang("Portuguese"), "pt");
  assert.equal(guessLang("não você que está com isso"), "pt");
  assert.equal(stripCites("olá【1†fonte】"), "olá");
  const chunks = [
    Buffer.from('data: {"choices":[{"delta":{"content":"olá "}}]}\n'),
    Buffer.from('data: {"choices":[{"delta":{"content":"Helison"}}]}\n'),
    Buffer.from("data: [DONE]\n"),
  ];
  const body = (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
  let seen = "";
  const text = await readSSE({ body }, (value) => { seen = value; });
  assert.equal(text, "olá Helison");
  assert.equal(seen, "olá Helison");
});

test("falas repetidas não entram de novo na tradução", () => {
  assert.equal(isDuplicate("Olá, tudo bem?", "ola tudo bem"), true);
  assert.equal(isDuplicate("hello", "olá"), false);
  assert.deepEqual(newSince([{ id: 1, text: "a" }, { id: 2, text: "b" }], 1).map((line) => line.id), [2]);
});

test("frases quase iguais contam como repetidas nas últimas falas", () => {
  assert.equal(isDuplicate("Can you walk me through the header?", "Can you walk me through the header, please?"), true);
  assert.equal(isDuplicate("sim", "sim sim"), false);
  const recent = [
    "abertura da reunião de hoje",
    "Can you walk me through the header?",
    "vamos olhar o botão de comprar",
  ];
  assert.equal(isDuplicate(recent, "can you walk me through the header please"), true);
  const muitas = Array.from({ length: 10 }, (_, i) => `frase numero ${i} sem relacao com o resto ${i * 13}`);
  muitas[0] = "Can you walk me through the header?";
  assert.equal(isDuplicate(muitas, "Can you walk me through the header please"), false);
  assert.equal(isDuplicate([], "Can you walk me through the header please"), false);
});

test("em erro o cursor só consome o prefixo que já tem português", () => {
  const lines = [
    { id: 1, text: "hello there from the call", pt: "olá da chamada" },
    { id: 2, text: "já está em português nesta fala", lang: "pt", pt: "" },
    { id: 3, text: "still in english here now", pt: "" },
    { id: 4, text: "later line already done", pt: "linha posterior" },
  ];
  assert.equal(shownCursor(lines, 0), 2);
  assert.equal(shownCursor(lines, 2), 2);
  assert.equal(shownCursor([{ id: 1, text: "a", pt: "á" }, { id: 2, text: "b", pt: "bê" }], 0), 2);
  assert.equal(shownCursor([{ id: 4, text: "x", pt: "" }], 0), 0);
});

test("traduzir avança o cursor antes do await e recusa o segundo clique", () => {
  const lines = [
    { id: 1, text: "hello there from the call" },
    { id: 2, text: "still in english here now" },
  ];
  const first = claimTranslate(lines, 0, false);
  assert.equal(first.claimed, true);
  assert.equal(first.shownId, 2);
  assert.equal(first.previous, 0);
  const again = claimTranslate(lines, first.shownId, true);
  assert.equal(again.claimed, false);
  assert.equal(again.reason, "ocupado");
  assert.equal(again.shownId, 2);
});

test("a janela de reunião traz Livecoding e a principal abre o modo", () => {
  const meeting = fs.readFileSync(path.join(__dirname, "..", "renderer", "meeting", "index.html"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload-meeting.cjs"), "utf8");
  assert.match(meeting, /id="tabChat"/);
  assert.match(meeting, /id="tabTranscript"/);
  assert.match(meeting, /id="tabLive"/);
  assert.match(meeting, /Livecoding/);
  assert.match(meeting, /id="btnHide"[^>]*aria-label="Fechar"/);
  assert.equal(meeting.includes(">Fechar modo de reunião<"), false);
  assert.equal(meeting.includes("Sair do app"), false);
  assert.equal(meeting.includes('id="btnQuit"'), false);
  assert.ok(meeting.indexOf('id="btnSugBoth"') < meeting.indexOf('id="btnSugEn"'));
  assert.ok(meeting.indexOf('id="btnSugEn"') < meeting.indexOf('id="btnTranslate"'));
  assert.match(meeting, /class="card-head tabs"[\s\S]*?<\/div>\s*<div class="card-head status-row">/);
  assert.match(meeting, /class="wide-next"/);
  assert.match(meeting, /id="btnExplain"/);
  assert.equal(main.includes('id="tabLive"'), false);
  assert.equal(main.includes('id="liveTab"'), false);
  assert.match(main, /Modo de reunião/);
  assert.match(main, /tradução, sugestões e livecoding/);
  assert.equal((main.match(/meeting-open/g) || []).length, 1);
  assert.match(preload, /liveStart/);
  assert.match(preload, /onLiveSession/);
  const account = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  const bridge = fs.readFileSync(path.join(__dirname, "..", "src", "preload-main.cjs"), "utf8");
  const tokens = fs.readFileSync(path.join(__dirname, "..", "renderer", "tokens.css"), "utf8");
  assert.match(tokens, /--sun:/);
  assert.match(tokens, /--space-4:/);
  assert.match(main, /tokens\.css/);
  assert.match(meeting, /tokens\.css/);
  // A caixa de acesso MCP foi renomeada e explicada na tela Conta Cursor (renderer/contas.js).
  const contas = fs.readFileSync(path.join(__dirname, "..", "renderer", "contas.js"), "utf8");
  assert.match(account, /HeliosContas/);
  assert.match(contas, /Conectar outros programas ao HELIOS/);
  assert.match(contas, /Gerar outro token/);
  assert.match(bridge, /mcpAccess/);
  assert.match(bridge, /mcpRegenerate/);
});
