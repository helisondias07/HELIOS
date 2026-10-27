"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const voice = require("../renderer/voice");
const { createVoiceHandlers } = require("../src/voice-host");
const providers = require("../src/providers");

const { cleanForSpeech, splitSentences, pickVoice, createVad, turnToSpeech, pcm16ToFloat32 } = voice;

test("cleanForSpeech tira markdown, links, URLs e código", () => {
  const input = [
    "# Título",
    "Veja **isto** e [o site](https://exemplo.com/a) em https://outro.com/x?y=1 agora.",
    "```js",
    "const a = 1;",
    "```",
    "- item um",
    "- item `dois`",
    "1. primeiro",
    "> citação _importante_",
  ].join("\n");
  const out = cleanForSpeech(input);
  assert.equal(out, "Título.\nVeja isto e o site em agora.\nitem um.\nitem dois.\nprimeiro.\ncitação importante.");
  assert.ok(!/https?:|\*|`|#/.test(out));
});

test("cleanForSpeech trata tabelas, imagens, HTML, emojis e entradas vazias", () => {
  assert.equal(cleanForSpeech("| a | b |\n|---|---|\n| 1 | 2 |"), "a, b.\n1, 2.");
  assert.equal(cleanForSpeech("![gráfico](x.png) <b>oi</b> 😀 tudo bem?"), "gráfico oi tudo bem?");
  assert.equal(cleanForSpeech("```\nsem fim"), "");
  assert.equal(cleanForSpeech(null), "");
  assert.equal(cleanForSpeech("snake_case_nome e 3.5 mil"), "snake_case_nome e 3.5 mil.");
  assert.equal(cleanForSpeech("Já terminou!"), "Já terminou!");
});

test("splitSentences divide em frases curtas e agrupa as menores", () => {
  assert.deepEqual(splitSentences("Oi. Tudo bem? Sim!", 160), ["Oi. Tudo bem? Sim!"]);
  const longo = "palavra ".repeat(60).trim() + ".";
  const parts = splitSentences(longo, 100);
  assert.ok(parts.length >= 4);
  assert.ok(parts.every((part) => part.length <= 100));
  assert.equal(parts.join(" "), longo);
  const frases = Array.from({ length: 30 }, (_, i) => `Esta é a frase número ${i}.`).join(" ");
  assert.ok(splitSentences(frases, 160).every((part) => part.length <= 160));
  assert.deepEqual(splitSentences("3.5 mil reais. Fim.", 160), ["3.5 mil reais. Fim."]);
  assert.deepEqual(splitSentences("", 160), []);
});

test("pickVoice prefere Natural/Online em pt-BR, depois pt-BR, depois pt", () => {
  const v = (name, lang, localService = true) => ({ name, lang, localService });
  const pt = v("Microsoft Maria - Portuguese (Brazil)", "pt-BR");
  const natural = v("Microsoft Francisca Online (Natural) - Portuguese (Brazil)", "pt-BR", false);
  const ptpt = v("Microsoft Helia - Portuguese (Portugal)", "pt-PT");
  const en = v("Microsoft Zira", "en-US");
  assert.equal(pickVoice([en, pt, natural, ptpt]), natural);
  assert.equal(pickVoice([en, ptpt, pt]), pt);
  assert.equal(pickVoice([en, ptpt]), ptpt);
  assert.equal(pickVoice([en]), null);
  assert.equal(pickVoice([]), null);
  assert.equal(pickVoice([v("Maria", "pt_BR")]).name, "Maria");
});

function run(vad, frames, step = 40) {
  const events = [];
  frames.forEach((rms, i) => {
    const event = vad.push(rms, i * step);
    if (event) events.push({ ...event, i });
  });
  return events;
}
const frames = (rms, ms, step = 40) => Array.from({ length: Math.round(ms / step) }, () => rms);

test("VAD: fala válida começa, e termina após cerca de 800 ms de silêncio", () => {
  const vad = createVad();
  const events = run(vad, [...frames(0.003, 400), ...frames(0.08, 1200), ...frames(0.003, 1200)]);
  assert.deepEqual(events.map((e) => e.type), ["start", "end"]);
  assert.equal(events[1].valid, true);
  assert.ok(events[1].durationMs >= 1100);
  const lastVoiceFrame = (400 + 1200) / 40 - 1;
  const silenceMs = (events[1].i - lastVoiceFrame) * 40;
  assert.ok(silenceMs >= 800 && silenceMs <= 840);
});

test("VAD: enunciado curto (< 400 ms) é marcado como inválido e ruído baixo não dispara", () => {
  const curto = run(createVad(), [...frames(0.003, 200), ...frames(0.08, 240), ...frames(0.003, 1200)]);
  assert.deepEqual(curto.map((e) => e.type), ["start", "end"]);
  assert.equal(curto[1].valid, false);
  assert.deepEqual(run(createVad(), frames(0.008, 3000)), []);
  assert.deepEqual(run(createVad(), [...frames(0.003, 200), ...frames(0.08, 80), ...frames(0.003, 600)]), []);
});

test("VAD: histerese mantém a fala em pausas curtas e o nível alto exigido durante a fala do HELIOS", () => {
  const vad = createVad();
  const pausa = run(vad, [...frames(0.08, 600), ...frames(0.003, 400), ...frames(0.08, 600), ...frames(0.003, 1000)]);
  assert.deepEqual(pausa.map((e) => e.type), ["start", "end"]);
  const quieto = createVad();
  let event = null;
  for (let i = 0; i < 40; i++) event = quieto.push(0.03, i * 40, { mult: 2.2, startMs: 300 }) || event;
  assert.equal(event, null);
  const normal = createVad();
  for (let i = 0; i < 10; i++) event = normal.push(0.03, i * 40) || event;
  assert.equal(event && event.type, "start");
});

test("turnToSpeech: só respostas concluídas; aprovação pendente vira aviso", () => {
  const msgs = [
    { role: "user", text: "oi" },
    { role: "assistant", status: "running", text: "parcial" },
    { role: "assistant", status: "done", text: "**Pronto**, veja https://x.com" },
  ];
  assert.equal(turnToSpeech(msgs), "Pronto, veja.");
  assert.equal(turnToSpeech([...msgs, { role: "approval", state: "pending", summary: "enviar" }]), "Há uma aprovação pendente na tela.");
  assert.equal(turnToSpeech([{ role: "approval", state: "approved" }]), "");
  assert.equal(turnToSpeech([]), "");
});

test("pcm16ToFloat32 converte PCM de 16 bits little-endian", () => {
  const bytes = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80]);
  const out = pcm16ToFloat32(bytes);
  assert.equal(out.length, 3);
  assert.equal(out[0], 0);
  assert.ok(Math.abs(out[1] - 32767 / 32768) < 1e-6);
  assert.equal(out[2], -1);
});

