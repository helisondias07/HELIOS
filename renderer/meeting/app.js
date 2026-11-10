"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  lines: [], recording: false, starting: false, paused: false, gen: 0, discard: false, shotPending: false, timing: {}, recs: [], streams: [], ctx: null, settings: {}, clickThrough: false,
  session: null, chat: [], pendingTr: [], trBusy: false, trPauseUntil: 0, trTimer: null, chunkAuto: 0, rateWaitMs: 5000, rid: 0, startedAt: 0, elapsedMs: 0, timerIv: null,
  view: "insights", last: null, question: "", cardOpen: false, transcriptOpen: false,
  voiceBusy: false, voiceQueued: "", hearingMic: false, screenIv: null, screenBusy: false, sttBusy: 0, ended: false,
};
const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fit = () => api.setHeight(Math.ceil($("root").getBoundingClientRect().height) + 4);
new ResizeObserver(fit).observe($("root"));
function openCard(on = true) { state.cardOpen = on; $("card").classList.toggle("hidden", !on); }

function setPhase(text, { live = false, err = false } = {}) {
  $("phase").textContent = text;
  $("btnStart").title = text;
  $("dot").classList.toggle("live", live);
  $("dot").classList.toggle("err", err);
  $("btnStart").classList.toggle("on", live || state.paused);
}
function toast(msg, ms = 3500) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  $("root").appendChild(t); setTimeout(() => t.remove(), ms);
}
const lastToast = new Map();
function toastOnce(msg, ms = 5000) { const now = Date.now(); if (now - (lastToast.get(msg) || 0) < 30000) return; lastToast.set(msg, now); toast(msg, ms); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunkSecs = () => state.chunkAuto || Number(state.settings.chunkSeconds) || 9;
function onRateLimit(where) {
  if (chunkSecs() < 9) {
    state.chunkAuto = 9;
    toastOnce(`Limite da Groq (${where}). Aumentei o bloco de áudio para 9 s.`, 6000);
  } else toastOnce(`Limite da Groq (${where}). Continuo em alguns segundos.`, 6000);
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
  try { await navigator.clipboard.writeText(text); return true; } catch { /* plano B */ }
  try { const ta = document.createElement("textarea"); ta.value = text; ta.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove(); return ok; } catch { return false; }
}

function showTranscript(on) {
  state.transcriptOpen = on;
  $("transcript").classList.toggle("hidden", !on);
  $("chipTranscript").classList.toggle("on", on);
  $("chipInsights").classList.toggle("on", !on && state.view === "insights");
  if (on) { const b = $("transcript"); b.scrollTop = b.scrollHeight; }
}
function showInsights() {
  state.view = "insights";
  showTranscript(false);
  $("answer").classList.remove("hidden");
  $("chipInsights").classList.add("on");
  openCard(true);
}

const WHO = { me: "Você", them: "Outro" };
function renderLine(l) {
  const box = $("transcript");
  let el = box.querySelector(`[data-id="${l.id}"]`);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (!el) { el = document.createElement("div"); el.dataset.id = l.id; box.appendChild(el); }
  el.className = `line ${l.who || ""} plain`;
  el.innerHTML = `<span class="who">${WHO[l.who] || ""}</span><span class="orig">${esc(l.pt || l.text)}</span>`;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function paintAnswer(text, streaming = false) {
  $("ansMain").textContent = text || (streaming ? "…" : "");
  $("ansMain").classList.toggle("wait", streaming && !text);
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
  paintAnswer(text);
  $("btnMore").classList.toggle("hidden", !more);
}
async function runAI(title, fn, { more = null, asked = "" } = {}) {
  showInsights(); $("btnMore").classList.add("hidden");
  showAsked(asked);
  paintAnswer("", true);
  const rid = ++state.rid;
  deltaHandlers.set(rid, (t) => paintAnswer(t, true));
  const r = await fn(rid);
  deltaHandlers.delete(rid);
  if (r.cancelled) return r;
  const text = r.ok ? (r.text || "—") : r.error;
  setAnswer(text, { title, more: r.ok ? more : null, asked });
  if (!r.ok) { setPhase("erro", { err: true }); if (r.rate) onRateLimit("resposta"); }
  if (r.ok) state.chat.push({ role: "bot", title, text, asked });
  if (r.warn) toastOnce(r.warn, 6000);
  return r;
}
const linesForAI = () => state.lines.map(({ who, text }) => ({ who, text }));
function assist(more = false) {
  hideQuestion();
  return runAI("O que digo", (rid) => api.suggest(linesForAI(), "pt", rid, more), { more: more ? null : () => assist(true) });
}
function ask(q) {
  const screen = !!(state.session && state.session.captureScreen);
  return runAI("Perguntar", (rid) => api.ask(linesForAI(), q, screen, rid, screen ? "voice" : undefined), { asked: q });
}

function syncVoiceHint() {
  const el = $("voiceHint");
  if (!state.recording) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.textContent = state.hearingMic
    ? "Ouvindo. Perguntas faladas aparecem como texto. Fatos vêm da transcrição; o resto é sugestão."
    : "Sem microfone: só o áudio do computador. Ligue o microfone no menu para perguntar por voz.";
}
function syncScreenHint() {
  const on = !!(state.session && state.session.captureScreen);
  $("screenHint").classList.toggle("hidden", !on);
}

async function refreshScreen() {
  if (!state.recording || state.discard || state.screenBusy || state.sttBusy || !state.session || !state.session.captureScreen) return;
  state.screenBusy = true;
  try {
    const r = await api.screenRefresh();
    if (!state.recording || state.discard) { api.screenLiveStop().catch(() => {}); return; }
    if (r && r.warn) toastOnce(r.warn, 6000);
  } catch { /* a pergunta tenta de novo */ }
  finally { state.screenBusy = false; }
}
function startScreenWatch() {
  stopScreenWatch(false);
  if (!state.session || !state.session.captureScreen) return;
  refreshScreen();
  state.screenIv = setInterval(refreshScreen, 8000);
}
function stopScreenWatch(clear = true) {
  clearInterval(state.screenIv);
  state.screenIv = null;
  if (clear && api.screenLiveStop) api.screenLiveStop().catch(() => {});
}
function maybeVoiceAsk(text) {
  if (!state.recording || state.discard || !state.hearingMic) return;
  if (!LineUtil.isVoiceQuestion(text)) return;
  if (state.voiceBusy) { state.voiceQueued = text; return; }
  runVoiceAsk(text);
}
async function runVoiceAsk(text) {
  state.voiceBusy = true;
  const withScreen = !!(state.session && state.session.captureScreen);
  setPhase("respondendo…");
  try {
    const r = await runAI("Pergunta por voz", (rid) => api.ask(linesForAI(), text, withScreen, rid, withScreen ? "voice" : undefined), { asked: text });
    if (r && r.warn) toastOnce(r.warn, 6000);
  } finally {
    state.voiceBusy = false;
    if (state.recording) setPhase("Ouvindo", { live: true });
    const next = state.voiceQueued;
    state.voiceQueued = "";
    if (next && state.recording && !state.discard) maybeVoiceAsk(next);
  }
}

async function detectQuestion(line) {
  if (!api.detect || line.who !== "them") return;
  const r = await api.detect(line.text);
  if (!r || !r.ok || !r.question || state.discard) return;
  state.question = r.question;
  $("chipQText").textContent = r.question; $("chipQ").classList.remove("hidden"); openCard(true);
}
function hideQuestion() { state.question = ""; $("chipQ").classList.add("hidden"); }

async function screenAsk() {
  const r = await api.screenPreview();
  if (!r.ok) { toast(r.error || "Não capturei a tela.", 5000); return; }
  openCard(true);
  state.shotPending = true; $("shotImg").src = r.preview; $("shotBox").classList.remove("hidden");
}
function shotHide() { state.shotPending = false; $("shotBox").classList.add("hidden"); $("shotImg").removeAttribute("src"); }
function shotCancel() { shotHide(); api.screenCancel(); }
function shotDrop() { if (state.shotPending) { shotHide(); api.screenCancel(); } }
async function shotSend() { shotHide(); await runAI("Tela", (rid) => api.ask(linesForAI(), "Use só o que for relevante à reunião neste print. Não descreva o PC inteiro.", true, rid)); }

const MIME = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
let seq = 0;
const sttQ = { me: [], them: [] };
const sttOn = { me: false, them: false };
function sttKey(who) { return who === "me" ? "me" : "them"; }
function syncSttBusy() { state.sttBusy = (sttOn.me ? 1 : 0) + (sttOn.them ? 1 : 0); }
function enqueueChunk(blob, who, retry = false) {
  const key = sttKey(who);
  const packed = LineUtil.enqueueStt(sttQ[key], { blob, retry }, 2);
  sttQ[key] = packed.queue;
  if (packed.dropped) toastOnce("A transcrição atrasou. Sigo com o trecho mais recente.");
  pumpStt(key);
}
async function pumpStt(who) {
  const key = sttKey(who);
  if (sttOn[key] || !sttQ[key].length || state.discard) return;
  const job = sttQ[key].shift();
  sttOn[key] = true; syncSttBusy();
  try { await handleChunk(job.blob, key, job.retry); }
  finally {
    sttOn[key] = false; syncSttBusy();
    if (state.recording && !state.sttBusy && !state.voiceBusy) setPhase("Ouvindo", { live: true });
    pumpStt(key);
  }
}
function makeRecorder(stream, ctx, analyserSrc, who) {
  const an = ctx.createAnalyser(); an.fftSize = 1024; analyserSrc.connect(an);
  const buf = new Float32Array(an.fftSize);
  const rec = { stopped: false, voiced: 0, silent: 0, startAt: 0, mr: null, timer: null };
  stream.getAudioTracks().forEach((track) => {
    track.onended = () => {
      if (rec.stopped) return;
      setPhase("erro: áudio caiu", { err: true });
      toastOnce(who === "me" ? "O microfone parou. Toque em ouvir para retomar." : "O áudio do PC parou. Toque em ouvir para retomar.", 7000);
    };
  });
  rec.meter = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    if (Math.sqrt(sum / buf.length) > 0.01) { rec.voiced++; rec.silent = 0; } else rec.silent++;
    const elapsedMs = Date.now() - rec.startAt;
    const cut = who === "me"
      ? LineUtil.shouldCutVoice({ elapsedMs, voiced: rec.voiced, silentTicks: rec.silent })
      : LineUtil.shouldCut({ elapsedMs, maxMs: chunkSecs() * 1000, voiced: rec.voiced, silentTicks: rec.silent });
    if (rec.mr && rec.mr.state === "recording" && cut) rec.mr.stop();
  }, 100);
  const cycle = () => {
    if (rec.stopped) return;
    if (!stream.getAudioTracks().some((t) => t.readyState === "live")) return;
    const chunks = [];
    let mr;
    try {
      mr = new MediaRecorder(stream, MIME ? { mimeType: MIME, audioBitsPerSecond: 32000 } : undefined);
    } catch (e) {
      toastOnce(mediaMessage(e, who === "me" ? "Microfone" : "Áudio do PC"));
      if (!rec.stopped) setTimeout(cycle, 400);
      return;
    }
    clearTimeout(rec.timer); rec.mr = mr; rec.voiced = 0; rec.silent = 0; rec.startAt = Date.now();
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      const voiced = rec.voiced;
      const blob = chunks.length ? new Blob(chunks, { type: mr.mimeType || "audio/webm" }) : null;
      if (!rec.stopped) setTimeout(cycle, 40);
      if (voiced < 5 || !blob) return;
      enqueueChunk(blob, who);
    };
    try { mr.start(); }
    catch (e) {
      toastOnce(mediaMessage(e, who === "me" ? "Microfone" : "Áudio do PC"));
      if (!rec.stopped) setTimeout(cycle, 400);
      return;
    }
    rec.timer = setTimeout(() => { if (mr.state !== "inactive") mr.stop(); }, chunkSecs() * 1000);
  };
  cycle();
  rec.stop = () => { rec.stopped = true; clearTimeout(rec.timer); clearInterval(rec.meter); if (rec.mr && rec.mr.state !== "inactive") rec.mr.stop(); };
  return rec;
}

