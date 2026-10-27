"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const providers = require("../src/providers");
const mock = require("../src/meeting-mock");
const mctx = require("../src/meeting-context");
const LineUtil = require("../renderer/meeting/lineutil");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const app = read("renderer/meeting/app.js");
const main = read("src/main.js");
const preload = read("src/preload-meeting.cjs");
const LINES = [{ who: "them", text: "Can you tell me about your experience with Wake?" }];

// ---------- descarte de silêncio e alucinação ----------
test("isNoise: pontuação, legenda inventada e palavra repetida são descartadas; fala normal passa", () => {
  for (const bad of ["", "   ", "...", "?", "Legendas pela comunidade Amara.org", "Subtitles by the Amara.org community", "Thanks for watching!", "you you you you you you", "a"]) {
    assert.equal(LineUtil.isNoise(bad), true, `deveria descartar: "${bad}"`);
  }
  for (const ok of ["Thank you for the opportunity.", "Sim, claro.", "Oi", "We use a CDN and Wake."]) {
    assert.equal(LineUtil.isNoise(ok), false, `deveria manter: "${ok}"`);
  }
});

test("keepSpeech: descarta trechos de silêncio do Whisper e mantém a fala", () => {
  const kept = providers.keepSpeech([
    { text: "Hello there", no_speech_prob: 0.05, avg_logprob: -0.2 },
    { text: "Thank you", no_speech_prob: 0.9, avg_logprob: -0.3 },
    { text: "ghost", no_speech_prob: 0.7, avg_logprob: -1.2 },
  ]);
  assert.deepEqual(kept.map((s) => s.text), ["Hello there"]);
});

test("shouldCut: corta o bloco em pausa só depois de metade do bloco, com fala e ~0,8 s de silêncio", () => {
  const base = { maxMs: 6000, voiced: 20, silentTicks: 9 };
  assert.equal(LineUtil.shouldCut({ ...base, elapsedMs: 3200 }), true);
  assert.equal(LineUtil.shouldCut({ ...base, elapsedMs: 2500 }), false); // cedo demais
  assert.equal(LineUtil.shouldCut({ ...base, elapsedMs: 4000, silentTicks: 3 }), false); // ainda falando
  assert.equal(LineUtil.shouldCut({ ...base, elapsedMs: 4000, voiced: 2 }), false); // quase sem fala
  assert.equal(LineUtil.shouldCut({ ...base, maxMs: 9000, elapsedMs: 4000 }), false); // bloco de 9 s: metade = 4,5 s
  assert.equal(LineUtil.shouldCut({ ...base, maxMs: 9000, elapsedMs: 4600 }), true);
});

// ---------- rede: tentativas, espera curta e cancelamento ----------
test("fetchRetry: respeita tries/maxWait (áudio) e para na hora quando cancelado", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 429, headers: { "retry-after": "30" } }); };
  try {
    const waits = [];
    const res = await providers.fetchRetry("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST" }, { tries: 2, maxWait: 3000, sleep: async (ms) => { waits.push(ms); } });
    assert.equal(res.status, 429);
    assert.equal(calls, 2);
    assert.deepEqual(waits, [3000]);
    const ctl = new AbortController();
    ctl.abort(Object.assign(new Error("cancelado"), { cancelled: true }));
    calls = 0;
    await assert.rejects(providers.fetchRetry("https://api.groq.com/openai/v1/chat/completions", { signal: ctl.signal }), (e) => e.cancelled === true);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = realFetch; }
});

