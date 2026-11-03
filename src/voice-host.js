"use strict";

// Canais IPC do módulo de voz. As chaves ficam no cofre e só passam por aqui, no processo main.
const providers = require("./providers");

const STT_MODEL = "whisper-large-v3-turbo";
const TTS_MODEL = "gemini-2.5-flash-preview-tts";
const GEMINI_STT_MODEL = "gemini-2.5-flash";
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_TTS_CHARS = 1500;

function createVoiceHandlers({ getKey, api = providers }) {
  const scrub = (err, ...keys) => {
    let text = String((err && err.message) || err || "erro desconhecido");
    for (const key of keys) if (key) text = text.split(key).join("[chave]");
    return text.slice(0, 300);
  };

  async function status() {
    return { ok: true, hasGroqKey: Boolean(getKey("groq")), hasGeminiKey: Boolean(getKey("gemini")) };
  }

  async function transcribe(buf, mime) {
    const key = getKey("groq");
    if (!key) return { ok: false, code: "no-key", error: "Sem chave da Groq no Cofre." };
    let audio;
    try {
      audio = Buffer.from(buf);
    } catch {
      return { ok: false, error: "Áudio inválido." };
    }
    if (!audio.length) return { ok: true, text: "" };
    if (audio.length > MAX_AUDIO_BYTES) return { ok: false, error: "O áudio ficou grande demais." };
    try {
      const result = await api.groqTranscribe({ key, model: STT_MODEL, audio, mime: String(mime || "audio/webm"), language: "pt" });
      return { ok: true, text: api.cleanHallucination(result.text) };
    } catch (err) {
      // Fase 8: escalonamento de voz. Groq falhou (limite ou fora do ar) e há chave do Gemini: tenta uma vez lá, com aviso.
      const gem = getKey("gemini");
      const status = Number(err && err.status) || 0;
      if (gem && (status === 429 || status >= 500 || !status)) {
        try {
          const result = await api.geminiTranscribe({ key: gem, model: GEMINI_STT_MODEL, audio, mime: String(mime || "audio/webm") });
          return { ok: true, text: api.cleanHallucination(result.text), aviso: `A Groq ${status === 429 ? "bateu o limite" : "falhou"}; transcrevi com o Gemini.` };
        } catch (err2) {
          return { ok: false, error: `${scrub(err, key)} / Gemini: ${scrub(err2, gem)}` };
        }
      }
      return { ok: false, error: scrub(err, key) };
    }
  }

  async function speak(text) {
    const key = getKey("gemini");
    if (!key) return { ok: false, code: "no-key", error: "Sem chave do Gemini no Cofre." };
    const clean = String(text || "").trim().slice(0, MAX_TTS_CHARS);
    if (!clean) return { ok: false, error: "Texto vazio." };
    try {
      const out = await api.geminiTts({ key, model: TTS_MODEL, text: clean, voice: "Kore" });
      return { ok: true, audio: out.audio, sampleRate: out.sampleRate };
    } catch (err) {
      return { ok: false, error: scrub(err, key) };
    }
  }

  return { status, transcribe, speak };
}

function registerVoice({ ipcMain, vault }) {
  const handlers = createVoiceHandlers({ getKey: (name) => vault.getKey(name) });
  ipcMain.handle("voice:status", () => handlers.status());
  ipcMain.handle("voice:transcribe", (_event, buf, mime) => handlers.transcribe(buf, mime));
  ipcMain.handle("voice:speak", (_event, text) => handlers.speak(text));
}

module.exports = { createVoiceHandlers, registerVoice, STT_MODEL, TTS_MODEL };