async function handleChunk(blob, who = "them", retried = false, forcedId = 0) {
  if (state.discard) return;
  const id = forcedId || ++seq;
  const r = await api.transcribe(await blob.arrayBuffer(), blob.type, who, "pt");
  if (state.discard || r.cancelled) return;
  if (!r.ok && r.rate) {
    onRateLimit("transcrição");
    if (!retried && !sttQ[sttKey(who)].length) { setPhase("limite da Groq…"); await sleep(state.rateWaitMs); return handleChunk(blob, who, true, id); }
  }
  if (!r.ok) { toastOnce(`Transcrição (${who === "me" ? "microfone" : "áudio do PC"}): ${r.error}`); if (state.recording) setPhase("Ouvindo", { live: true }); return; }
  if (state.recording) setPhase("Ouvindo", { live: true });
  if (!r.text || r.skipped || LineUtil.isNoise(r.text)) return;
  const recent = state.lines.filter((l) => l.id < id).slice(-8).map((l) => l.text);
  if (LineUtil.isDuplicate(recent, r.text)) {
    if (who === "me") maybeVoiceAsk(r.text);
    return;
  }
  const line = { id, who, text: r.text, lang: r.language || "", pt: "" };
  state.lines.push(line); state.lines.sort((a, b) => a.id - b.id);
  renderLine(line);
  if (who === "me") maybeVoiceAsk(line.text);
  if (who === "them") detectQuestion(line);
}

