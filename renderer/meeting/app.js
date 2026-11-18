"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  lines: [], recording: false, starting: false, paused: false, gen: 0, discard: false, shotPending: false,
  recs: [], streams: [], ctx: null, settings: {}, clickThrough: false,
  session: null, chat: [], pendingTr: [], trBusy: false, trTimer: null, chunkAuto: 0, rateWaitMs: 5000,
  rid: 0, startedAt: 0, elapsedMs: 0, timerIv: null,
  view: "insights", last: null, lastCode: "", codeBlocks: [], cardOpen: false, transcriptOpen: false, notesOpen: false, codeOpen: false,
  voiceBusy: false, voiceQueued: "", armVoiceAsk: false, hearingMic: false, screenIv: null, screenBusy: false, sttBusy: 0,
  ended: false, notesDirtyTimer: null,
};

const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fit = () => api.setHeight(Math.ceil($("root").getBoundingClientRect().height) + 4);
new ResizeObserver(fit).observe($("root"));
function openCard(on = true) { state.cardOpen = on; $("card").classList.toggle("hidden", !on); }

function currentLang() {
  return state.settings.meetingLang || "auto";
}
function currentMode() {
  return (state.session && state.session.mode) || state.settings.meetingMode || "meeting";
}

function syncSegs() {
  const mode = currentMode();
  const lang = currentLang();
  document.querySelectorAll("#modeSeg .seg-b").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  document.querySelectorAll("#langSeg .seg-b").forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));
  document.documentElement.classList.toggle("mode-en", lang === "en");
  $("protBadge").classList.toggle("hidden", state.settings.protected === false);
  $("askInput").placeholder = mode === "livecoding"
    ? "Instrução para Código (Alt+C), termo (Alt+P) ou pergunta…"
    : "Pergunte, digite um termo para Consultar (Alt+P) ou instrução…";
}

