"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { applyMeetingProtection, meetingBrowserOptions, closeMeetingWindow, mainBrowserOptions } = require("../src/meeting-window");
const { createSettings } = require("../src/settings-store");
const { suggest, ask } = require("../src/meeting-prompts");
const { voiceScreenPlan, tooSmall, MIN_AUDIO_BYTES } = require("../src/meeting-host");
const { cleanHallucination } = require("../src/providers");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");

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
  assert.equal(calls[2][2], "screen-saver");
  const pill = meetingBrowserOptions();
  assert.equal(pill.skipTaskbar, true);
  assert.equal(pill.alwaysOnTop, true);
  const main = mainBrowserOptions();
  assert.equal(main.title, "HELIOS");
  const off = applyMeetingProtection(win, { HELIOS_NO_PROTECT: "1" });
  assert.equal(off.contentProtection, false);
});

test("fechar avisa a página para parar a captura e esconde a janela", () => {
  const calls = [];
  const win = {
    webContents: { send: (...args) => calls.push(["send", ...args]), isDestroyed: () => false },
    setIgnoreMouseEvents: (...args) => calls.push(["ignore", ...args]),
    hide: () => calls.push(["hide"]),
    isDestroyed: () => false,
    _heliosClickThrough: true,
  };
  assert.equal(closeMeetingWindow(win), true);
  assert.equal(win._heliosClickThrough, false);
  assert.deepEqual(calls[0], ["ignore", false]);
  assert.deepEqual(calls[1], ["send", "meeting:stop", { stop: true, clickThrough: false }]);
  assert.deepEqual(calls[2], ["hide"]);
});

test("overlay encerra captura no X e no stop da janela", () => {
  const html = read("renderer", "meeting", "index.html");
  const app = read("renderer", "meeting", "app.js");
  const preload = read("src", "preload-meeting.cjs");
  const main = read("src", "main.js");
  assert.match(html, /id="btnHide"/);
  assert.match(html, /id="btnEnd"/);
  assert.match(html, /id="phase"/);
  assert.match(app, /btnHide"\)\.onclick = \(\) => \{ stopSession\(\); api\.hide\(\); \}/);
  assert.match(app, /function stopCapture/);
  assert.match(app, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
  assert.match(app, /deltaHandlers\.clear/);
  assert.match(app, /api\.onMeetingStop/);
  assert.match(app, /if \(state\.recording\) return;/);
  assert.match(preload, /onMeetingStop/);
  assert.match(main, /closeMeetingNow\(\)/);
  assert.doesNotMatch(html, /Livecoding/);
  assert.doesNotMatch(html, /chipLive/);
  assert.doesNotMatch(app, /livecoding/i);
});

test("janela principal é só reunião: preparação, histórico e ajustes", () => {
  const html = read("renderer", "index.html");
  const app = read("renderer", "app.js");
  const mainPreload = read("src", "preload-main.cjs");
  assert.match(html, /Assistente de reuniões/);
  assert.match(html, /Nova reunião/);
  assert.match(app, /Avisei as outras pessoas/);
  assert.match(app, /Contexto de tela desta reunião/);
  assert.doesNotMatch(html + app + mainPreload, /vagas|livecoding|ditado|caixa de entrada|Montar time/i);
  assert.doesNotMatch(mainPreload, /vagas:/);
});

test("prompts de reunião não tratam a tela como prova", () => {
  const sug = suggest([{ who: "them", text: "Can you walk me through the header?" }], { withScreen: true }).map((m) => m.content).join("\n");
  const asked = ask([{ who: "them", text: "ok" }], "o que eu digo?", { withScreen: true }).map((m) => m.content).join("\n");
  assert.match(sug + asked, /Não trate a tela como prova/);
  assert.doesNotMatch(sug + asked, /Ada questão|verdadeiro, verdadeiro, falso/i);
  assert.match(sug, /Sugestão/);
  assert.match(asked, /Não invente/);
});

test("tela só captura quando a sessão ligou o contexto", () => {
  assert.deepEqual(voiceScreenPlan({ captureScreen: false, hasGemini: true }), { capture: false, image: null, warn: "Contexto de tela desligado para esta reunião." });
  assert.equal(voiceScreenPlan({ captureScreen: true, hasGemini: true }).capture, true);
  assert.equal(voiceScreenPlan({ captureScreen: true, mockMode: true, hasGemini: false }).image, "mock");
  assert.equal(tooSmall(Buffer.alloc(10)), true);
  assert.equal(MIN_AUDIO_BYTES, 2000);
});

test("configurações recusam valores inválidos e não gravem chaves no JSON", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helios-set-"));
  const settings = createSettings(root);
  settings.update({ opacity: 9, provider: "outro", meetingLang: "fr", chunkSeconds: 1, myContext: "x".repeat(5000), captureScreen: true });
  assert.equal(settings.get("opacity"), 1);
  assert.equal(settings.get("provider"), "groq");
  assert.equal(settings.get("meetingLang"), "auto");
  assert.equal(settings.get("chunkSeconds"), 3);
  assert.equal(settings.get("captureScreen"), true);
  assert.equal(settings.get("myContext").length, 4000);
  const disk = JSON.parse(fs.readFileSync(settings.file, "utf8"));
  assert.equal(disk.groq, undefined);
  assert.equal(disk.gemini, undefined);
});

test("transcrição descarta alucinação típica de silêncio", () => {
  assert.equal(cleanHallucination("Thanks for watching."), "");
  assert.equal(cleanHallucination("vamos revisar o botão"), "vamos revisar o botão");
});

test("código e docs não reintroduzem fluxos genéricos", () => {
  const files = [
    "src/main.js", "server/index.js", "README.md", "renderer/app.js", "renderer/meeting/app.js",
  ].map((f) => read(f)).join("\n");
  assert.doesNotMatch(files, /createJobs|registerJobs|livecoding:start|helios_enviar_mensagem|agent-vagas/);
  assert.match(read("README.md"), /assistente de reuniões/i);
});