function tick() {
  const s = Math.floor((state.elapsedMs + (state.recording ? Date.now() - state.startedAt : 0)) / 1000);
  $("timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

async function start() {
  if (state.starting || state.recording || state.ended) return;
  state.settings = await api.getSettings();
  state.session = state.settings.session || state.session;
  if (!state.settings.hasGroqKey && !state.settings.hasGeminiKey && !state.settings.mock) {
    toast("Falta a chave da Groq em Ajustes. Sem chave, a transcrição não roda.", 6000);
    setPhase("sem chave", { err: true });
    return;
  }
  state.starting = true; state.discard = false; state.paused = false; state.chunkAuto = 0;
  if (typeof api.warm === "function") api.warm().catch(() => {});
  const gen = state.gen; const alive = () => state.gen === gen;
  setPhase("abrindo áudio…");
  const ctx = new AudioContext();
  const sources = []; const problems = []; const opened = [];
  const giveUp = () => { opened.forEach((s) => s.getTracks().forEach((t) => t.stop())); ctx.close(); };
  try {
    const wantSys = state.session ? state.session.captureSystem !== false : state.settings.captureSystem !== false;
    const wantMic = state.session ? state.session.captureMic !== false : state.settings.captureMic !== false;
    if (wantSys) {
      try {
        const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        opened.push(sys); sys.getVideoTracks().forEach((t) => t.stop());
        if (!sys.getAudioTracks().length) throw Object.assign(new Error("sem trilha de áudio"), { name: "NoAudio" });
        sources.push({ who: "them", stream: new MediaStream(sys.getAudioTracks()) });
      } catch (e) { problems.push(mediaMessage(e, "Áudio do PC")); }
      if (!alive()) { giveUp(); return; }
    }
    if (wantMic) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        opened.push(mic); sources.push({ who: "me", stream: mic });
      } catch (e) { problems.push(mediaMessage(e, "Microfone")); }
      if (!alive()) { giveUp(); return; }
    }
    if (!sources.length) { giveUp(); setPhase("parado"); toast(`Não consegui ouvir nada. ${problems.join(" ")}`, 9000); return; }
    if (problems.length) toast(`${problems.join(" ")} Sigo com o que abriu.`, 7000);
    state.streams = opened; state.ctx = ctx;
    state.recs = sources.map((s) => makeRecorder(s.stream, ctx, ctx.createMediaStreamSource(s.stream), s.who));
    state.hearingMic = sources.some((s) => s.who === "me");
    state.recording = true;
    state.startedAt = Date.now(); tick(); state.timerIv = setInterval(tick, 1000);
    $("btnEnd").classList.remove("hidden");
    setPhase("Ouvindo", { live: true }); openCard(true); syncVoiceHint(); syncScreenHint(); startScreenWatch();
    if (api.setHotkeysActive) api.setHotkeysActive(true);
    if (api.resumeMeeting && state.session) api.resumeMeeting(state.session.id).catch(() => {});
  } catch (e) {
    giveUp(); setPhase("parado"); toast(`Não consegui iniciar: ${(e && e.message) || e}`, 7000);
  } finally { state.starting = false; }
}