// ---------- host ----------
function bootHost(opts = {}) {
  const handlers = {};
  const sent = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helios-mo-"));
  const fakeElectron = {
    ipcMain: { handle: (n, f) => { handlers[n] = f; }, on: (n, f) => { handlers[n] = f; } },
    shell: { openExternal: async (u) => { sent.push(u); } },
    desktopCapturer: { getSources: async () => { throw new Error("sem tela real"); } },
    screen: { getPrimaryDisplay: () => ({ size: { width: 800, height: 600 } }) },
    app: { getPath: () => tmp },
    session: {},
  };
  const origWatch = fs.watch;
  fs.watch = () => ({ close() {}, on() {} });
  const orig = Module._load;
  Module._load = function (request, ...rest) { return request === "electron" ? fakeElectron : orig.call(this, request, ...rest); };
  delete require.cache[require.resolve("../src/meeting-host")];
  let reg;
  try {
    const { registerMeeting } = require("../src/meeting-host");
    const { createSettings } = require("../src/settings-store");
    const settings = createSettings(tmp);
    const vault = opts.mock === false
      ? { getKey: (n) => (n === "groq" ? "gsk_teste" : null), list: () => ({ keys: { hasGroqKey: true, hasGeminiKey: false } }) }
      : { getKey: () => null, list: () => ({ keys: {} }) };
    reg = registerMeeting({ getWin: () => null, closeMeeting() {}, settings, vault, serverUrl: "http://127.0.0.1:1", getApiToken: () => "t", quit() {}, mock: opts.mock !== false });
  } finally { fs.watch = origWatch; }
  return { handlers, sent, reg };
}
const call = (h, name, ...args) => h.handlers[name]({}, ...args);

test("tradução em cache: a mesma frase não volta para a IA (e o cache aceita só o que traduziu)", async () => {
  const h = bootHost();
  const real = mock.mockChat;
  let n = 0;
  mock.mockChat = (m) => { n += 1; return real(m); };
  try {
    const a = await call(h, "ai:translateBatch", [{ id: 1, text: "Can you tell me about your experience building storefronts on Wake?" }], [], 0);
    assert.equal(a.ok, true); assert.match(a.items[0].pt, /Wake/); assert.equal(n, 1);
    const b = await call(h, "ai:translateBatch", [{ id: 9, text: "  can you tell me about your experience building storefronts on wake? " }], [], 0);
    assert.equal(b.ok, true); assert.equal(b.provider, "cache"); assert.equal(b.items[0].id, 9); assert.equal(n, 1);
    // lote misto: só o que falta vai para a IA
    const c = await call(h, "ai:translateBatch", [
      { id: 10, text: "Can you tell me about your experience building storefronts on Wake?" },
      { id: 11, text: "Great. Do you have any questions for us about the role?" },
    ], [], 0);
    assert.equal(c.ok, true); assert.equal(c.items.length, 2); assert.equal(c.cached, 1); assert.equal(n, 2);
    const sent = real([{ role: "system", content: "x" }]);
    assert.ok(sent);
  } finally { mock.mockChat = real; }
});

test("Tradutor em cache: mesma frase em português não gasta nova chamada", async () => {
  const h = bootHost();
  const real = mock.mockChat;
  let n = 0;
  mock.mockChat = (m) => { n += 1; return real(m); };
  try {
    const a = await call(h, "ai:sayEn", "Eu trabalhei dois anos com Wake", 0);
    const b = await call(h, "ai:sayEn", "eu trabalhei dois anos com  Wake", 0);
    assert.equal(a.ok && b.ok, true); assert.equal(n, 1); assert.equal(b.provider, "cache"); assert.equal(b.text, a.text);
  } finally { mock.mockChat = real; }
});

test("cache de contexto: o bloco só é refeito quando algo muda", async () => {
  const h = bootHost();
  const realBuild = mctx.buildBlock;
  let n = 0;
  mctx.buildBlock = (...a) => { n += 1; return realBuild(...a); };
  try {
    await call(h, "ai:suggest", LINES, "en", 0);
    await call(h, "ai:suggest", LINES, "en", 0);
    assert.equal(n, 1);
    await call(h, "ai:suggest", [{ who: "them", text: "Tell me about CDN usage." }], "en", 0);
    assert.equal(n, 2);
  } finally { mctx.buildBlock = realBuild; }
});

test("limite 429 da Groq: o erro chega à janela com rate=true e mensagem em português", async () => {
  mock.resetMock();
  const h = bootHost();
  const r = await call(h, "audio:transcribe", Buffer.from("MOCK429: hello"), "audio/webm", "them", "en");
  assert.equal(r.ok, false); assert.equal(r.rate, true); assert.match(r.error, /limite gratuito/i); assert.match(r.error, /9 segundos/);
  const once1 = await call(h, "audio:transcribe", Buffer.from("MOCK429ONCE: hello again"), "audio/webm", "them", "en");
  assert.equal(once1.ok, false); assert.equal(once1.rate, true);
  const once2 = await call(h, "audio:transcribe", Buffer.from("MOCK429ONCE: hello again"), "audio/webm", "them", "en");
  assert.equal(once2.ok, true); assert.equal(once2.text, "hello again");
});

