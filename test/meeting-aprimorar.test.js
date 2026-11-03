"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const prompts = require("../src/meeting-prompts");
const { friendlyError } = require("../src/meeting-errors");
const mock = require("../src/meeting-mock");
const { transcribeLang } = require("../src/meeting-host");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const app = read("renderer/meeting/app.js");
const html = read("renderer/meeting/index.html");
const main = read("src/main.js");
const preload = read("src/preload-meeting.cjs");
const host = read("src/meeting-host.js");

const LINES = [
  { who: "them", text: "Can you tell me about your experience with Wake?" },
  { who: "me", text: "Sure, I worked on storefronts." },
  { who: "them", text: "What was the hardest performance problem you solved?" },
];

// ---------- prompts: português por padrão, inglês só quando pedido ----------
test("transcrição rotula Você e Outro(s)", () => {
  const t = prompts.transcriptBlock(LINES);
  assert.match(t, /Você: Sure, I worked/);
  assert.match(t, /Outro\(s\): What was the hardest/);
});

test("regra geral: sempre português, inglês só se pedido", () => {
  for (const msgs of [prompts.ask(LINES, "o que é CDN?"), prompts.explain(LINES, {}), prompts.summary(LINES), prompts.suggest(LINES, { lang: "pt" })]) {
    assert.match(msgs[0].content, /SEMPRE em português/);
  }
  assert.doesNotMatch(prompts.summary(LINES)[1].content, /em inglês/i);
});

test("sugestão em português: 1 resposta curta, sem EN (Leva H)", () => {
  const u = prompts.suggest(LINES, { lang: "pt" })[1].content;
  assert.match(u, /UMA resposta/);
  assert.match(u, /no máximo 2 frases e 25 palavras/);
  assert.doesNotMatch(u, /OPÇÃO/);
  assert.doesNotMatch(u, /EN: </);
  assert.match(u, /última fala marcada "Outro\(s\)"/);
});

test("sugestão em inglês: 1 resposta, inglês simples e português ao lado", () => {
  const u = prompts.suggest(LINES, { lang: "en" })[1].content;
  assert.match(u, /EN: <a resposta em inglês simples/);
  assert.match(u, /PT: <tradução em português>/);
  assert.match(u, /nível de um desenvolvedor brasileiro intermediário/);
  assert.match(u, /não invente/i);
  assert.equal(prompts.suggestBoth(LINES)[1].content, u);
});

test("dizer em inglês e pesquisa têm formato e regras", () => {
  const s = prompts.sayEn("Eu trabalhei dois anos com Wake", { meeting: "Vaga: dev e-commerce" });
  assert.match(s[0].content, /do português para o inglês/);
  assert.match(s[1].content, /EN: <frase em inglês>/);
  assert.match(s[1].content, /dois anos com Wake/);
  const r = prompts.research(LINES, "Wake e-commerce plataforma", { meeting: "Vaga: dev e-commerce" });
  assert.match(r[1].content, /somente leitura/);
  assert.match(r[1].content, /português do Brasil/);
  assert.match(r[1].content, /Fontes:/);
  assert.match(r[1].content, /não invente/);
});

test("tradução: termos técnicos e glossário no prompt", () => {
  const msgs = prompts.translateBatch([{ id: 1, text: "We use Wake and a CDN." }], [], { glossary: "Wake = plataforma" });
  assert.match(msgs[0].content, /termos técnicos/);
});

// ---------- erros em português ----------
test("erros viram mensagens claras em português", () => {
  assert.match(friendlyError({ status: 401, message: "x" }), /chave/i);
  assert.match(friendlyError({ status: 429, message: "x" }), /limite/i);
  assert.match(friendlyError({ status: 429, message: "x" }), /9 segundos/);
  assert.match(friendlyError({ status: 503, message: "x" }), /instável/);
  assert.match(friendlyError({ name: "TimeoutError", message: "t" }), /demorou/);
  assert.match(friendlyError(new TypeError("fetch failed")), /conexão/i);
  assert.equal(friendlyError(new Error("algo específico")), "algo específico");
});