function setPhase(text, { live = false, err = false } = {}) {
  $("phase").textContent = text;
  $("btnStart").title = text;
  $("dot").classList.toggle("live", live);
  $("dot").classList.toggle("err", err);
  $("btnStart").classList.toggle("on", live || state.paused);
}
function toast(msg, ms = 3500) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  $("root").appendChild(t);
  setTimeout(() => t.remove(), ms);
}
const lastToast = new Map();
function toastOnce(msg, ms = 5000) {
  const now = Date.now();
  if (now - (lastToast.get(msg) || 0) < 30000) return;
  lastToast.set(msg, now);
  toast(msg, ms);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunkSecs = () => state.chunkAuto || Number(state.settings.chunkSeconds) || 5;

function onRateLimit(where) {
  if (chunkSecs() < 8) {
    state.chunkAuto = 8;
    toastOnce(`Limite da Groq (${where}). Ajustei o bloco de áudio para 8 s.`, 6000);
  } else {
    toastOnce(`Limite da Groq (${where}). Retomando em alguns segundos.`, 6000);
  }
}

const deltaHandlers = new Map();
api.onDelta((rid, text) => { const h = deltaHandlers.get(rid); if (h) h(text); });

function mediaMessage(e, label) {
  const n = (e && e.name) || "";
  if (n === "NotAllowedError" || n === "SecurityError") return `${label}: o sistema negou a permissão.`;
  if (n === "NotFoundError" || n === "OverconstrainedError") return `${label}: nenhum dispositivo encontrado.`;
  if (n === "NotReadableError" || n === "AbortError") return `${label}: em uso por outro app.`;
  if (n === "NoAudio") return `${label}: sem áudio do sistema (no Linux isso é comum).`;
  return `${label}: ${(e && e.message) || "falhou"}.`;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fallback */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

function setActivePanel(which) {
  state.transcriptOpen = which === "transcript";
  state.notesOpen = which === "notes";
  state.codeOpen = which === "code";
  $("transcript").classList.toggle("hidden", !state.transcriptOpen);
  $("notesBox").classList.toggle("hidden", !state.notesOpen);
  $("codeBox").classList.toggle("hidden", !state.codeOpen);
  $("answer").classList.toggle("hidden", which !== "answer");
  $("chipTranscript").classList.toggle("on", state.transcriptOpen);
  $("chipNotes").classList.toggle("on", state.notesOpen);
  $("chipCode").classList.toggle("on", state.codeOpen);
  $("chipInsights").classList.toggle("on", which === "answer" && state.view === "insights");
  if (state.transcriptOpen) {
    const b = $("transcript");
    b.scrollTop = b.scrollHeight;
  }
}

function showTranscript(on) {
  setActivePanel(on ? "transcript" : "answer");
}
function showNotes(on) {
  setActivePanel(on ? "notes" : "answer");
  if (on) $("noteInput").focus();
}
function showInsights() {
  state.view = "insights";
  setActivePanel("answer");
  openCard(true);
}
function showCode() {
  setActivePanel("code");
  openCard(true);
}

const WHO = { me: "Você", them: "Outro" };
function renderLine(l) {
  const box = $("transcript");
  let el = box.querySelector(`[data-id="${l.id}"]`);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (!el) {
    el = document.createElement("div");
    el.dataset.id = l.id;
    box.appendChild(el);
  }
  el.className = `line ${l.who || ""} plain`;
  const mainText = l.pt || l.text;
  const subOriginal = l.pt && l.text && l.pt !== l.text ? `<span class="pt-sub">${esc(l.text)}</span>` : "";
  el.innerHTML = `<span class="who">${WHO[l.who] || ""}</span><span class="orig">${esc(mainText)}</span>${subOriginal}`;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function extractCodeBlock(text) {
  const m = String(text || "").match(/```(?:[a-zA-Z0-9_+-]*)?\n([\s\S]*?)```/);
  return m ? m[1].trim() : "";
}

function renderFormattedAnswer(rawText) {
  const raw = String(rawText || "");
  if (!raw.includes("```") && !/^#{2,3}\s+/m.test(raw)) {
    const parts = LineUtil.proseParts(raw);
    $("ansMain").textContent = parts.main;
    $("ansSub").textContent = parts.sub || "";
    return;
  }
  $("ansSub").textContent = "";
  state.codeBlocks = [];
  const segments = raw.split(/(```[\s\S]*?```)/g);
  const html = segments.map((seg) => {
    if (seg.startsWith("```") && seg.endsWith("```")) {
      const inner = seg.replace(/^```[^\n]*\n?/, "").replace(/```$/, "").trim();
      const idx = state.codeBlocks.push(inner) - 1;
      return `<div class="code-wrap"><pre class="code-block">${esc(inner)}</pre><button type="button" class="mini copy-blk" data-idx="${idx}">Copiar</button></div>`;
    }
    return seg
      .split(/\r?\n/)
      .map((line) => {
        const hm = line.match(/^#{2,3}\s+(.+)$/);
        if (hm) return `<div class="ans-h">${esc(hm[1])}</div>`;
        return esc(line);
      })
      .join("\n");
  }).join("");
  $("ansMain").innerHTML = html;
}

function paintAnswer(text, streaming = false) {
  const raw = String(text || "");
  state.codeBlocks = [];
  state.lastCode = extractCodeBlock(raw);
  $("btnCopyCode").classList.toggle("hidden", !state.lastCode);
  if (!raw) {
    $("ansMain").textContent = streaming ? "…" : "";
    $("ansSub").textContent = "";
  } else {
    renderFormattedAnswer(raw);
  }
  $("ansMain").classList.toggle("wait", streaming && !raw);
}

function showAsked(asked) {
  const q = $("ansAsk");
  const t = String(asked || "").trim();
  q.textContent = t;
  q.classList.toggle("hidden", !t);
}
function setAnswer(text, { title = "", more = null, asked = "" } = {}) {
  showInsights();
  state.last = { title, text, more, asked };
  showAsked(asked);
  paintAnswer(text, false);
  $("btnMore").classList.toggle("hidden", !more);
}

async function runAI(title, fn, { more = null, asked = "" } = {}) {
  showInsights();
  $("btnMore").classList.add("hidden");
  showAsked(asked);
  paintAnswer("", true);
  const rid = ++state.rid;
  deltaHandlers.set(rid, (t) => paintAnswer(t, true));
  const r = await fn(rid);
  deltaHandlers.delete(rid);
  if (r.cancelled) return r;
  const text = r.ok ? (r.text || "—") : r.error;
  setAnswer(text, { title, more: r.ok ? more : null, asked });
  if (!r.ok) {
    setPhase("erro", { err: true });
    if (r.rate) onRateLimit("resposta");
  }
  if (r.ok) state.chat.push({ role: "bot", title, text, asked });
  if (r.warn) toastOnce(r.warn, 6000);
  return r;
}

const linesForAI = () => state.lines.map(({ who, text }) => ({ who, text }));

function isInterviewSession() {
  const id = state.session && state.session.playbook;
  if (!id) return false;
  const pbs = Array.isArray(state.settings.playbooks) ? state.settings.playbooks : [];
  const pb = pbs.find((p) => p.id === id);
  return pb ? pb.style === "interview" : /^entrevista/.test(String(id));
}

function effectiveReplyLang() {
  const lang = currentLang();
  if (lang === "en") return "en";
  if (lang === "pt") return "pt";
  const rev = [...state.lines].reverse();
  // Entrevista no viva-voz: a fala da recrutadora pode chegar pelo microfone.
  const lastThem = rev.find((l) => l.who === "them") || (isInterviewSession() ? rev.find((l) => l.lang) : null);
  return lastThem && lastThem.lang === "en" ? "en" : "pt";
}

function assist(more = false) {
  const lang = effectiveReplyLang();
  return runAI("O que falar agora", (rid) => api.suggest(linesForAI(), lang, rid, more), {
    asked: "O que falar agora",
    more: more ? null : () => assist(true),
  });
}

function researchTopic(customTopic = "") {
  const typed = String(customTopic || $("askInput").value || "").trim();
  if (typed && !customTopic) $("askInput").value = "";
  const label = typed ? `Consultar: ${typed}` : "Consultar assunto recente";
  return runAI("Consultar assunto", (rid) => api.research(linesForAI(), typed, rid), { asked: label });
}

function runLiveCode(customHint = "") {
  const hint = String(customHint || $("askInput").value || "").trim();
  if (hint && !customHint) $("askInput").value = "";
  return runAI("Modo Código", (rid) => api.livecode(linesForAI(), {
    promptHint: hint,
    lang: effectiveReplyLang(),
    useScreen: true,
    useClipboard: state.settings.includeClipboard !== false,
  }, rid), { asked: hint ? `Código: ${hint}` : "Análise de código / tela + clipboard" });
}

function ask(q) {
  const screen = Boolean((state.session && state.session.captureScreen) || currentMode() === "livecoding");
  return runAI("Perguntar", (rid) => api.ask(linesForAI(), q, screen, rid, screen ? "voice" : undefined), { asked: q });
}

function syncVoiceHint() {
  const el = $("voiceHint");
  $("btnVoiceAsk").classList.toggle("armed", state.armVoiceAsk);
  if (!state.recording) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  if (!state.hearingMic) {
    el.textContent = "Sem microfone ativo: capturando apenas o áudio do computador.";
    return;
  }
  el.textContent = state.armVoiceAsk
    ? "Pergunta por voz armada: fale sua dúvida agora."
    : "Ouvindo em silêncio. Clique no microfone do campo abaixo para perguntar por voz.";
}

function syncScreenHint() {
  const on = Boolean((state.session && state.session.captureScreen) || currentMode() === "livecoding");
  $("screenHint").classList.toggle("hidden", !on);
}

async function refreshScreen() {
  const allow = Boolean((state.session && state.session.captureScreen) || currentMode() === "livecoding");
  if (!state.recording || state.discard || state.screenBusy || state.sttBusy || !allow) return;
  state.screenBusy = true;
  try {
    const r = await api.screenRefresh();
    if (!state.recording || state.discard) { api.screenLiveStop().catch(() => {}); return; }
    if (r && r.warn) toastOnce(r.warn, 6000);
  } catch { /* próxima consulta tenta novamente */ }
  finally { state.screenBusy = false; }
}
function startScreenWatch() {
  stopScreenWatch(false);
  const allow = Boolean((state.session && state.session.captureScreen) || currentMode() === "livecoding");
  if (!allow) return;
  refreshScreen();
  state.screenIv = setInterval(refreshScreen, 8000);
}
function stopScreenWatch(clear = true) {
  clearInterval(state.screenIv);
  state.screenIv = null;
  if (clear && api.screenLiveStop) api.screenLiveStop().catch(() => {});
}

function maybeVoiceAsk(text) {
  // v0.3.1 — silêncio total na escuta: a pergunta por voz só existe quando o usuário
  // arma o microfone manualmente em #btnVoiceAsk. Nenhum wake-word automático.
  if (!state.recording || state.discard || !state.hearingMic || !state.armVoiceAsk) return;
  state.armVoiceAsk = false;
  syncVoiceHint();
  const question = String(text || "").trim();
  if (!question) return;
  if (state.voiceBusy) { state.voiceQueued = question; return; }
  runVoiceAsk(question);
}
async function runVoiceAsk(question) {
  state.voiceBusy = true;
  const withScreen = Boolean((state.session && state.session.captureScreen) || currentMode() === "livecoding");
  setPhase("respondendo…");
  try {
    const r = await runAI("Pergunta por voz", (rid) => api.ask(linesForAI(), question, withScreen, rid, withScreen ? "voice" : undefined), { asked: question });
    if (r && r.warn) toastOnce(r.warn, 6000);
  } finally {
    state.voiceBusy = false;
    if (state.recording) setPhase("Ouvindo", { live: true });
    const next = state.voiceQueued;
    state.voiceQueued = "";
    if (next && state.recording && !state.discard) runVoiceAsk(next);
  }
}

// Tradução ao vivo em lote quando idioma = EN ou fala detectada em inglês
function shouldTranslateLine(line) {
  if (!line || line.pt) return false;
  // Em entrevista, traduz também o microfone (chamada no viva-voz / celular perto do PC).
  if (line.who !== "them" && !(isInterviewSession() && line.lang === "en")) return false;
  const lang = currentLang();
  if (lang === "pt") return false;
  if (lang === "en") return line.lang !== "pt";
  return line.lang === "en";
}
function queueTranslate(line) {
  if (!shouldTranslateLine(line) || !api.translateBatch) return;
  state.pendingTr.push({ id: line.id, text: line.text });
  clearTimeout(state.trTimer);
  state.trTimer = setTimeout(flushTranslate, 140);
}
async function flushTranslate() {
  if (state.trBusy || !state.pendingTr.length || state.discard) return;
  state.trBusy = true;
  const batch = state.pendingTr.splice(0, 6);
  const history = state.lines.slice(-6).map((l) => l.text);
  try {
    const r = await api.translateBatch(batch, history, 0);
    if (r && r.ok && Array.isArray(r.items)) {
      let changed = false;
      for (const item of r.items) {
        const target = state.lines.find((l) => l.id === item.id);
        if (target && item.pt) {
          target.pt = item.pt;
          renderLine(target);
          changed = true;
        }
      }
      if (changed) persistLinesNow();
    }
  } catch { /* mantém original */ }
  finally {
    state.trBusy = false;
    if (state.pendingTr.length && !state.discard) flushTranslate();
  }
}

function persistLinesNow() {
  if (!api.syncLines || !state.session || !state.session.id || !state.lines.length) return;
  api.syncLines(state.session.id, state.lines).catch(() => {});
}

async function flushNotesNow() {
  clearTimeout(state.notesDirtyTimer);
  state.notesDirtyTimer = null;
  if (!state.session || !state.session.id || !api.updateMeeting) return;
  const val = $("notesArea").value;
  if (val === (state.session.notes || "")) return;
  try {
    const updated = await api.updateMeeting(state.session.id, { notes: val });
    if (updated) state.session = { ...state.session, notes: updated.notes };
  } catch { /* salvo na próxima tentativa */ }
}
function scheduleNotesSave() {
  clearTimeout(state.notesDirtyTimer);
  state.notesDirtyTimer = setTimeout(flushNotesNow, 450);
}

async function screenAsk() {
  const r = await api.screenPreview();
  if (!r.ok) { toast(r.error || "Não capturei a tela.", 5000); return; }
  openCard(true);
  state.shotPending = true;
  $("shotImg").src = r.preview;
  $("shotMeta").textContent = r.sourceName ? `${r.sourceName} · Enter envia` : "Enter para enviar";
  $("shotBox").classList.remove("hidden");
}
function shotHide() { state.shotPending = false; $("shotBox").classList.add("hidden"); $("shotImg").removeAttribute("src"); }
function shotCancel() { shotHide(); api.screenCancel(); }
function shotDrop() { if (state.shotPending) { shotHide(); api.screenCancel(); } }
async function shotSend() {
  shotHide();
  if (currentMode() === "livecoding") {
    await runLiveCode($("askInput").value.trim());
    $("askInput").value = "";
    return;
  }
  const custom = $("askInput").value.trim();
  $("askInput").value = "";
  await runAI("Tela", (rid) => api.ask(linesForAI(), custom || "Use só o que for relevante à reunião neste print. Não descreva o PC inteiro.", true, rid));
}

const MIME = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
let seq = 0;
const sttQ = { me: [], them: [] };
const sttOn = { me: false, them: false };
function sttKey(who) { return who === "me" ? "me" : "them"; }
function syncSttBusy() { state.sttBusy = (sttOn.me ? 1 : 0) + (sttOn.them ? 1 : 0); }
function enqueueChunk(blob, who, retry = false) {
  const key = sttKey(who);
  const packed = LineUtil.enqueueStt(sttQ[key], { blob, retry }, 4);
  sttQ[key] = packed.queue;
  if (packed.dropped) toastOnce("A transcrição atrasou. Sigo com o trecho mais recente.");
  pumpStt(key);
}
async function pumpStt(who) {
  const key = sttKey(who);
  if (sttOn[key] || !sttQ[key].length || state.discard) return;
  const job = sttQ[key].shift();
  sttOn[key] = true;
  syncSttBusy();
  try { await handleChunk(job.blob, key, job.retry); }
  finally {
    sttOn[key] = false;
    syncSttBusy();
    if (state.recording && !state.sttBusy && !state.voiceBusy) setPhase("Ouvindo", { live: true });
    pumpStt(key);
  }
}

// Gravador com medição de 50ms e handoff em sobreposição (400ms overlap sem buraco cego entre blocos)
function makeRecorder(stream, ctx, analyserSrc, who) {
  const TICK_MS = 50;
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  analyserSrc.connect(an);
  const buf = new Float32Array(an.fftSize);
  const rec = { stopped: false, active: null, meter: null };

  stream.getAudioTracks().forEach((track) => {
    track.onended = () => {
      if (rec.stopped) return;
      setPhase("erro: áudio caiu", { err: true });
      toastOnce(who === "me" ? "O microfone parou. Toque em ouvir para retomar." : "O áudio do PC parou. Toque em ouvir para retomar.", 7000);
    };
  });

  function spawnSlot() {
    if (rec.stopped) return null;
    if (!stream.getAudioTracks().some((t) => t.readyState === "live")) return null;
    const chunks = [];
    let mr;
    try {
      mr = new MediaRecorder(stream, MIME ? { mimeType: MIME, audioBitsPerSecond: 32000 } : undefined);
    } catch (e) {
      toastOnce(mediaMessage(e, who === "me" ? "Microfone" : "Áudio do PC"));
      if (!rec.stopped) setTimeout(() => { if (!rec.active) rec.active = spawnSlot(); }, 350);
      return null;
    }
    const slot = { mr, startAt: Date.now(), voicedMs: 0, silentMs: 0, overlapped: false, timer: null };
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      clearTimeout(slot.timer);
      const blob = chunks.length ? new Blob(chunks, { type: mr.mimeType || "audio/webm" }) : null;
      if (slot.voicedMs >= 200 && blob) enqueueChunk(blob, who);
    };
    try {
      mr.start();
    } catch (e) {
      toastOnce(mediaMessage(e, who === "me" ? "Microfone" : "Áudio do PC"));
      if (!rec.stopped) setTimeout(() => { if (!rec.active) rec.active = spawnSlot(); }, 350);
      return null;
    }
    const maxMs = chunkSecs() * 1000;
    slot.timer = setTimeout(() => {
      if (rec.active === slot && !rec.stopped) rec.active = spawnSlot();
      if (mr.state !== "inactive") mr.stop();
    }, maxMs);
    return slot;
  }

  rec.active = spawnSlot();
  rec.meter = setInterval(() => {
    const slot = rec.active;
    if (!slot || rec.stopped) return;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    if (rms > 0.0085) {
      slot.voicedMs += TICK_MS;
      slot.silentMs = 0;
    } else {
      slot.silentMs += TICK_MS;
    }
    const elapsedMs = Date.now() - slot.startAt;
    const maxMs = chunkSecs() * 1000;

    // Se está falando contínuo perto do limite do bloco, abre o próximo gravador 400ms antes (pré-roll/overlap real)
    if (!slot.overlapped && slot.voicedMs >= 200 && LineUtil.shouldStartOverlap({ elapsedMs, maxMs })) {
      slot.overlapped = true;
      const nextSlot = spawnSlot();
      if (nextSlot) {
        rec.active = nextSlot;
        setTimeout(() => { if (slot.mr.state !== "inactive") slot.mr.stop(); }, LineUtil.OVERLAP_MS);
      }
      return;
    }

    const cut = who === "me"
      ? LineUtil.shouldCutVoice({ elapsedMs, voicedMs: slot.voicedMs, silentMs: slot.silentMs })
      : LineUtil.shouldCut({ elapsedMs, maxMs, voicedMs: slot.voicedMs, silentMs: slot.silentMs });
    if (cut && slot.mr.state === "recording") {
      rec.active = spawnSlot();
      slot.mr.stop();
    }
  }, TICK_MS);

  rec.stop = () => {
    rec.stopped = true;
    clearInterval(rec.meter);
    if (rec.active) {
      clearTimeout(rec.active.timer);
      if (rec.active.mr && rec.active.mr.state !== "inactive") rec.active.mr.stop();
      rec.active = null;
    }
  };
  return rec;
}

async function handleChunk(blob, who = "them", retried = false, forcedId = 0) {
  if (state.discard) return;
  const id = forcedId || ++seq;
  const r = await api.transcribe(await blob.arrayBuffer(), blob.type, who, currentLang());
  if (state.discard || r.cancelled) return;
  if (!r.ok && r.rate) {
    onRateLimit("transcrição");
    if (!retried && !sttQ[sttKey(who)].length) {
      setPhase("limite da Groq…");
      await sleep(state.rateWaitMs);
      return handleChunk(blob, who, true, id);
    }
  }
  if (!r.ok) {
    toastOnce(`Transcrição (${who === "me" ? "microfone" : "áudio do PC"}): ${r.error}`);
    if (state.recording) setPhase("Ouvindo", { live: true });
    return;
  }
  if (state.recording) setPhase("Ouvindo", { live: true });
  if (!r.text || r.skipped || LineUtil.isNoise(r.text)) return;

  const sameWhoPrev = [...state.lines].reverse().find((l) => l.who === who && l.id < id);
  const stitched = sameWhoPrev ? LineUtil.trimOverlap(sameWhoPrev.text, r.text) : r.text;
  if (!stitched || LineUtil.isNoise(stitched)) return;

  const recent = state.lines.filter((l) => l.id < id).slice(-8).map((l) => l.text);
  if (LineUtil.isDuplicate(recent, stitched)) {
    // P0.3: nunca disparar voz em duplicata/eco acústico!
    return;
  }

  const line = { id, who, text: stitched, lang: r.language || "", pt: "", at: new Date().toISOString() };
  state.lines.push(line);
  state.lines.sort((a, b) => a.id - b.id);
  renderLine(line);
  persistLinesNow();
  queueTranslate(line);
  // v0.3.1 — silêncio total: a escuta apenas transcreve; nada de cards automáticos.
  // Pergunta por voz só quando o microfone foi armado manualmente (#btnVoiceAsk).
  if (who === "me" && state.armVoiceAsk) maybeVoiceAsk(line.text);
}

function hydrateSession(session) {
  const prevId = state.session && state.session.id;
  state.session = session || null;
  if (session) {
    if (document.activeElement !== $("notesArea")) {
      $("notesArea").value = session.notes || "";
    }
    if (Array.isArray(session.lines) && (prevId !== session.id || !state.lines.length)) {
      state.lines = session.lines.map((l, idx) => ({ ...l, id: l.id || idx + 1 }));
      seq = state.lines.reduce((m, l) => Math.max(m, Number(l.id) || 0), seq);
      $("transcript").innerHTML = "";
      state.lines.forEach(renderLine);
    }
  }
  syncSegs();
  syncScreenHint();
}

function tick() {
  const s = Math.floor((state.elapsedMs + (state.recording ? Date.now() - state.startedAt : 0)) / 1000);
  $("timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

async function start() {
  if (state.starting || state.recording || state.ended) return;
  state.settings = await api.getSettings();
  hydrateSession(state.settings.session || state.session);
  if (!state.settings.hasGroqKey && !state.settings.hasGeminiKey && !state.settings.mock) {
    toast("Falta a chave da Groq em Ajustes. Sem chave, a transcrição não roda.", 6000);
    setPhase("sem chave", { err: true });
    return;
  }
  state.starting = true;
  state.discard = false;
  state.paused = false;
  state.chunkAuto = 0;
  if (typeof api.warm === "function") api.warm().catch(() => {});
  const gen = state.gen;
  const alive = () => state.gen === gen;
  setPhase("abrindo áudio…");
  const ctx = new AudioContext();
  const sources = [];
  const problems = [];
  const opened = [];
  const giveUp = () => { opened.forEach((s) => s.getTracks().forEach((t) => t.stop())); ctx.close(); };
  try {
    const wantSys = state.session ? state.session.captureSystem !== false : state.settings.captureSystem !== false;
    const wantMic = state.session ? state.session.captureMic !== false : state.settings.captureMic !== false;
    if (wantSys) {
      try {
        const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        opened.push(sys);
        sys.getVideoTracks().forEach((t) => t.stop());
        if (!sys.getAudioTracks().length) throw Object.assign(new Error("sem trilha de áudio"), { name: "NoAudio" });
        sources.push({ who: "them", stream: new MediaStream(sys.getAudioTracks()) });
      } catch (e) { problems.push(mediaMessage(e, "Áudio do PC")); }
      if (!alive()) { giveUp(); return; }
    }
    if (wantMic) {
      try {
        const micId = (state.session && state.session.micDeviceId) || state.settings.micDeviceId || "";
        const audioCfg = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(micId ? { deviceId: { ideal: micId } } : {}),
        };
        const mic = await navigator.mediaDevices.getUserMedia({ audio: audioCfg });
        opened.push(mic);
        sources.push({ who: "me", stream: mic });
      } catch (e) { problems.push(mediaMessage(e, "Microfone")); }
      if (!alive()) { giveUp(); return; }
    }
    if (!sources.length) {
      giveUp();
      setPhase("parado");
      toast(`Não consegui ouvir nada. ${problems.join(" ")}`, 9000);
      return;
    }
    if (problems.length) toast(`${problems.join(" ")} Sigo com o que abriu.`, 7000);
    state.streams = opened;
    state.ctx = ctx;
    state.recs = sources.map((s) => makeRecorder(s.stream, ctx, ctx.createMediaStreamSource(s.stream), s.who));
    state.hearingMic = sources.some((s) => s.who === "me");
    state.recording = true;
    state.startedAt = Date.now();
    tick();
    state.timerIv = setInterval(tick, 1000);
    $("btnEnd").classList.remove("hidden");
    setPhase("Ouvindo", { live: true });
    openCard(true);
    syncSegs();
    syncVoiceHint();
    syncScreenHint();
    startScreenWatch();
    if (api.setHotkeysActive) api.setHotkeysActive(true);
    if (api.resumeMeeting && state.session) api.resumeMeeting(state.session.id).catch(() => {});
  } catch (e) {
    giveUp();
    setPhase("parado");
    toast(`Não consegui iniciar: ${(e && e.message) || e}`, 7000);
  } finally {
    state.starting = false;
  }
}

function stopCapture(discard = true) {
  state.gen += 1;
  state.discard = discard;
  state.recs.forEach((r) => r.stop());
  state.recs = [];
  state.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  state.streams = [];
  if (state.ctx) { state.ctx.close(); state.ctx = null; }
  if (state.recording) state.elapsedMs += Date.now() - state.startedAt;
  clearInterval(state.timerIv);
  state.recording = false;
  state.hearingMic = false;
  state.armVoiceAsk = false;
  state.voiceQueued = "";
  sttQ.me = [];
  sttQ.them = [];
  stopScreenWatch();
  state.pendingTr = [];
  clearTimeout(state.trTimer);
  state.trTimer = null;
  if (discard) deltaHandlers.clear();
  shotDrop();
  if (api.setHotkeysActive) api.setHotkeysActive(false);
}

function pauseListen() {
  if (!state.recording) return;
  stopCapture(false);
  persistLinesNow();
  flushNotesNow();
  state.paused = true;
  state.discard = false;
  setPhase("Pausado");
  if (api.pauseMeeting && state.session) api.pauseMeeting(state.session.id).catch(() => {});
}

function stopSession(discard = true) {
  persistLinesNow();
  flushNotesNow();
  stopCapture(discard);
  state.paused = false;
  $("btnEnd").classList.add("hidden");
  setPhase(state.ended ? "Encerrada" : "Pronto");
  syncVoiceHint();
}

const toggleStart = () => {
  if (state.ended) return;
  if (state.recording || state.starting) pauseListen();
  else start();
};

async function endMeeting() {
  const durationMs = state.elapsedMs + (state.recording ? Date.now() - state.startedAt : 0);
  await flushNotesNow();
  persistLinesNow();
  stopSession(false);
  state.ended = true;
  setPhase("Encerrada");
  $("btnEnd").classList.add("hidden");
  await runAI("Encerrar", (rid) => api.wrapup(state.lines, rid, durationMs));
}

function applyTheme(t) { document.documentElement.setAttribute("data-mtheme", t === "light" ? "light" : "dark"); }

async function fillMenu() {
  $("mOpacity").value = Number(state.settings.opacity) || 1;
  $("mMic").checked = state.session ? state.session.captureMic !== false : !!state.settings.captureMic;
  $("mScreen").checked = state.session ? Boolean(state.session.captureScreen) : Boolean(state.settings.captureScreen);
  $("mClip").checked = state.settings.includeClipboard !== false;

  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const mics = devs.filter((d) => d.kind === "audioinput");
      const selMic = (state.session && state.session.micDeviceId) || state.settings.micDeviceId || "";
      $("mMicDevice").innerHTML = '<option value="">Padrão do sistema</option>' +
        mics.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || "Microfone " + (i + 1))}</option>`).join("");
      $("mMicDevice").value = selMic;
    }
  } catch { /* sem enumeração */ }

  try {
    if (api.listScreenSources) {
      const res = await api.listScreenSources();
      if (res && res.ok && Array.isArray(res.sources)) {
        const selSrc = (state.session && state.session.screenSourceId) || state.settings.screenSourceId || "";
        $("mScreenSource").innerHTML = '<option value="">Tela principal</option>' +
          res.sources.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
        $("mScreenSource").value = selSrc;
      }
    }
  } catch { /* sem fontes */ }
}

function bind() {
  $("btnStart").onclick = toggleStart;
  $("btnEnd").onclick = endMeeting;
  $("btnLogo").onclick = () => openCard(!state.cardOpen);
  $("btnHide").onclick = () => { stopSession(); api.hide(); };
  $("btnMenu").onclick = (e) => { e.stopPropagation(); fillMenu(); $("menu").classList.toggle("hidden"); };
  document.addEventListener("click", (e) => { if (!$("menu").contains(e.target)) $("menu").classList.add("hidden"); });

  document.querySelectorAll("#modeSeg .seg-b").forEach((btn) => {
    btn.onclick = async () => {
      const mode = btn.dataset.mode;
      const patch = { meetingMode: mode };
      if (mode === "livecoding") patch.captureScreen = true;
      state.settings = await api.setSettings(patch);
      hydrateSession(state.settings.session || state.session);
      if (state.recording) startScreenWatch();
    };
  });

  document.querySelectorAll("#langSeg .seg-b").forEach((btn) => {
    btn.onclick = async () => {
      state.settings = await api.setSettings({ meetingLang: btn.dataset.lang });
      syncSegs();
    };
  });

  $("mTheme").onclick = () => {
    const t = document.documentElement.getAttribute("data-mtheme") === "light" ? "dark" : "light";
    applyTheme(t);
    try { localStorage.setItem("heliosMeetingTheme", t); } catch { /* ok */ }
  };
  $("mOpacity").onchange = async () => { state.settings = await api.setSettings({ opacity: Number($("mOpacity").value) }); };
  $("mMic").onchange = async () => { state.settings = await api.setSettings({ captureMic: $("mMic").checked }); syncVoiceHint(); };
  $("mMicDevice").onchange = async () => {
    state.settings = await api.setSettings({ micDeviceId: $("mMicDevice").value });
    hydrateSession(state.settings.session || state.session);
    if (state.recording) { pauseListen(); start(); }
  };
  $("mScreen").onchange = async () => {
    state.settings = await api.setSettings({ captureScreen: $("mScreen").checked });
    hydrateSession(state.settings.session || state.session);
    if (state.recording) startScreenWatch();
  };
  $("mScreenSource").onchange = async () => {
    state.settings = await api.setSettings({ screenSourceId: $("mScreenSource").value });
    hydrateSession(state.settings.session || state.session);
    if (state.recording) refreshScreen();
  };
  $("mClip").onchange = async () => {
    state.settings = await api.setSettings({ includeClipboard: $("mClip").checked });
  };

  $("chipSay").onclick = () => assist();
  $("chipResearch").onclick = () => researchTopic();
  $("chipCode").onclick = () => { openCard(true); showCode(); };
  $("btnGenGuide").onclick = () => runLiveCode();
  $("chipInsights").onclick = () => {
    if (!state.last) runAI("Ajuda", (rid) => api.insights(linesForAI(), rid));
    else showInsights();
  };
  $("chipNotes").onclick = () => { openCard(true); showNotes(!state.notesOpen); };
  $("chipTranscript").onclick = () => { openCard(true); showTranscript(!state.transcriptOpen); };
  $("chipShot").onclick = screenAsk;

  $("ansMain").addEventListener("click", async (e) => {
    const btn = e.target.closest(".copy-blk");
    if (!btn) return;
    const code = state.codeBlocks[Number(btn.dataset.idx)] || "";
    toast((await copyText(code)) ? "Bloco copiado." : "Não copiei.", 1500);
  });

  $("btnMore").onclick = () => { if (state.last && state.last.more) state.last.more(); };
  $("btnCopy").onclick = async () => { if (state.last) toast((await copyText(state.last.text)) ? "Copiado." : "Não copiei.", 1500); };
  $("btnCopyCode").onclick = async () => { if (state.lastCode) toast((await copyText(state.lastCode)) ? "Código copiado." : "Não copiei.", 1500); };
  $("btnShotSend").onclick = shotSend;
  $("btnShotCancel").onclick = shotCancel;

  $("btnVoiceAsk").onclick = () => {
    if (!state.recording || !state.hearingMic) {
      toast("Inicie a escuta com microfone para perguntar por voz.", 3000);
      return;
    }
    state.armVoiceAsk = !state.armVoiceAsk;
    syncVoiceHint();
  };

  $("noteForm").onsubmit = async (e) => {
    e.preventDefault();
    const txt = $("noteInput").value.trim();
    if (!txt) return;
    $("noteInput").value = "";
    const stamp = $("timer").textContent || "00:00";
    const cur = $("notesArea").value.trim();
    $("notesArea").value = (cur ? cur + "\n" : "") + `[${stamp}] ${txt}`;
    await flushNotesNow();
    toast("Nota registrada.", 1400);
  };
  $("notesArea").addEventListener("input", scheduleNotesSave);
  $("notesArea").addEventListener("blur", () => flushNotesNow());

  $("askForm").onsubmit = (e) => {
    e.preventDefault();
    const q = $("askInput").value.trim();
    if (!q) return;
    $("askInput").value = "";
    const sayMatch = q.match(/^(?:en|ingl[eê]s)\s*[:>]\s*([\s\S]+)$/i);
    if (sayMatch && api.sayEn) {
      runAI("Como falar em inglês", (rid) => api.sayEn(sayMatch[1].trim(), rid), { asked: `EN: ${sayMatch[1].trim()}` });
      return;
    }
    if (currentMode() === "livecoding" && /^(\/code|analise|corrija|otimize|explique o erro)/i.test(q)) {
      runLiveCode(q.replace(/^\/code\s*/i, ""));
      return;
    }
    ask(q);
  };

  api.onHotkey((n) => {
    if (n === "assist") assist();
    else if (n === "research") researchTopic();
    else if (n === "code") runLiveCode();
    else if (n === "smart") {
      if (currentMode() === "livecoding") runLiveCode();
      else assist();
    }
    else if (n === "record") toggleStart();
    else if (n === "screen") screenAsk();
    else if (n === "clickthrough") {
      state.clickThrough = !state.clickThrough;
      $("ctBadge").classList.toggle("hidden", !state.clickThrough);
    }
  });

  api.onMeetingStop((info) => {
    if (info && info.stop) {
      if (state.recording || state.starting) stopSession();
      shotDrop();
    }
    if (state.clickThrough) {
      state.clickThrough = false;
      $("ctBadge").classList.add("hidden");
    }
  });

  if (api.onSession) api.onSession((session) => hydrateSession(session));

  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const el = document.activeElement;
    const typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    if (e.key === "Enter" && state.shotPending && !typing) { e.preventDefault(); shotSend(); return; }
    if (e.altKey && (e.key === "s" || e.key === "S")) { e.preventDefault(); assist(); return; }
    if (e.altKey && (e.key === "p" || e.key === "P")) { e.preventDefault(); researchTopic(); return; }
    if (e.altKey && (e.key === "c" || e.key === "C")) { e.preventDefault(); runLiveCode(); return; }
    if (e.key !== "Escape") return;
    if (state.shotPending) { shotCancel(); return; }
    if (!$("menu").classList.contains("hidden")) { $("menu").classList.add("hidden"); return; }
    if (state.recording) return;
    if (typing && el.value) { el.blur(); return; }
    api.hide();
  });

  api.onHotkeysFailed((l) => toast(`Atalho em uso por outro app: ${l.join(", ")}`, 6000));
}

(async () => {
  bind();
  try { applyTheme(localStorage.getItem("heliosMeetingTheme") || "light"); } catch { applyTheme("light"); }
  state.settings = await api.getSettings();
  const initialSession = state.settings.session || (api.activeMeeting ? await api.activeMeeting() : null);
  hydrateSession(initialSession);
  if (state.session && state.session.status === "live") start();
  fit();
})();
