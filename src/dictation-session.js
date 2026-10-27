"use strict";

/**
 * Estado do ditado: ocioso, gravando, transcrevendo.
 * O retorno nunca inclui o texto falado. A estatística só entra depois que a digitação deu certo.
 */

function countWords(text) {
  return String(text || "").split(/\s+/).filter(Boolean).length;
}

function createDictationSession({ transcribe, clean, inject, record, appName } = {}) {
  let phase = "idle";

  function status() {
    return { phase };
  }

  function idle(extra = {}) {
    phase = "idle";
    return { phase, ...extra };
  }

  async function begin() {
    if (phase !== "idle") return { ok: false, phase, error: "Já estou ouvindo." };
    phase = "recording";
    return { ok: true, phase };
  }

  function cancel() {
    return { ok: true, ...idle() };
  }

  async function deliver({ audio, mime, durationMs } = {}) {
    if (phase !== "recording") return { ok: false, phase, error: "Não há ditado em andamento." };
    phase = "transcribing";
    let heard;
    try {
      heard = await transcribe(audio, mime);
    } catch {
      return { ok: false, ...idle(), error: "Não consegui transcrever o ditado." };
    }
    if (!heard || heard.ok === false) {
      const missing = heard && heard.code === "no-key";
      return {
        ok: false,
        ...idle(),
        error: missing ? "Não consegui transcrever. Confira a chave da Groq no Cofre." : "Não consegui transcrever o ditado.",
      };
    }
    const raw = typeof heard === "string" ? heard : heard.text;
    let cleaned;
    try {
      cleaned = clean(raw);
    } catch {
      return { ok: false, ...idle(), error: "Não consegui transcrever o ditado." };
    }
    const text = String(cleaned?.text || "").trim();
    if (!text) return { ok: true, ...idle(), empty: true, words: 0, fixes: 0 };
    let typed;
    try {
      typed = await inject(text);
    } catch {
      typed = { ok: false };
    }
    if (!typed || !typed.ok) return { ok: false, ...idle(), error: "Não consegui digitar na janela em foco." };
    const words = countWords(text);
    const stats = {
      words,
      chars: text.length,
      fixes: Number(cleaned.fixes) || 0,
      durationMs: Number(durationMs) || 0,
      app: typeof appName === "function" ? appName() : appName,
    };
    try {
      if (record) await record(stats);
    } catch {
      return { ok: false, ...idle(), error: "O texto foi digitado, mas não anotei a estatística." };
    }
    return { ok: true, ...idle(), empty: false, words, fixes: stats.fixes };
  }

  return { begin, deliver, cancel, status };
}

module.exports = { createDictationSession, countWords };
