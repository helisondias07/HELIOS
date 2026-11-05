"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const LineUtil = require("../renderer/meeting/lineutil");
const providers = require("../src/providers");
const { voiceScreenPlan } = require("../src/meeting-host");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const app = read("renderer/meeting/app.js");
const html = read("renderer/meeting/index.html");
const preload = read("src/preload-meeting.cjs");
const host = read("src/meeting-host.js");
const win = read("src/meeting-window.js");
const readme = read("README.md");
const LINES = [{ who: "them", text: "Can you tell me about your experience with Wake?" }];

test("shouldCutVoice: pausa curta no microfone, sem esperar metade do bloco do áudio do PC", () => {
  const sample = { elapsedMs: 1200, maxMs: 9000, voiced: 8, silentTicks: 8 };
  assert.equal(LineUtil.shouldCutVoice(sample), true);
  assert.equal(LineUtil.shouldCut(sample), false);
  assert.equal(LineUtil.shouldCutVoice({ elapsedMs: 400, voiced: 8, silentTicks: 8 }), false);
  assert.equal(LineUtil.shouldCutVoice({ elapsedMs: 1200, voiced: 4, silentTicks: 8 }), false);
  assert.equal(LineUtil.shouldCutVoice({ elapsedMs: 1200, voiced: 8, silentTicks: 7 }), false);
});

test("isVoiceQuestion: pergunta do Helison entra; relato, cumprimento e ruído ficam só na transcrição", () => {
  for (const ok of [
    "o que é isso na tela?",
    "o que é isso na tela",
    "não entendi esse erro",
    "me explica o que está na tela",
    "como eu respondo isso?",
    "vê a minha tela agora, como que eu respondo isso daqui?",
    "vê a minha tela agora, como que eu respondo isso daqui",
    "Helios, como que eu respondo isso daqui?",
    "Helios, como que eu respondo isso daqui",
    "qual o prazo de entrega",
    "What is on the screen?",
    "cadê o botão de salvar",
  ]) assert.equal(LineUtil.isVoiceQuestion(ok), true, ok);
  for (const no of [
    "sim, pode falar",
    "eu trabalhei com Wake por três anos",
    "o que eu fiz foi liderar o front da loja",
    "como vai",
    "ele explica a arquitetura do checkout para o time",
    "ok",
    "obrigado",
    "?",
    "Thanks for watching!",
  ]) assert.equal(LineUtil.isVoiceQuestion(no), false, no);
  assert.equal(LineUtil.isVoiceQuestion("Helios, o que é um CDN?"), true);
  assert.equal(LineUtil.isVoiceQuestion("como que eu respondo isso daqui"), true);
});

test("voiceScreenPlan: demonstração e falta de Gemini não capturam a tela", () => {
  assert.deepEqual(voiceScreenPlan({ mockMode: true, hasGemini: false }), { capture: false, image: "mock", warn: "" });
  const missing = voiceScreenPlan({ mockMode: false, hasGemini: false });
  assert.equal(missing.capture, false);
  assert.equal(missing.image, null);
  assert.match(missing.warn, /Gemini/);
  assert.deepEqual(voiceScreenPlan({ mockMode: false, hasGemini: true }), { capture: true, image: null, warn: "" });
});

