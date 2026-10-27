"use strict";
/*
 * Módulo de voz do HELIOS.
 * - Parte pura (testável em Node): cleanForSpeech, splitSentences, pickVoice, createVad, turnToSpeech, PCM.
 * - Parte de navegador: createController (resposta por voz, modo conversa, preferências).
 * O áudio nunca leva chave de API: a transcrição e o TTS Gemini passam pelo processo main (IPC).
 */
(function () {
  const APPROVAL_NOTICE = "Há uma aprovação pendente na tela.";
  const NO_KEY_MESSAGE = "Para conversar por voz, coloque a chave da Groq no Cofre (aba Cofre, em “Chaves de reunião”) e tente de novo.";
  const PREFS_KEY = "helios.voice";
  const PHASE_LABELS = {
    listening: "Ouvindo…",
    transcribing: "Transcrevendo…",
    thinking: "Pensando…",
    speaking: "Falando…",
  };

  // ---------- parte pura ----------

  function cleanForSpeech(input) {
    let t = String(input == null ? "" : input).replace(/\r\n?/g, "\n");
    t = t.replace(/```[\s\S]*?(?:```|$)/g, "\n");
    t = t.replace(/~~~[\s\S]*?(?:~~~|$)/g, "\n");
    t = t.replace(/<\/?[a-zA-Z][^>\n]*>/g, " ");
    t = t.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1");
    t = t.replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1");
    t = t.replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, "$1");
    t = t.replace(/\b(?:https?:\/\/|www\.)[^\s<>)]+/gi, "");
    t = t.replace(/`([^`\n]*)`/g, "$1");
    const lines = t.split("\n").map((raw) => {
      let line = raw;
      if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) return "";
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return "";
      if ((line.match(/\|/g) || []).length >= 2) {
        line = line.split("|").map((cell) => cell.trim()).filter(Boolean).join(", ");
      }
      line = line.replace(/^\s{0,3}#{1,6}\s+/, "");
      line = line.replace(/^\s{0,3}>\s?/, "");
      line = line.replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/, "");
      line = line.replace(/(\*\*|__)(.+?)\1/g, "$2");
      line = line.replace(/\*([^*\n]+)\*/g, "$1");
      line = line.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:!?])/g, "$1$2");
      line = line.replace(/~~([^~\n]+)~~/g, "$1");
      line = line.replace(/[*#`~]+/g, "");
      line = line.replace(/\p{Extended_Pictographic}\uFE0F?/gu, "");
      line = line.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
      if (!/[\p{L}\p{N}]/u.test(line)) return "";
      if (!/[.!?…:;]$/.test(line)) line += ".";
      return line;
    });
    return lines.filter(Boolean).join("\n").trim();
  }

  function splitLong(sentence, maxLen) {
    if (sentence.length <= maxLen) return [sentence];
    const out = [];
    let current = "";
    for (const piece of sentence.split(/(?<=[,;:])\s+/)) {
      for (const word of piece.split(/\s+/)) {
        if (current && (current + " " + word).length > maxLen) {
          out.push(current);
          current = word;
        } else {
          current = current ? current + " " + word : word;
        }
      }
    }
    if (current) out.push(current);
    return out;
  }

  // Divide em trechos curtos (o Chromium corta falas longas perto de 15 s).
  function splitSentences(text, maxLen) {
    const limit = maxLen > 0 ? maxLen : 160;
    const pieces = [];
    for (const line of String(text || "").split(/\n+/)) {
      for (const sentence of line.split(/(?<=[.!?…])\s+/)) {
        const s = sentence.trim();
        if (s) pieces.push(...splitLong(s, limit));
      }
    }
    const chunks = [];
    for (const piece of pieces) {
      const last = chunks.length - 1;
      if (last >= 0 && (chunks[last] + " " + piece).length <= limit) chunks[last] += " " + piece;
      else chunks.push(piece);
    }
    return chunks;
  }

  function pickVoice(voices, { lang = "pt-BR" } = {}) {
    const want = String(lang).toLowerCase().replace("_", "-");
    const base = want.split("-")[0];
    let best = null;
    let bestScore = 0;
    for (const voice of voices || []) {
      const vl = String(voice.lang || "").toLowerCase().replace("_", "-");
      let score = 0;
      if (vl === want) score = 100;
      else if (vl.split("-")[0] === base) score = 60;
      else continue;
      const name = String(voice.name || "");
      if (/natural/i.test(name)) score += 30;
      if (/online/i.test(name)) score += 20;
      if (voice.localService === false) score += 5;
      if (/francisca|thalita|maria/i.test(name)) score += 3;
      if (score > bestScore) {
        best = voice;
        bestScore = score;
      }
    }
    return best;
  }

  // Detecção de fala por energia (RMS), com histerese e piso de ruído adaptativo.
  function createVad(options) {
    const o = { onLevel: 0.02, offLevel: 0.012, startMs: 120, silenceMs: 800, minSpeechMs: 400, maxSpeechMs: 30000, ...(options || {}) };
    let floor = 0.004;
    let speaking = false;
    let aboveSince = null;
    let startedAt = 0;
    let lastVoice = 0;
    return {
      push(rms, now, opts) {
        const mult = (opts && opts.mult) || 1;
        const startMs = (opts && opts.startMs) || o.startMs;
        const on = Math.max(o.onLevel, floor * 4) * mult;
        const off = Math.max(o.offLevel, floor * 2.2) * mult;
        if (!speaking) {
          if (rms >= on) {
            if (aboveSince === null) aboveSince = now;
            if (now - aboveSince >= startMs) {
              speaking = true;
              startedAt = aboveSince;
              lastVoice = now;
              aboveSince = null;
              return { type: "start", at: startedAt };
            }
          } else {
            aboveSince = null;
            floor = Math.min(0.02, Math.max(0.001, floor * 0.95 + rms * 0.05));
          }
          return null;
        }
        if (rms >= off) lastVoice = now;
        if (now - lastVoice >= o.silenceMs || now - startedAt >= o.maxSpeechMs) {
          speaking = false;
          aboveSince = null;
          const durationMs = lastVoice - startedAt;
          return { type: "end", durationMs, valid: durationMs >= o.minSpeechMs };
        }
        return null;
      },
      isSpeaking: () => speaking,
      isPending: () => aboveSince !== null,
      reset() {
        speaking = false;
        aboveSince = null;
      },
    };
  }

  // O que falar quando uma resposta termina. Cartão de aprovação pendente: só o aviso.
  function turnToSpeech(messages) {
    const list = messages || [];
    if (list.some((m) => m.role === "approval" && m.state === "pending")) return APPROVAL_NOTICE;
    return list
      .filter((m) => m.role === "assistant" && m.status !== "running" && m.text)
      .map((m) => cleanForSpeech(m.text))
      .filter(Boolean)
      .join("\n");
  }

  function b64ToBytes(b64) {
    if (typeof atob === "function") {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    return new Uint8Array(globalThis.Buffer.from(b64, "base64"));
  }

  function pcm16ToFloat32(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength - (bytes.byteLength % 2));
    const out = new Float32Array(view.byteLength / 2);
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
    return out;
  }

  // ---------- parte de navegador ----------

  function createController(deps) {
    const win = deps.window || window;
    const synth = win.speechSynthesis;
    const prefs = { autoRead: false, engine: "windows" };
    try {
      Object.assign(prefs, JSON.parse(win.localStorage.getItem(PREFS_KEY) || "{}"));
    } catch { /* preferências inválidas: usa o padrão */ }
    if (prefs.engine !== "gemini") prefs.engine = "windows";
    prefs.autoRead = Boolean(prefs.autoRead);

    const st = { on: false, phase: "off", speakingId: null };
    let speakToken = 0;
    let currentSource = null;
    let audioContext = null;
    let voicesPromise = null;
    const keepAlive = [];
    let noticeShown = false;
    let seen = { id: null, count: 0 };
    let session = null; // { stream, source, analyser, timer, vad, rec, buf, failures, thinkingTimer }

    const notify = (text) => deps.banner && deps.banner(text);
    function emit() {
      paint();
      if (deps.onChange) deps.onChange({ ...st });
    }
    function savePrefs() {
      try { win.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* sem armazenamento */ }
    }
    function getAudioContext() {
      if (!audioContext) audioContext = new (win.AudioContext || win.webkitAudioContext)();
      return audioContext;
    }

    // ----- fala (TTS) -----
    function loadVoices() {
      if (voicesPromise) return voicesPromise;
      voicesPromise = new Promise((resolve) => {
        const now = synth.getVoices();
        if (now.length) return resolve(now);
        const done = () => resolve(synth.getVoices());
        synth.addEventListener("voiceschanged", done, { once: true });
        setTimeout(done, 1500);
      });
      return voicesPromise;
    }

    async function speakWindows(sentences, token) {
      const voice = pickVoice(await loadVoices(), { lang: "pt-BR" });
      for (const sentence of sentences) {
        if (token !== speakToken) return;
        await new Promise((resolve) => {
          const utterance = new win.SpeechSynthesisUtterance(sentence);
          utterance.lang = (voice && voice.lang) || "pt-BR";
          if (voice) utterance.voice = voice;
          keepAlive.push(utterance);
          if (keepAlive.length > 8) keepAlive.shift();
          const guard = setTimeout(resolve, 4000 + sentence.length * 120);
          const end = () => { clearTimeout(guard); resolve(); };
          utterance.onend = end;
          utterance.onerror = end;
          synth.speak(utterance);
        });
      }
    }

    async function fetchGemini(text) {
      try {
        const res = await deps.speakRemote(text);
        if (res && res.ok && res.audio) return res;
        if (!noticeShown) {
          noticeShown = true;
          notify(res && res.code === "no-key"
            ? "Sem chave do Gemini no Cofre: usei a voz do Windows."
            : "A voz Gemini não respondeu agora: usei a voz do Windows.");
        }
      } catch { /* cai na voz do Windows */ }
      return null;
    }

    function playPcm(audio, token) {
      return new Promise((resolve) => {
        if (token !== speakToken) return resolve();
        try {
          const ctx = getAudioContext();
          const floats = pcm16ToFloat32(b64ToBytes(audio.audio));
          const buffer = ctx.createBuffer(1, floats.length, audio.sampleRate || 24000);
          buffer.copyToChannel(floats, 0);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          currentSource = source;
          source.onended = () => {
            if (currentSource === source) currentSource = null;
            resolve();
          };
          ctx.resume().then(() => source.start()).catch(() => resolve());
        } catch {
          resolve();
        }
      });
    }

    async function speakGemini(sentences, token) {
      const chunks = splitSentences(sentences.join(" "), 400);
      let next = fetchGemini(chunks[0]);
      for (let i = 0; i < chunks.length; i++) {
        const audio = await next;
        if (token !== speakToken) return;
        if (!audio) {
          await speakWindows(splitSentences(chunks.slice(i).join(" "), 160), token);
          return;
        }
        if (i + 1 < chunks.length) next = fetchGemini(chunks[i + 1]);
        await playPcm(audio, token);
      }
    }

    function stopSpeaking() {
      speakToken += 1;
      try { synth.cancel(); } catch { /* ignora */ }
      if (currentSource) {
        try { currentSource.stop(); } catch { /* já parou */ }
        currentSource = null;
      }
      if (st.speakingId !== null) {
        st.speakingId = null;
        emit();
      }
    }

    async function speakText(raw, id) {
      const text = cleanForSpeech(raw);
      stopSpeaking();
      if (!text) return;
      const token = speakToken;
      st.speakingId = id || "texto";
      emit();
      try {
        const sentences = splitSentences(text, 160);
        if (prefs.engine === "gemini" && deps.speakRemote) await speakGemini(sentences, token);
        else await speakWindows(sentences, token);
      } finally {
        if (token === speakToken) {
          st.speakingId = null;
          emit();
        }
      }
    }

    // ----- modo conversa -----
    function setPhase(phase) {
      if (st.phase === phase) return;
      st.phase = phase;
      emit();
    }

    function startRecorder(s) {
      const mime = win.MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
      const rec = new win.MediaRecorder(s.stream, mime ? { mimeType: mime } : undefined);
      const item = { rec, chunks: [], startedAt: performance.now() };
      rec.ondataavailable = (event) => { if (event.data && event.data.size) item.chunks.push(event.data); };
      rec.start();
      s.rec = item;
    }

    function finishRecorder(item) {
      return new Promise((resolve) => {
        item.rec.onstop = () => resolve(new Blob(item.chunks, { type: item.rec.mimeType || "audio/webm" }));
        try { item.rec.stop(); } catch { resolve(null); }
      });
    }

    function rollRecorder(s) {
      const old = s.rec;
      startRecorder(s);
      try { old.rec.stop(); } catch { /* já parou */ }
    }

    function giveUpThinking() {
      if (session && st.phase === "thinking") setPhase("listening");
    }

    async function handleUtterance(s, blob) {
      if (!blob || !blob.size) return;
      setPhase("transcribing");
      let result;
      try {
        result = await deps.transcribe(await blob.arrayBuffer(), blob.type);
      } catch (err) {
        result = { ok: false, error: err && err.message ? err.message : "falha desconhecida" };
      }
      if (session !== s) return;
      if (!result || !result.ok) {
        if (result && result.code === "no-key") {
          notify(NO_KEY_MESSAGE);
          stopConversation();
          return;
        }
        notify(`Não consegui transcrever o áudio: ${(result && result.error) || "erro desconhecido"}`);
        s.failures += 1;
        if (s.failures >= 3) {
          notify("Parei o modo conversa depois de três falhas seguidas ao transcrever.");
          stopConversation();
        } else {
          setPhase("listening");
        }
        return;
      }
      s.failures = 0;
      const text = String(result.text || "").trim();
      if (!text) {
        setPhase("listening");
        return;
      }
      setPhase("thinking");
      clearTimeout(s.thinkingTimer);
      s.thinkingTimer = setTimeout(giveUpThinking, 4 * 60 * 1000);
      try {
        await deps.sendText(text);
      } catch (err) {
        notify(err && err.message ? err.message : "Não consegui enviar a mensagem.");
        if (session === s) setPhase("listening");
      }
    }

    function onVad(s, event) {
      if (event.type === "start") {
        if (st.phase === "speaking") {
          stopSpeaking();
          setPhase("listening");
        }
        return;
      }
      const old = s.rec;
      startRecorder(s);
      const busy = st.phase !== "listening" && st.phase !== "speaking";
      if (!event.valid || busy) {
        try { old.rec.stop(); } catch { /* já parou */ }
        return;
      }
      if (st.phase === "speaking") {
        stopSpeaking();
        setPhase("listening");
      }
      finishRecorder(old).then((blob) => { if (session === s) handleUtterance(s, blob); });
    }

    function tick(s) {
      s.analyser.getFloatTimeDomainData(s.buf);
      let sum = 0;
      for (let i = 0; i < s.buf.length; i++) sum += s.buf[i] * s.buf[i];
      const rms = Math.sqrt(sum / s.buf.length);
      const now = performance.now();
      const speaking = st.phase === "speaking";
      const event = s.vad.push(rms, now, speaking ? { mult: 2.2, startMs: 300 } : undefined);
      if (event) onVad(s, event);
      if (!s.vad.isSpeaking() && !s.vad.isPending() && now - s.rec.startedAt > 5000) rollRecorder(s);
    }

    // Duplo clique no microfone enquanto o status/permissão carregam abria duas sessões e vazava o microfone.
    let starting = false;
    async function startConversation() {
      if (st.on || session || starting) return;
      starting = true;
      try {
        await startConversationNow();
      } finally {
        starting = false;
      }
    }

    async function startConversationNow() {
      if (st.on || session) return;
      let status = null;
      try { status = await deps.status(); } catch { /* trata como sem chave */ }
      if (!status || !status.hasGroqKey) {
        notify(NO_KEY_MESSAGE);
        return;
      }
      const media = win.navigator.mediaDevices;
      if (!media || !win.MediaRecorder) {
        notify("Este computador não liberou o microfone para o HELIOS.");
        return;
      }
      let stream;
      try {
        stream = await media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        notify("Não consegui usar o microfone. Confira a permissão de microfone do Windows para o HELIOS.");
        return;
      }
      const ctx = getAudioContext();
      try { await ctx.resume(); } catch { /* segue mesmo assim */ }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      const s = { stream, source, analyser, buf: new Float32Array(analyser.fftSize), vad: createVad(), rec: null, failures: 0, timer: null, thinkingTimer: null };
      session = s;
      startRecorder(s);
      s.timer = setInterval(() => tick(s), 40);
      st.on = true;
      noticeShown = false;
      setPhase("listening");
      emit();
    }

    function stopConversation() {
      const s = session;
      if (!s) return;
      session = null;
      clearInterval(s.timer);
      clearTimeout(s.thinkingTimer);
      try { s.rec.rec.stop(); } catch { /* já parou */ }
      try { s.source.disconnect(); } catch { /* ignora */ }
      s.stream.getTracks().forEach((track) => track.stop());
      stopSpeaking();
      st.on = false;
      st.phase = "off";
      emit();
    }

    function stopAll() {
      stopConversation();
      stopSpeaking();
    }

    // Chamado a cada renderChat: detecta o fim de uma resposta e fala (modo conversa ou leitura automática).
    function onRender(conv) {
      if (!conv) return;
      if (seen.id !== conv.id) {
        seen = { id: conv.id, count: conv.messages.length };
        if (!(session && st.phase === "thinking")) stopSpeaking();
        return;
      }
      if (conv.busy) return;
      const fresh = conv.messages.slice(seen.count);
      seen.count = conv.messages.length;
      if (!fresh.length) return;
      const speech = turnToSpeech(fresh);
      if (session) {
        if (st.phase !== "thinking") return;
        clearTimeout(session.thinkingTimer);
        if (!speech) {
          setPhase("listening");
          return;
        }
        setPhase("speaking");
        const s = session;
        speakText(speech, "conversa").then(() => { if (session === s && st.phase === "speaking") setPhase("listening"); });
      } else if (prefs.autoRead && speech) {
        speakText(speech, "auto");
      }
    }

    // ----- interface -----
    const escAttr = (value) => String(value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    const ui = {
      // Sem espaços nem quebras de linha: a bolha usa white-space: pre-wrap.
      speakButton: (index) => `<div class="voice-actions"><button type="button" class="btn-voice" data-speak="${escAttr(index)}" aria-label="Ouvir esta resposta">Ouvir</button></div>`,
      options: () => `<div class="voice-opts"><label><input type="checkbox" id="voiceAuto"> Ler respostas automaticamente</label><label>Voz<select id="voiceEngine" aria-label="Voz da leitura"><option value="windows">Windows</option><option value="gemini">Gemini</option></select></label></div>`,
      mic: () => `<div class="voice-mic"><button type="button" class="btn mic" id="micBtn" aria-pressed="false">Conversar por voz</button><span class="voice-state" id="voiceState" role="status"></span></div>`,
    };

    function paint() {
      const doc = win.document;
      const mic = doc.getElementById("micBtn");
      if (mic) {
        mic.classList.toggle("on", st.on);
        mic.setAttribute("aria-pressed", String(st.on));
        mic.textContent = st.on ? "Parar conversa" : "Conversar por voz";
        mic.title = st.on ? "Parar o modo conversa (Esc)" : "Falar com o HELIOS e ouvir a resposta";
      }
      const label = doc.getElementById("voiceState");
      if (label) label.textContent = st.on ? PHASE_LABELS[st.phase] || "" : "";
      doc.querySelectorAll("[data-speak]").forEach((button) => {
        const active = st.speakingId === `msg:${button.dataset.speak}`;
        button.classList.toggle("on", active);
        button.textContent = active ? "Parar" : "Ouvir";
      });
    }

    function bind() {
      const doc = win.document;
      const mic = doc.getElementById("micBtn");
      if (mic) mic.onclick = () => (st.on ? stopConversation() : startConversation());
      const auto = doc.getElementById("voiceAuto");
      if (auto) {
        auto.checked = prefs.autoRead;
        auto.onchange = () => { prefs.autoRead = auto.checked; savePrefs(); };
      }
      const engine = doc.getElementById("voiceEngine");
      if (engine) {
        engine.value = prefs.engine;
        engine.onchange = () => { prefs.engine = engine.value === "gemini" ? "gemini" : "windows"; noticeShown = false; savePrefs(); };
      }
      doc.querySelectorAll("[data-speak]").forEach((button) => {
        button.onclick = () => {
          const id = `msg:${button.dataset.speak}`;
          if (st.speakingId === id) {
            stopSpeaking();
            return;
          }
          const message = deps.getMessage && deps.getMessage(Number(button.dataset.speak));
          if (message && message.text) speakText(message.text, id);
        };
      });
      paint();
    }

    win.document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (session) stopConversation();
      else if (st.speakingId !== null) stopSpeaking();
    });
    win.addEventListener("beforeunload", stopAll);

    return {
      ui,
      bind,
      paint,
      onRender,
      stopAll,
      stopSpeaking,
      speak: speakText,
      startConversation,
      stopConversation,
      prefs: () => ({ ...prefs }),
      state: () => ({ ...st }),
    };
  }

  const api = {
    APPROVAL_NOTICE,
    NO_KEY_MESSAGE,
    cleanForSpeech,
    splitSentences,
    pickVoice,
    createVad,
    turnToSpeech,
    pcm16ToFloat32,
    b64ToBytes,
    createController,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.HeliosVoice = api;
})();