test("áudio minúsculo não vai para a nuvem; áudio normal vai", async () => {
  const h = bootHost({ mock: false });
  const real = providers.groqTranscribe;
  let n = 0;
  providers.groqTranscribe = async () => { n += 1; return { text: "ok", language: "en" }; };
  try {
    const tiny = await call(h, "audio:transcribe", Buffer.alloc(500), "audio/webm", "them", "en");
    assert.equal(tiny.ok, true); assert.equal(tiny.text, ""); assert.equal(tiny.skipped, true); assert.equal(n, 0);
    const big = await call(h, "audio:transcribe", Buffer.alloc(8000), "audio/webm", "them", "en");
    assert.equal(big.text, "ok"); assert.equal(n, 1);
  } finally { providers.groqTranscribe = real; }
});

test("fechar a janela cancela o que está indo para a nuvem e não tenta outro modelo", async () => {
  const h = bootHost({ mock: false });
  const real = providers.groqChat;
  const models = [];
  providers.groqChat = ({ model, signal }) => new Promise((_resolve, reject) => {
    models.push(model);
    signal.addEventListener("abort", () => reject(signal.reason));
  });
  try {
    const pending = call(h, "ai:suggest", LINES, "en", 0);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.reg.abortInflight(), 1);
    const res = await pending;
    assert.equal(res.ok, false); assert.equal(res.cancelled, true); assert.match(res.error, /fechada/);
    assert.equal(models.length, 1); // não caiu para o segundo modelo
    assert.equal(h.reg.abortInflight(), 0);
  } finally { providers.groqChat = real; }
});

// ---------- janela ----------
test("janela: recuo automático para 9 s no 429, nova tentativa do mesmo bloco e aviso em português", () => {
  assert.match(app, /const chunkSecs = \(\) => state\.chunkAuto \|\| Number\(state\.settings\.chunkSeconds\) \|\| 9/);
  assert.match(app, /function onRateLimit\(where\)/);
  assert.match(app, /Aumentei o bloco de áudio para 9 s automaticamente/);
  assert.match(app, /if \(!r\.ok && r\.rate\)/);
  assert.match(app, /return handleChunk\(blob, who, true, id\)/);
  assert.match(app, /state\.chunkAuto = 0/); // vale só nesta sessão
  assert.match(app, /state\.trPauseUntil = Date\.now\(\) \+ 8000/);
});

test("janela: sem retraduzir, lotes de 3, streaming de 1 fala, descarte de lixo e limpeza ao fechar", () => {
  assert.match(app, /splice\(0, 3\)/);
  assert.match(app, /taken\.filter\(\(l\) => l\.pt\)\.forEach/);
  assert.match(app, /while \(them\.some\(\(l\) => l\.trq && !l\.pt\)/);
  assert.match(app, /batch\.length === 1 \? \+\+state\.rid : 0/);
  assert.match(app, /LineUtil\.isNoise\(r\.text\)/);
  assert.match(app, /LineUtil\.shouldCut\(/);
  assert.match(app, /if \(discard\) \{ deltaHandlers\.clear\(\); streams\.clear\(\); \}/);
  assert.match(app, /api\.warm\(\)/);
  assert.match(app, /api\.sayEn\(t, rid\)/);
});

test("ponte e main: warm/rid no preload; fechar a janela aborta as chamadas em andamento", () => {
  assert.match(preload, /warm: \(\) => ipcRenderer\.invoke\("net:warm"\)/);
  assert.match(preload, /translateBatch: \(items, history, rid\)/);
  assert.match(preload, /sayEn: \(text, rid\)/);
  assert.match(main, /meetingHost\.abortInflight\(\)/);
  assert.equal((main.match(/closeMeetingWindow\(meetingWindow\)/g) || []).length, 1); // só dentro de closeMeetingNow
  assert.match(read("src/meeting-host.js"), /ipcMain\.on\("win:hide", \(\) => \{\s+abortInflight\(\);/);
});