function bootHost(opts = {}) {
  const handlers = {};
  const shots = { n: 0 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helios-voz-"));
  const fakeElectron = {
    ipcMain: { handle: (n, f) => { handlers[n] = f; }, on: (n, f) => { handlers[n] = f; } },
    shell: { openExternal: async () => {} },
    desktopCapturer: {
      getSources: async () => {
        shots.n += 1;
        if (!opts.fakeShot) throw new Error("não deve capturar a tela real");
        const jpeg = Buffer.from("jpeg");
        return [{ thumbnail: { toJPEG: () => jpeg, resize: () => ({ toDataURL: () => "data:image/jpeg;base64,eA==" }) } }];
      },
    },
    screen: { getPrimaryDisplay: () => ({ size: { width: 800, height: 600 }, scaleFactor: 1 }) },
    app: { getPath: () => tmp },
    session: {},
  };
  const origWatch = fs.watch;
  fs.watch = () => ({ close() {}, on() {} });
  const orig = Module._load;
  Module._load = function (request, ...rest) { return request === "electron" ? fakeElectron : orig.call(this, request, ...rest); };
  delete require.cache[require.resolve("../src/meeting-host")];
  try {
    const { registerMeeting } = require("../src/meeting-host");
    const { createSettings } = require("../src/settings-store");
    const settings = createSettings(tmp);
    registerMeeting({
      getWin: () => null,
      closeMeeting() {},
      settings,
      vault: { getKey: (name) => (opts.keys && opts.keys[name]) || null },
      serverUrl: "http://127.0.0.1:1",
      getApiToken: () => "t",
      quit() {},
      mock: opts.mock !== false,
    });
  } finally { fs.watch = origWatch; }
  return { handlers, shots };
}
const call = (h, name, ...args) => h.handlers[name]({}, ...args);

test("pergunta por voz em demonstração não captura a tela nem apaga a prévia manual", async () => {
  const h = bootHost();
  const alone = await call(h, "ai:ask", LINES, "o que tem na tela?", true, 1, "voice");
  assert.equal(alone.ok, true);
  assert.equal(h.shots.n, 0);
  const prev = await call(h, "screen:preview");
  assert.equal(prev.ok, true);
  assert.match(prev.preview, /^data:image\//);
  const voice = await call(h, "ai:ask", LINES, "o que é isso na tela?", true, 2, "voice");
  assert.equal(voice.ok, true);
  assert.equal(h.shots.n, 0);
  const manual = await call(h, "ai:ask", LINES, "Analise", true, 3);
  assert.equal(manual.ok, true);
  assert.equal(h.shots.n, 0);
});

test("sem Gemini a pergunta por voz responde em texto, avisa e não chama o capturador", async () => {
  const h = bootHost({ mock: false, keys: { groq: "g" } });
  const real = providers.groqChat;
  providers.groqChat = async () => "Resposta sem print.";
  try {
    const r = await call(h, "ai:ask", LINES, "o que é isso?", true, 1, "voice");
    assert.equal(r.ok, true);
    assert.match(r.text, /sem print/);
    assert.match(r.warn, /Gemini/);
    assert.equal(h.shots.n, 0);
  } finally { providers.groqChat = real; }
});

test("falha ao capturar a tela não impede a resposta da pergunta por voz", async () => {
  const h = bootHost({ mock: false, keys: { groq: "g", gemini: "ge" } });
  const real = providers.groqChat;
  providers.groqChat = async () => "Segue sem a imagem.";
  try {
    const r = await call(h, "ai:ask", LINES, "o que é isso?", true, 4, "voice");
    assert.equal(r.ok, true);
    assert.match(r.text, /sem a imagem/);
    assert.match(r.warn, /Não capturei a tela/);
    assert.equal(h.shots.n, 1);
  } finally { providers.groqChat = real; }
});

test("janela: ciclo da pergunta por voz não para os gravadores nem grava áudio", () => {
  const body = app.slice(app.indexOf("async function runVoiceAsk"), app.indexOf("function showTranslation"));
  assert.match(body, /Pergunta por voz/);
  assert.match(body, /withScreen \? 'voice' : undefined/);
  assert.match(body, /if \(state\.recording\) setStatus\('ouvindo'\)/);
  assert.match(body, /maybeVoiceAsk\(next\)/);
  assert.doesNotMatch(body, /stopSession|rec\.stop|getTracks\(/);
  assert.match(app, /who === 'me'\s*\?\s*LineUtil\.shouldCutVoice/);
  assert.match(app, /LineUtil\.shouldCut\(\{ elapsedMs, maxMs: chunkSecs\(\) \* 1000/);
  assert.match(app, /if \(!rec\.stopped\) cycle\(\)/);
  assert.match(app, /if \(who === 'me'\) maybeVoiceAsk\(line\.text\)/);
  assert.match(app, /if \(who === 'me'\) maybeVoiceAsk\(r\.text\)/);
  assert.match(app, /const withScreen = true/);
  assert.match(app, /startScreenWatch\(\)/);
  assert.match(app, /setInterval\(refreshScreen, 2500\)/);
  assert.match(app, /O áudio e o print não vão para o disco/);
  assert.match(app, /A resposta não é lida em voz/);
  assert.doesNotMatch(app, /wantsVoiceScreen|mVoiceScreen|heliosMeetingVoiceScreen/);
  assert.match(app, /asked: text/);
  assert.doesNotMatch(app, /speechSynthesis|SpeechSynthesisUtterance|voiceSpeak|speakText/);
  assert.doesNotMatch(app, /writeFile|createWriteStream/);
  assert.match(app, /nada é enviado antes do ✓/);
  assert.match(app, /api\.screenPreview\(\)/);
});

test("a escuta reaproveita o print recente; pergunta geral também leva a tela", async () => {
  const h = bootHost({ mock: false, keys: { gemini: "ge" }, fakeShot: true });
  const real = providers.geminiChat;
  let seen = "";
  providers.geminiChat = async (opts) => { seen = opts.imageBase64 || ""; return "Resposta com a tela."; };
  try {
    const refreshed = await call(h, "screen:refresh");
    assert.equal(refreshed.ok, true);
    assert.equal(h.shots.n, 1);
    const voice = await call(h, "ai:ask", LINES, "o que é um CDN?", true, 1, "voice");
    assert.equal(voice.ok, true);
    assert.match(voice.text, /tela/);
    assert.equal(h.shots.n, 1);
    assert.ok(seen.length > 0);
    assert.equal((await call(h, "screen:liveStop")).ok, true);
  } finally { providers.geminiChat = real; }
});

test("interface e README: tela automática, resposta só em texto e pílula fora da captura", () => {
  assert.doesNotMatch(html, /mVoiceScreen|Incluir tela nas perguntas por voz/);
  assert.match(html, /id="voiceHint"/);
  assert.match(html, /id="ansAsk"/);
  assert.match(app, /a tela fica atualizada sozinha/);
  assert.match(app, /só em texto/);
  assert.match(readme, /só como texto/);
  assert.match(readme, /sem leitura em voz/);
  assert.match(readme, /atualiza o print sozinho/);
  assert.match(readme, /como que eu respondo isso daqui/);
  assert.match(preload, /ask: \(lines, question, withScreen, rid, screenMode\)/);
  assert.match(preload, /screenRefresh: \(\) => ipcRenderer\.invoke\("screen:refresh"\)/);
  assert.match(preload, /screenLiveStop/);
  assert.match(host, /screenMode === "voice"/);
  assert.match(host, /voiceScreenPlan\(\{ mockMode: !!mock, hasGemini: !!cfg\(\)\.gemini \}\)/);
  assert.match(host, /LIVE_SHOT_MS/);
  assert.match(host, /ipcMain\.handle\("screen:refresh"/);
  assert.match(readme, /Pergunta por voz/);
  assert.match(readme, /Ctrl\+Shift\+Enter \| Olhar a tela na hora/);
  assert.match(win, /setContentProtection/);
  assert.match(win, /skipTaskbar: true/);
  assert.doesNotMatch(app, /setContentProtection\(false\)/);
});