test("transcrição: sem chave da Groq devolve o código no-key e não chama a rede", async () => {
  const handlers = createVoiceHandlers({ getKey: () => "", api: { groqTranscribe() { throw new Error("não devia chamar"); } } });
  const res = await handlers.transcribe(new ArrayBuffer(10), "audio/webm");
  assert.equal(res.ok, false);
  assert.equal(res.code, "no-key");
  assert.deepEqual(await handlers.status(), { ok: true, hasGroqKey: false, hasGeminiKey: false });
});

test("transcrição: usa Groq em português, limpa alucinação e não vaza a chave", async () => {
  const chave = "gsk_teste_curta_123";
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ text: " Quero ver a agenda de hoje. ", language: "portuguese" }), { status: 200 });
    }
    if (calls.length === 2) return new Response(JSON.stringify({ text: "Obrigado por assistir!", language: "pt" }), { status: 200 });
    return new Response(`chave inválida ${chave}`, { status: 401 });
  };
  try {
    const handlers = createVoiceHandlers({ getKey: (name) => (name === "groq" ? chave : "") });
    const ok = await handlers.transcribe(new Uint8Array([1, 2, 3, 4]).buffer, "audio/webm;codecs=opus");
    assert.deepEqual(ok, { ok: true, text: "Quero ver a agenda de hoje." });
    assert.equal(calls[0].url, "https://api.groq.com/openai/v1/audio/transcriptions");
    assert.equal(calls[0].opts.headers.Authorization, `Bearer ${chave}`);
    const form = calls[0].opts.body;
    assert.equal(form.get("language"), "pt");
    assert.equal(form.get("model"), "whisper-large-v3-turbo");
    assert.equal((await handlers.transcribe(new Uint8Array([1]).buffer, "audio/webm")).text, "");
    const erro = await handlers.transcribe(new Uint8Array([1]).buffer, "audio/webm");
    assert.equal(erro.ok, false);
    assert.ok(!erro.error.includes(chave));
    assert.ok(erro.error.includes("401"));
  } finally {
    global.fetch = real;
  }
});