// ---------- mock ----------
test("mock: transcrição em ordem, MOCK: força a fala, tradução e respostas previsíveis", () => {
  mock.resetMock();
  const a = mock.mockTranscribe(Buffer.from("qualquer"));
  assert.equal(a.text, mock.SCRIPT[0].en);
  assert.equal(mock.mockTranscribe(Buffer.from("MOCK: Tell me about CDN")).text, "Tell me about CDN");
  const tr = mock.mockChat(prompts.translateBatch([{ id: 7, text: mock.SCRIPT[1].en }], []));
  assert.match(tr, new RegExp(`^1\\| ${mock.SCRIPT[1].pt.slice(0, 12)}`));
  const en = mock.mockChat(prompts.suggest(LINES, { lang: "en" }));
  assert.match(en, /^EN: /); assert.match(en, /PT: /);
  const pt = mock.mockChat(prompts.suggest(LINES, { lang: "pt" }));
  assert.ok(pt.length > 10); assert.doesNotMatch(pt, /EN: /);
  assert.match(mock.MOCK_PREVIEW, /^data:image\//);
});

// ---------- host em modo mock (sem rede e sem chave) ----------
function bootHost(opts = {}) {
  const handlers = {};
  const sent = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helios-mt-"));
  const fakeElectron = {
    ipcMain: { handle: (n, f) => { handlers[n] = f; }, on: (n, f) => { handlers[n] = f; } },
    shell: { openExternal: async (u) => { sent.push(u); } },
    desktopCapturer: { getSources: async () => { throw new Error("não deve capturar a tela real em mock"); } },
    screen: { getPrimaryDisplay: () => ({ size: { width: 800, height: 600 } }) },
    app: { getPath: () => tmp },
    session: {},
  };
  const origWatch = fs.watch;
    fs.watch = () => ({ close() {}, on() {} }); // o relógio de arquivos seguraria o processo de teste
    const orig = Module._load;
  Module._load = function (request, ...rest) { return request === "electron" ? fakeElectron : orig.call(this, request, ...rest); };
  delete require.cache[require.resolve("../src/meeting-host")];
  try {
    const { registerMeeting } = require("../src/meeting-host");
    const { createSettings } = require("../src/settings-store");
    const settings = createSettings(tmp);
    registerMeeting({
      getWin: () => null, closeMeeting() {}, settings, vault: { getKey: () => null }, serverUrl: "http://127.0.0.1:1", getApiToken: () => "t", quit() {}, mock: opts.mock !== false,
    });
  } finally { fs.watch = origWatch; } // Module._load fica trocado: o host chama require("electron") de novo depois
  return { handlers, sent };
}
const call = (h, name, ...args) => h.handlers[name]({}, ...args);

test("host em mock: transcreve, sugere, diz em inglês e pesquisa sem chave e sem rede", async () => {
  const h = bootHost();
  const t = await call(h, "audio:transcribe", Buffer.from("MOCK: What is your notice period?"), "audio/webm", "them");
  assert.equal(t.ok, true); assert.equal(t.text, "What is your notice period?");
  const s = await call(h, "ai:suggest", LINES, "en", 1);
  assert.equal(s.ok, true); assert.match(s.text, /EN: /);
  const p = await call(h, "ai:suggest", LINES, "pt", 2);
  assert.equal(p.ok, true); assert.doesNotMatch(p.text, /EN: /);
  const say = await call(h, "ai:sayEn", "Eu trabalho com Wake");
  assert.equal(say.ok, true); assert.match(say.text, /EN: /); assert.match(say.text, /PT: /);
  const empty = await call(h, "ai:sayEn", "   ");
  assert.equal(empty.ok, false); assert.match(empty.error, /Escreva/);
  const r = await call(h, "ai:research", LINES, "Wake plataforma e-commerce", 3);
  assert.equal(r.ok, true); assert.match(r.text, /https?:\/\//);
  assert.equal(typeof r.ms, "number");
});

test("prévia da tela: só envia depois de confirmar, cancelar descarta, mock não captura a tela real", async () => {
  const h = bootHost();
  const prev = await call(h, "screen:preview");
  assert.equal(prev.ok, true); assert.match(prev.preview, /^data:image\//);
  const ask = await call(h, "ai:ask", LINES, "Analise", true, 5);
  assert.equal(ask.ok, true);
  await call(h, "screen:cancel");
  const none = bootHost();
  assert.equal((await call(none, "screen:cancel")).ok, true);
});

test("abrir link: só http/https", async () => {
  const h = bootHost();
  assert.equal((await call(h, "link:open", "https://example.com/a?b=1")).ok, true);
  assert.deepEqual(h.sent, ["https://example.com/a?b=1"]);
  const bad = await call(h, "link:open", "file:///C:/Windows/system32/calc.exe");
  assert.equal(bad.ok, false); assert.match(bad.error, /http/);
  assert.equal((await call(h, "link:open", "javascript:alert(1)")).ok, false);
  assert.equal(h.sent.length, 1);
});

test("sem chave e sem mock: erro claro em português, sem travar", async () => {
  const h = bootHost({ mock: false });
  const r = await call(h, "ai:sayEn", "Olá");
  assert.equal(r.ok, false);
  assert.match(r.error, /chave|Groq|Gemini/i);
});

// ---------- janela: fechar, parar captura, separação de falantes ----------
test("gravadores separados: PC = Outro, microfone = Você", () => {
  assert.match(app, /sources\.push\(\{ who: 'them'/);
  assert.match(app, /sources\.push\(\{ who: 'me'/);
  assert.match(app, /makeRecorder\(s\.stream, ctx, ctx\.createMediaStreamSource\(s\.stream\), s\.who\)/);
  assert.match(app, /const WHO = \{ me: 'Você', them: 'Outro' \}/);
  assert.match(app, /api\.transcribe\(await blob\.arrayBuffer\(\), blob\.type, who, state\.mode\)/);
  assert.match(preload, /transcribe: \(buf, mime, who, mode\)/);
  assert.match(host, /transcribeLang\(current\.meetingLang, who, mode\)/);
});

test("falha de um áudio: continua com o que funciona e avisa em português", () => {
  assert.match(app, /Sigo só com/);
  assert.match(app, /Não consegui ouvir nada/);
  assert.match(app, /permissão/);
  assert.match(app, /o microfone com o alto-falante ligado/);
});

test("fechar para a captura: atalho de alternar não deixa gravando, corrida de abertura e descarte", () => {
  assert.doesNotMatch(main, /closeMeetingWindow\(meetingWindow, \{ stop: false \}\)/);
  assert.match(app, /state\.gen \+= 1; state\.discard = discard/);
  assert.match(app, /if \(!alive\(\)\) \{ giveUp\(\); return; \}/);
  assert.match(app, /if \(state\.discard\) return;/);
  assert.match(app, /info\.stop\) \{ if \(state\.recording \|\| state\.starting\) stopSession\(\); shotDrop\(\); \}/);
  assert.match(app, /toggleStart = \(\) => \(state\.recording \|\| state\.starting \? stopSession\(false\) : start\(\)\)/);
});

test("interface (Leva H): chips, prévia do print com cancelar, legenda", () => {
  assert.ok(html.indexOf('id="chipSay"') < html.indexOf('id="chipTr"'));
  assert.match(html, /O que digo/);
  assert.match(html, /id="askInput"/);
  assert.match(html, /id="shotBox"[^>]*hidden/);
  assert.match(html, /id="btnShotCancel"/);
  assert.match(html, /id="caption"/);
  assert.match(app, /if \(state\.shotPending\) \{ shotCancel\(\); return; \}/);
  assert.match(main, /"CommandOrControl\+Shift\+E": "say"/);
});

test("copiar resposta e abrir fontes", () => {
  assert.match(html, /id="btnCopy"/);
  assert.match(app, /data-link/);
  assert.match(preload, /openLink/);
});

test("tradução: lotes pequenos, fala do microfone não é traduzida", () => {
  assert.match(app, /splice\(0, 3\)/);
  assert.match(app, /who !== 'me' && line\.lang !== 'pt'/);
});

// ---------- duas abas: Reunião em português / Reunião em inglês ----------
test("idioma do Whisper por aba e por falante", () => {
  assert.equal(transcribeLang("auto", "them", "pt"), "pt");
  assert.equal(transcribeLang("auto", "me", "pt"), "pt");
  assert.equal(transcribeLang("auto", "them", "en"), "en");
  assert.equal(transcribeLang("auto", "me", "en"), "auto");
  assert.equal(transcribeLang("pt", "them", "en"), "pt");
});

test("PT|EN na pílula: cada função só no seu modo", () => {
  assert.match(html, /id="modePt"[^>]*>PT</);
  assert.match(html, /id="modeEn"[^>]*>EN</);
  assert.match(html, /id="chipSay" class="chip only-pt"/);
  assert.match(html, /id="chipSug" class="chip only-en"/);
  assert.match(html, /id="chipTr" class="chip only-en"/);
  assert.match(html, /id="chipAsk" class="chip only-pt"/);
  const css = read("renderer/meeting/style.css");
  assert.match(css, /\.mode-pt \.only-en, \.mode-en \.only-pt \{ display: none !important; \}/);
  assert.match(css, /\.orig \{ display: none; \}/);
});

test("modo EN: só a tradução do Outro na tela, original ao expandir; PT sem tradução", () => {
  assert.match(app, /state\.mode === 'en'/);
  assert.match(app, /async function translateRecent\(\)/);
  assert.match(app, /localStorage\.setItem\('heliosMeetingMode'/);
});

test("tradutor PT→EN: texto grande e sem usar o chat", () => {
  assert.match(html, /id="trEn"/);
  assert.match(read("renderer/meeting/style.css"), /\.tr-en \{[^}]*font-size/);
});