function stopCapture(discard = true) {
  state.gen += 1; state.discard = discard;
  state.recs.forEach((r) => r.stop()); state.recs = [];
  state.streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); state.streams = [];
  if (state.ctx) { state.ctx.close(); state.ctx = null; }
  if (state.recording) state.elapsedMs += Date.now() - state.startedAt;
  clearInterval(state.timerIv); state.recording = false; state.hearingMic = false; state.voiceQueued = ""; sttQ.me = []; sttQ.them = []; stopScreenWatch();
  state.pendingTr = []; clearTimeout(state.trTimer); state.trTimer = null;
  if (discard) deltaHandlers.clear();
  shotDrop(); hideQuestion();
  if (api.setHotkeysActive) api.setHotkeysActive(false);
}

function pauseListen() {
  if (!state.recording) return;
  stopCapture(false);
  state.paused = true;
  state.discard = false;
  setPhase("Pausado");
  if (api.pauseMeeting && state.session) api.pauseMeeting(state.session.id).catch(() => {});
}

function stopSession(discard = true) {
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
  stopSession(false);
  state.ended = true;
  setPhase("Encerrada");
  $("btnEnd").classList.add("hidden");
  if (state.lines.length) await runAI("Encerrar", (rid) => api.wrapup(linesForAI(), rid, durationMs));
  else await runAI("Encerrar", (rid) => api.wrapup(linesForAI(), rid, durationMs));
}