test("voz Gemini: devolve PCM base64 e cai em erro sem expor a chave", async () => {
  const chave = "AIzaTESTE_chave_curta";
  const real = global.fetch;
  let body = null;
  let mode = "ok";
  global.fetch = async (url, opts) => {
    body = { url, opts };
    if (mode === "ok") {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: "AAAA" } }] } }] }), { status: 200 });
    }
    return new Response(`cota ${chave}`, { status: 429 });
  };
  try {
    const handlers = createVoiceHandlers({ getKey: (name) => (name === "gemini" ? chave : "") });
    const ok = await handlers.speak("Olá, tudo bem?");
    assert.deepEqual(ok, { ok: true, audio: "AAAA", sampleRate: 24000 });
    assert.match(body.url, /gemini-2\.5-flash-preview-tts:generateContent$/);
    assert.equal(body.opts.headers["x-goog-api-key"], chave);
    assert.deepEqual(JSON.parse(body.opts.body).generationConfig.responseModalities, ["AUDIO"]);
    mode = "cota";
    const erro = await handlers.speak("Olá");
    assert.equal(erro.ok, false);
    assert.ok(!erro.error.includes(chave));
    const semChave = await createVoiceHandlers({ getKey: () => "" }).speak("oi");
    assert.equal(semChave.code, "no-key");
  } finally {
    global.fetch = real;
  }
});

test("geminiTts está exportado no providers", () => {
  assert.equal(typeof providers.geminiTts, "function");
});

function fakeWindow() {
  const spoken = [];
  const synth = {
    getVoices: () => [{ name: "Microsoft Maria", lang: "pt-BR", localService: true }],
    addEventListener() {},
    cancel() { spoken.push("cancel"); },
    speak(utterance) { spoken.push(utterance.text); setTimeout(() => utterance.onend && utterance.onend(), 0); },
  };
  class Utterance { constructor(text) { this.text = text; } }
  const store = {};
  return {
    spoken,
    speechSynthesis: synth,
    SpeechSynthesisUtterance: Utterance,
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    addEventListener() {},
  };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("controlador: leitura automática fala só respostas novas e concluídas", async () => {
  const win = fakeWindow();
  win.localStorage.setItem("helios.voice", JSON.stringify({ autoRead: true }));
  const ctl = voice.createController({ window: win, banner() {} });
  const old = { role: "assistant", status: "done", text: "Resposta antiga." };
  const conv = { id: "c1", busy: false, messages: [{ role: "user", text: "a" }, old] };
  ctl.onRender(conv);
  await wait(10);
  assert.deepEqual(win.spoken, ["cancel"]);
  win.spoken.length = 0;
  const busy = { ...conv, busy: true, messages: [...conv.messages, { role: "user", text: "b" }, { role: "assistant", status: "running", text: "" }] };
  ctl.onRender(busy);
  const done = { ...conv, busy: false, messages: [...conv.messages, { role: "user", text: "b" }, { role: "assistant", status: "done", text: "**Feito.** Veja https://x.com" }] };
  ctl.onRender(done);
  await wait(20);
  assert.deepEqual(win.spoken.filter((t) => t !== "cancel"), ["Feito. Veja."]);
  win.spoken.length = 0;
  ctl.onRender(done);
  await wait(10);
  assert.deepEqual(win.spoken, []);
  const pending = { ...done, messages: [...done.messages, { role: "approval", state: "pending", summary: "enviar" }] };
  ctl.onRender(pending);
  await wait(20);
  assert.deepEqual(win.spoken.filter((t) => t !== "cancel"), ["Há uma aprovação pendente na tela."]);
  assert.equal(ctl.prefs().autoRead, true);
});

test("controlador: com leitura automática desligada não fala sozinho", async () => {
  const win = fakeWindow();
  const ctl = voice.createController({ window: win, banner() {} });
  const base = { id: "c2", busy: false, messages: [{ role: "user", text: "a" }] };
  ctl.onRender(base);
  ctl.onRender({ ...base, messages: [...base.messages, { role: "assistant", status: "done", text: "Oi." }] });
  await wait(10);
  assert.deepEqual(win.spoken.filter((t) => t !== "cancel"), []);
});