function applyTheme(t) { document.documentElement.setAttribute("data-mtheme", t === "light" ? "light" : "dark"); }
function fillMenu() {
  $("mOpacity").value = Number(state.settings.opacity) || 1;
  $("mMic").checked = state.session ? state.session.captureMic !== false : !!state.settings.captureMic;
}

function bind() {
  $("btnStart").onclick = toggleStart;
  $("btnEnd").onclick = endMeeting;
  $("btnLogo").onclick = () => openCard(!state.cardOpen);
  $("btnHide").onclick = () => { stopSession(); api.hide(); };
  $("btnMenu").onclick = (e) => { e.stopPropagation(); fillMenu(); $("menu").classList.toggle("hidden"); };
  document.addEventListener("click", (e) => { if (!$("menu").contains(e.target)) $("menu").classList.add("hidden"); });
  $("mTheme").onclick = () => { const t = document.documentElement.getAttribute("data-mtheme") === "light" ? "dark" : "light"; applyTheme(t); try { localStorage.setItem("heliosMeetingTheme", t); } catch { /* ok */ } };
  $("mOpacity").onchange = async () => { state.settings = await api.setSettings({ opacity: Number($("mOpacity").value) }); };
  $("mMic").onchange = async () => { state.settings = await api.setSettings({ captureMic: $("mMic").checked }); syncVoiceHint(); };
  $("chipSay").onclick = () => assist();
  $("chipAsk").onclick = () => { openCard(true); $("askInput").focus(); };
  $("chipInsights").onclick = () => {
    if (!state.last) runAI("Ajuda", (rid) => api.insights(linesForAI(), rid));
    else showInsights();
  };
  $("chipTranscript").onclick = () => { openCard(true); showTranscript(!state.transcriptOpen); };
  $("chipShot").onclick = screenAsk;
  $("chipQ").onclick = () => assist();
  $("btnMore").onclick = () => { if (state.last && state.last.more) state.last.more(); };
  $("btnCopy").onclick = async () => { if (state.last) toast((await copyText(state.last.text)) ? "Copiado." : "Não copiei.", 1500); };
  $("btnShotSend").onclick = shotSend;
  $("btnShotCancel").onclick = shotCancel;
  $("askForm").onsubmit = (e) => { e.preventDefault(); const q = $("askInput").value; $("askInput").value = ""; if (q.trim()) ask(q.trim()); };
  api.onHotkey((n) => {
    if (n === "assist") { if (state.recording) assist(); }
    else if (n === "record") toggleStart();
    else if (n === "screen") screenAsk();
    else if (n === "clickthrough") { state.clickThrough = !state.clickThrough; $("ctBadge").classList.toggle("hidden", !state.clickThrough); }
  });
  api.onMeetingStop((info) => {
    if (info && info.stop) { if (state.recording || state.starting) stopSession(); shotDrop(); }
    if (state.clickThrough) { state.clickThrough = false; $("ctBadge").classList.add("hidden"); }
  });
  if (api.onSession) api.onSession((session) => { state.session = session; syncScreenHint(); });
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const el = document.activeElement; const typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    if (e.key === "Tab" && state.question && !typing) { e.preventDefault(); assist(); return; }
    if (e.key === "Enter" && e.ctrlKey && !e.shiftKey && state.recording) { e.preventDefault(); assist(); return; }
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
  state.session = state.settings.session || (api.activeMeeting ? await api.activeMeeting() : null);
  syncScreenHint();
  if (state.session && state.session.status === "live") start();
  fit();
})();
