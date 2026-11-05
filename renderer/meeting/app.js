'use strict';
// LEVA H: modo reunião no estilo Cluely. Pílula + card de resposta; nada aparece até você pedir.
const $ = (id) => document.getElementById(id);
const state = {
  lines: [], mode: 'pt', trCurrent: null, recording: false, starting: false, gen: 0, discard: false, shotPending: false, timing: {}, recs: [], streams: [], ctx: null, settings: {}, clickThrough: false,
  sessionId: newSessionId(), chat: [], pendingTr: [], trBusy: false, trPauseUntil: 0, trTimer: null, chunkAuto: 0, rateWaitMs: 5000, trShownId: 0, translating: false, rid: 0, startedAt: 0, timerIv: null,
  input: 'ask', view: '', last: null, question: '', capTimer: null, cardOpen: false, transcriptOpen: false,
  voiceScreen: true, voiceBusy: false, voiceQueued: '', hearingMic: false,
};
function newSessionId() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- janela / card ----------
const fit = () => api.setHeight(Math.ceil($('root').getBoundingClientRect().height) + 4);
new ResizeObserver(fit).observe($('root'));
function openCard(on = true) { state.cardOpen = on; $('card').classList.toggle('hidden', !on); }
// Uma área de resultado por vez: resposta, tradução, código, histórico ou transcrição
function showView(view) {
  state.view = view; openCard(true);
  for (const [v, id] of [['answer', 'answer'], ['tr', 'trOut'], ['code', 'codeOut'], ['history', 'history']]) $(id).classList.toggle('hidden', v !== view);
  $('chipHist').classList.toggle('on', view === 'history');
}
function toggleTranscript(force) {
  state.transcriptOpen = typeof force === 'boolean' ? force : !state.transcriptOpen;
  openCard(true);
  $('transcript').classList.toggle('hidden', !state.transcriptOpen);
  $('chipTranscript').classList.toggle('on', state.transcriptOpen);
  if (state.transcriptOpen) { const b = $('transcript'); b.scrollTop = b.scrollHeight; }
}
function toast(msg, ms = 3500) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  $('root').appendChild(t); setTimeout(() => t.remove(), ms);
}
// Sem linha de status: o estado vira só a cor do ponto (o texto fica no título, para leitor de tela)
const setStatus = (t) => { $('btnStart').title = t; $('dot').classList.toggle('err', /erro/.test(t)); };
function setTiming(part) { Object.assign(state.timing, part); }
// Avisos repetidos (erro a cada bloco de áudio) aparecem no máximo 1 vez a cada 30 s
const lastToast = new Map();
function toastOnce(msg, ms = 5000) { const now = Date.now(); if (now - (lastToast.get(msg) || 0) < 30000) return; lastToast.set(msg, now); toast(msg, ms); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Blocos de áudio em segundos: o automático (depois de um 429 da Groq) vale só nesta sessão
const chunkSecs = () => state.chunkAuto || Number(state.settings.chunkSeconds) || 9;
// Limite da Groq: recua sozinho para blocos de 9 s (menos chamadas por minuto) e avisa em português
function onRateLimit(where) {
  if (chunkSecs() < 9) {
    state.chunkAuto = 9; setTiming({ cap: 9 });
    toastOnce(`Limite da Groq (${where}). Aumentei o bloco de áudio para 9 s automaticamente.`, 6000);
  } else toastOnce(`Limite da Groq (${where}). Continuo em alguns segundos.`, 6000);
}
// Respostas em streaming (rid -> função que recebe o texto parcial)
const deltaHandlers = new Map();
const streams = deltaHandlers;
api.onDelta((rid, text) => { const h = deltaHandlers.get(rid); if (h) h(text); });
function mediaMessage(e, label) {
  const n = (e && e.name) || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') return `${label}: o Windows ou o app negou a permissão.`;
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return `${label}: nenhum dispositivo encontrado.`;
  if (n === 'NotReadableError' || n === 'AbortError') return `${label}: em uso por outro app.`;
  if (n === 'NoAudio') return `${label}: sem áudio do sistema.`;
  return `${label}: ${(e && e.message) || 'falhou'}.`;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* sem foco: plano B */ }
  try { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch { return false; }
}
async function copyToast(text, what) { toast((await copyText(text)) ? `${what} copiado.` : 'Não copiei.', 1500); }

// ---------- transcrição (escondida por padrão) ----------
const WHO = { me: 'Você', them: 'Outro' };
function renderLine(l) {
  const box = $('transcript');
  let el = box.querySelector(`[data-id="${l.id}"]`);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (!el) { el = document.createElement('div'); el.dataset.id = l.id; el.onclick = () => el.classList.toggle('open'); box.appendChild(el); }
  // Modo EN: só a tradução do Outro aparece; o original abre ao clicar na linha
  const hide = state.mode === 'en' && l.who === 'them' && l.lang !== 'pt';
  el.className = `line ${l.who || ''}${hide ? '' : ' plain'}${el.classList.contains('open') ? ' open' : ''}`;
  const tag = `<span class="who">${WHO[l.who] || ''}</span>`;
  const pt = l.pt || l.live || (hide ? (l.trFailed ? '…' : state.settings.translate ? 'traduzindo…' : '…') : '');
  el.innerHTML = `${tag}<span class="pt">${esc(pt)}</span><span class="orig">${esc(l.text)}</span>`;
  if (atBottom) box.scrollTop = box.scrollHeight;
  const last = state.lines[state.lines.length - 1];
  if (last && last.id === l.id) renderCaption(l);
}
// Legenda ao vivo (só EN): uma linha fina com o PT da última fala do Outro; some depois de 8 s
function renderCaption(l) {
  const el = $('caption');
  if (!l || state.mode !== 'en' || l.who !== 'them' || l.lang === 'pt' || !(l.pt || l.live)) return;
  el.querySelector('.cap-pt').textContent = l.pt || l.live;
  el.classList.remove('hidden');
  clearTimeout(state.capTimer); state.capTimer = setTimeout(() => el.classList.add('hidden'), 8000);
}

// ---------- card de resposta ----------
function parseAnswer(text) {
  const rows = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const en = rows.find((r) => /^EN:/i.test(r)); const pt = rows.find((r) => /^PT:/i.test(r));
  if (en) return { main: en.replace(/^EN:\s*/i, ''), sub: pt ? pt.replace(/^PT:\s*/i, '') : '', bullets: [] };
  const clean = rows.map((r) => r.replace(/^(PT:|OPÇÃO \d.*$)\s*/i, '')).filter(Boolean);
  const [main = '', ...rest] = clean;
  return { main, sub: '', bullets: rest.map((r) => r.replace(/^[-+•*]\s*|^\d+[.)]\s*/, '')).filter(Boolean).slice(0, 3) };
}
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<)\]]+)/g, '<a class="lnk" data-link="$1">$1</a>');
function paintAnswer(text, streaming = false) {
  const a = parseAnswer(text);
  $('ansMain').innerHTML = linkify(a.main || (streaming ? '…' : ''));
  $('ansMain').classList.toggle('wait', streaming && !a.main);
  $('ansSub').textContent = a.sub;
  $('ansList').innerHTML = a.bullets.map((b) => `<li>${linkify(b)}</li>`).join('');
  $('answer').querySelectorAll('[data-link]').forEach((k) => { k.onclick = async () => { const o = await api.openLink(k.dataset.link); if (!o.ok) toast(o.error || 'Não abri o link.'); }; });
}
function setAnswer(text, { title = '', more = null } = {}) {
  showView('answer');
  state.last = { title, text, more };
  paintAnswer(text);
  $('btnMore').classList.toggle('hidden', !more);
}
async function runAI(title, fn, { more = null, record = true } = {}) {
  showView('answer'); $('btnMore').classList.add('hidden');
  paintAnswer('', true);
  const rid = ++state.rid;
  deltaHandlers.set(rid, (t) => paintAnswer(t, true));
  const t0 = performance.now();
  const r = await fn(rid);
  setTiming({ ai: (performance.now() - t0) / 1000 });
  deltaHandlers.delete(rid);
  if (r.cancelled) return r;
  const text = r.ok ? (r.text || '—') : r.error;
  setAnswer(text, { title, more: r.ok ? more : null });
  if (!r.ok) { setStatus('erro'); if (r.rate) onRateLimit('resposta'); }
  if (r.ok && record) { state.chat.push({ role: 'bot', title, text, at: new Date().toLocaleTimeString('pt-BR') }); renderHistory(); saveHistory(); }
  return r;
}
function renderHistory() {
  const box = $('history'); box.innerHTML = '';
  state.chat.slice().reverse().slice(0, 12).forEach((m) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = `${m.at} · ${parseAnswer(m.text).main}`;
    b.onclick = () => setAnswer(m.text, { title: m.title }); box.appendChild(b);
  });
}

const linesForAI = () => state.lines.map(({ who, text }) => ({ who, text }));
const chatContext = () => state.chat.filter((m) => m.text).slice(-3).map((m) => `${m.title}: ${m.text.slice(0, 300)}`).join('\n');

// O que digo (PT) / Sugestão (EN): 1 resposta curta; "Mais" gera a versão elaborada
function assist(more = false) {
  const lang = state.mode === 'en' ? 'en' : 'pt';
  hideQuestion();
  return runAI(lang === 'en' ? 'Sugestão' : 'O que digo', (rid) => api.suggest(linesForAI(), lang, rid, more), { more: more ? null : () => assist(true) });
}

// ---------- campo único: Perguntar (PT) · Dizer em EN (EN) · Livecoding ----------
const INPUTS = { ask: ['', 'Pergunte…'], say: ['EN', 'Dizer em inglês…'], code: ['</>', 'Código…'] };
function setInput(kind, focus = false) {
  state.input = INPUTS[kind] ? kind : 'ask';
  const [tag, ph] = INPUTS[state.input];
  $('askTag').textContent = tag; $('askInput').placeholder = ph;
  $('chipLive').classList.toggle('on', state.input === 'code');
  $('chipSayEn').classList.toggle('on', state.input === 'say');
  if (focus) { openCard(true); api.focus(); setTimeout(() => $('askInput').focus(), 40); }
}
const defaultInput = () => (state.mode === 'en' ? 'say' : 'ask');
function submitInput(q) {
  const t = String(q || '').trim(); if (!t) return;
  if (state.input === 'code') return liveCode(t);
  if (state.input === 'say' && state.mode === 'en') return translatePhrase(t);
  return ask(t);
}
function builtQuestion(q) {
  const ctx = chatContext();
  const question = ctx ? `${q}\n\n(Respostas anteriores, para contexto:\n${ctx})` : q;
  const only = state.mode === 'pt' ? '\n\n(Responda somente em português, sem frases em inglês.)' : '';
  return `${question}${only}`;
}
function ask(q) {
  return runAI('Perguntar', (rid) => api.ask(linesForAI(), builtQuestion(q), false, rid));
}

// Pergunta por voz: o microfone fecha o bloco na pausa (~0,8 s) e, se for pergunta, responde na pílula.
// A tela entra sem prévia só com o toggle ligado e a escuta ativa. O áudio não vai para o disco.
// Os gravadores (PC e microfone) não param por causa da resposta.
function loadVoiceScreen() {
  try {
    const saved = localStorage.getItem('heliosMeetingVoiceScreen');
    state.voiceScreen = saved === null ? true : saved === '1';
  } catch { state.voiceScreen = true; }
  const box = $('mVoiceScreen');
  if (box) box.checked = state.voiceScreen;
}
function syncVoiceHint() {
  const el = $('voiceHint');
  if (!state.recording) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  if (!state.hearingMic) {
    el.textContent = 'Para perguntar por voz, ligue o microfone no menu e comece a ouvir de novo.';
    return;
  }
  el.textContent = state.voiceScreen
    ? 'Pergunta no microfone: a resposta aparece aqui, com a tela, sem digitar. A escuta continua.'
    : 'Pergunta no microfone: a resposta aparece aqui, sem enviar a tela. A escuta continua.';
}
function saveVoiceScreen(on) {
  state.voiceScreen = !!on;
  try { localStorage.setItem('heliosMeetingVoiceScreen', state.voiceScreen ? '1' : '0'); } catch { /* sem armazenamento */ }
  syncVoiceHint();
}
function maybeVoiceAsk(text) {
  if (!state.recording || state.discard || !state.hearingMic) return;
  if (!LineUtil.isVoiceQuestion(text)) return;
  if (state.voiceBusy) { state.voiceQueued = text; return; }
  runVoiceAsk(text);
}
async function runVoiceAsk(text) {
  state.voiceBusy = true;
  const withScreen = !!state.voiceScreen;
  setStatus('respondendo à pergunta por voz…');
  try {
    const r = await runAI('Pergunta por voz', (rid) => api.ask(linesForAI(), builtQuestion(text), withScreen, rid, withScreen ? 'voice' : undefined));
    if (r && r.warn) toastOnce(r.warn, 6000);
  } finally {
    state.voiceBusy = false;
    if (state.recording) setStatus('ouvindo');
    const next = state.voiceQueued;
    state.voiceQueued = '';
    if (next && state.recording && !state.discard) maybeVoiceAsk(next);
  }
}

// Tradutor PT→EN (modo EN): o inglês sai grande para ler em voz alta, o PT pequeno embaixo
function showTranslation(item) {
  state.trCurrent = item; showView('tr');
  $('trEn').textContent = item.en; $('trPt').textContent = item.pt || '';
}
async function translatePhrase(text) {
  const t = String(text || '').trim(); if (!t) return;
  showView('tr'); $('trEn').textContent = '…'; $('trPt').textContent = '';
  const t0 = performance.now();
  const rid = ++state.rid;
  deltaHandlers.set(rid, (text) => { const part = (text.match(/^EN:\s*(.*)$/m) || [])[1]; if (part) $('trEn').textContent = part; });
  const r = await api.sayEn(t, rid);
  deltaHandlers.delete(rid);
  setTiming({ ai: (performance.now() - t0) / 1000 });
  if (r.cancelled) return;
  if (!r.ok) { $('trEn').textContent = ''; $('trPt').textContent = r.error; return; }
  const en = ((r.text || '').match(/^EN:\s*(.*)$/m) || [])[1] || (r.text || '').trim();
  const pt = ((r.text || '').match(/^PT:\s*(.*)$/m) || [])[1] || '';
  const item = { src: t, en, pt };
  state.chat.push({ role: 'bot', title: 'Dizer em EN', text: `EN: ${en}\nPT: ${pt}`, at: new Date().toLocaleTimeString('pt-BR') }); renderHistory();
  showTranslation(item);
}

// ---------- Livecoding: só o código, curto e direto ----------
let live = null;
async function liveCode(request) {
  live = null; $('liveNav').classList.add('hidden');
  showView('code'); $('codeText').textContent = '…';
  const rid = ++state.rid;
  deltaHandlers.set(rid, (t) => { $('codeText').textContent = t.replace(/^\s*```[\w-]*\s*\n?/, ''); });
  const r = await api.code(linesForAI(), request, rid);
  deltaHandlers.delete(rid);
  if (r.cancelled) return;
  $('codeText').textContent = r.ok ? (r.text || '') : r.error;
  if (r.ok) { state.chat.push({ role: 'bot', title: 'Livecoding', text: r.text, at: new Date().toLocaleTimeString('pt-BR') }); renderHistory(); saveHistory(); }
}
// Roteiro de livecoding aberto pelo chat do HELIOS: mostra só o bloco de código atual, com ‹ ›
function renderLive() {
  if (!live) return;
  showView('code');
  const total = live.total || 1; const cursor = Number(live.cursor) || 0;
  const atual = live.atual;
  $('codeText').textContent = atual && atual.codigo ? `${atual.arquivo ? `// ${atual.arquivo}\n` : ''}${atual.codigo}` : (live.arquivos || []).map((f) => `// ${f.path}`).join('\n') || live.title || '';
  $('liveNav').classList.remove('hidden');
  $('liveCount').textContent = `${Math.min(total, cursor + 1)}/${total}`;
  $('btnPrev').disabled = cursor <= 0;
  $('btnNext').disabled = live.status === 'done' || cursor >= total - 1;
}
async function stepLive(dir) {
  if (!live) return;
  const r = dir > 0 ? await api.liveNext(live.id) : await api.livePrev(live.id);
  if (!r.ok) { toast(r.error || 'Não andei o roteiro.'); return; }
  live = r.session; renderLive();
}

// Alterna PT/EN (lembra a última escolha). PT não tem nada em inglês.
function setMode(mode, persist = true) {
  state.mode = mode === 'en' ? 'en' : 'pt';
  $('root').classList.toggle('mode-en', state.mode === 'en'); $('root').classList.toggle('mode-pt', state.mode === 'pt');
  $('modePt').classList.toggle('active', state.mode === 'pt'); $('modeEn').classList.toggle('active', state.mode === 'en');
  if (persist) { try { localStorage.setItem('heliosMeetingMode', state.mode); } catch { /* sem armazenamento */ } }
  if (state.mode === 'pt') { $('caption').classList.add('hidden'); if (state.view === 'tr') showView(''); }
  if (state.input !== 'code') setInput(defaultInput());
  state.lines.forEach(renderLine);
}
// Falas anteriores (só texto original) que acompanham a tradução; a quantidade vem dos Ajustes
function historyBefore(id) {
  const n = Number(state.settings.translateHistory ?? 3);
  return n > 0 ? state.lines.filter((l) => l.id < id && l.text).slice(-n).map((l) => l.text) : [];
}

// ---------- pergunta detectada (chip dinâmico, Tab responde) ----------
async function detectQuestion(line) {
  if (!api.detect || line.who !== 'them') return;
  const r = await api.detect(line.text);
  if (!r || !r.ok || !r.question || state.discard) return;
  state.question = r.question;
  $('chipQText').textContent = r.question; $('chipQ').classList.remove('hidden'); openCard(true);
}
function hideQuestion() { state.question = ''; $('chipQ').classList.add('hidden'); }

// Print da tela: miniatura com ✓ e ✕; nada é enviado antes do ✓
async function screenAsk() {
  const r = await api.screenPreview();
  if (!r.ok) { toast(r.error || 'Não capturei a tela.', 5000); return; }
  openCard(true);
  state.shotPending = true; $('shotImg').src = r.preview; $('shotBox').classList.remove('hidden');
}
function shotHide() { state.shotPending = false; $('shotBox').classList.add('hidden'); $('shotImg').removeAttribute('src'); }
function shotCancel() { shotHide(); api.screenCancel(); }
function shotDrop() { if (state.shotPending) { shotHide(); api.screenCancel(); } }
async function shotSend() { shotHide(); await runAI('Tela', (rid) => api.ask(linesForAI(), 'Analise minha tela junto com a conversa e diga, em português, o que eu devo fazer ou dizer agora.', true, rid)); }

// Modo EN: só a tradução em português do que o Outro disse por último (3 falas); o original não aparece
async function translateRecent() {
  const them = state.lines.filter((l) => l.who === 'them' && l.lang !== 'pt').slice(-3);
  if (!them.length) { toast('Ainda não ouvi o Outro.', 2000); return; }
  showView('answer'); paintAnswer('', true); $('btnMore').classList.add('hidden');
  let err = '';
  try {
    // não traduz de novo o que já está a caminho (legenda ao vivo): espera o lote em andamento terminar
    const deadline = Date.now() + 8000;
    while (them.some((l) => l.trq && !l.pt) && Date.now() < deadline && !state.discard) await sleep(150);
    const missing = them.filter((l) => !l.pt);
    if (missing.length) {
      const t0 = performance.now();
      const r = await api.translateBatch(missing.map((l) => ({ id: l.id, text: l.text })), historyBefore(missing[0].id));
      setTiming({ tr: (performance.now() - t0) / 1000 });
      if (r.ok) { for (const it of r.items) { const l = state.lines.find((x) => x.id === it.id); if (l && it.pt) { l.pt = it.pt; renderLine(l); } } } else err = r.error || 'falha na tradução';
    }
  } catch (e) { err = (e && e.message) || 'falha na tradução'; }
  const pts = them.map((l) => l.pt).filter(Boolean);
  setAnswer(err || (pts.length ? [pts[pts.length - 1], ...pts.slice(0, -1).map((p) => `- ${p}`)].join('\n') : 'Não traduzi esse trecho.'), { title: 'Traduzir' });
  state.trShownId = LineUtil.shownCursor(state.lines, state.trShownId);
  saveHistory();
}

// ---------- histórico ----------
let saveTimer = null;
function saveHistory() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!state.lines.length && !state.chat.length) return;
    const md = `# Reunião ${state.sessionId}\n\n## Transcrição\n\n` +
      state.lines.map((l) => `- ${l.who === 'me' ? '**Você:** ' : l.who === 'them' ? '**Outro:** ' : ''}${l.text}${l.pt ? `\n  > ${l.pt}` : ''}`).join('\n') +
      (state.chat.length ? '\n\n## Respostas\n\n' + state.chat.map((m) => `**${m.title} (${m.at}):**\n\n${m.text}`).join('\n\n') : '') + '\n';
    api.saveHistory(state.sessionId, md);
  }, 1500);
}
async function refreshRate() { /* a cota fica no app principal; aqui só o ponto colorido */ }

// ---------- captura: som do PC (Outro) e microfone (Você) em dois gravadores separados ----------
const MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
let seq = 0;
function makeRecorder(stream, ctx, analyserSrc, who) {
  const an = ctx.createAnalyser(); an.fftSize = 1024; analyserSrc.connect(an);
  const buf = new Float32Array(an.fftSize);
  const rec = { stopped: false, voiced: 0, silent: 0, startAt: 0, mr: null, timer: null };
  rec.meter = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    if (Math.sqrt(sum / buf.length) > 0.01) { rec.voiced++; rec.silent = 0; } else rec.silent++;
    // Áudio do PC: pausa depois de metade do bloco. Microfone: pausa curta, para a pergunta por voz não esperar o bloco inteiro.
    const elapsedMs = Date.now() - rec.startAt;
    const cut = who === 'me'
      ? LineUtil.shouldCutVoice({ elapsedMs, voiced: rec.voiced, silentTicks: rec.silent })
      : LineUtil.shouldCut({ elapsedMs, maxMs: chunkSecs() * 1000, voiced: rec.voiced, silentTicks: rec.silent });
    if (rec.mr && rec.mr.state === 'recording' && cut) rec.mr.stop();
  }, 100);
  const cycle = () => {
    if (rec.stopped) return;
    const chunks = [];
    const mr = new MediaRecorder(stream, MIME ? { mimeType: MIME, audioBitsPerSecond: 32000 } : undefined);
    clearTimeout(rec.timer); rec.mr = mr; rec.voiced = 0; rec.silent = 0; rec.startAt = Date.now();
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      const voiced = rec.voiced;
      if (!rec.stopped) cycle();
      if (voiced < 5 || !chunks.length) return; // silêncio: não gasta cota
      handleChunk(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }), who);
    };
    mr.start();
    rec.timer = setTimeout(() => { if (mr.state !== 'inactive') mr.stop(); }, chunkSecs() * 1000);
  };
  cycle();
  rec.stop = () => { rec.stopped = true; clearTimeout(rec.timer); clearInterval(rec.meter); if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop(); };
  return rec;
}

async function handleChunk(blob, who = 'them', retried = false, forcedId = 0) {
  if (state.discard) return; // janela fechada: nada que ainda estava a caminho vai para a nuvem
  const id = forcedId || ++seq;
  const t0 = performance.now();
  const r = await api.transcribe(await blob.arrayBuffer(), blob.type, who, state.mode);
  setTiming({ stt: (performance.now() - t0) / 1000 });
  refreshRate();
  if (state.discard || r.cancelled) return;
  if (!r.ok && r.rate) {
    onRateLimit('transcrição');
    if (!retried) { setStatus('limite da Groq: tentando de novo…'); await sleep(state.rateWaitMs); return handleChunk(blob, who, true, id); } // mesmo bloco, mesma posição na transcrição
  }
  if (!r.ok) { setStatus('erro na transcrição'); toastOnce(`Transcrição (${who === 'me' ? 'microfone' : 'áudio do PC'}): ${r.error}`); return; }
  if (state.recording) setStatus(state.listenText || 'ouvindo…');
  if (!r.text || r.skipped || LineUtil.isNoise(r.text)) return; // vazio, só pontuação ou legenda inventada no silêncio
  const recent = state.lines.filter((l) => l.id < id).slice(-8).map((l) => l.text);
  if (LineUtil.isDuplicate(recent, r.text)) {
    if (who === 'me') maybeVoiceAsk(r.text); // a mesma pergunta de novo ainda responde; a linha não duplica
    return;
  }
  const line = { id, who, text: r.text, lang: r.language || '', pt: '' };
  state.lines.push(line); state.lines.sort((a, b) => a.id - b.id);
  renderLine(line); saveHistory();
  if (who === 'me') maybeVoiceAsk(line.text);
  if (who === 'them') detectQuestion(line);
  if (state.mode === 'en' && state.settings.translate && who !== 'me' && line.lang !== 'pt') { line.trq = true; state.pendingTr.push(line); pumpTranslate(); }
}

async function pumpTranslate() {
  if (state.trBusy || !state.pendingTr.length) return;
  const wait = state.trPauseUntil - Date.now();
  if (wait > 0) { if (!state.trTimer) state.trTimer = setTimeout(() => { state.trTimer = null; pumpTranslate(); }, wait + 50); return; } // recuo depois de 429
  state.trBusy = true;
  const taken = state.pendingTr.splice(0, 3); // lotes pequenos: a legenda aparece mais cedo
  taken.filter((l) => l.pt).forEach((l) => { l.trq = false; }); // já traduzida: não traduz de novo
  const batch = taken.filter((l) => !l.pt);
  if (batch.length) {
    batch.forEach((l) => { l.tries = (l.tries || 0) + 1; });
    const rid = batch.length === 1 ? ++state.rid : 0; // uma fala só: a tradução aparece palavra a palavra
    if (rid) deltaHandlers.set(rid, (text) => { const part = text.replace(/^\s*\d+\s*[|.)-]\s*/, '').trim(); if (part && !batch[0].pt) { batch[0].live = part; renderLine(batch[0]); } });
    const t0 = performance.now();
    const r = await api.translateBatch(batch.map((l) => ({ id: l.id, text: l.text })), historyBefore(batch[0].id), rid);
    if (rid) deltaHandlers.delete(rid);
    batch.forEach((l) => { l.live = ''; });
    if (state.discard || r.cancelled) { batch.forEach((l) => { l.trq = false; }); state.trBusy = false; return; }
    setTiming({ tr: (performance.now() - t0) / 1000 });
    if (r.ok) {
      for (const it of r.items) { const l = state.lines.find((x) => x.id === it.id); if (l && it.pt && it.pt.trim() !== l.text.trim()) { l.pt = it.pt; renderLine(l); } }
      batch.forEach((l) => { l.trq = false; if (!l.pt) { l.trFailed = true; renderLine(l); } });
      state.trShownId = LineUtil.shownCursor(state.lines, state.trShownId);
    } else if (r.rate) {
      // limite da Groq: espera alguns segundos e tenta o mesmo lote de novo (no máximo 3 vezes por fala)
      state.trPauseUntil = Date.now() + 8000;
      toastOnce('Limite da Groq na tradução. Espero alguns segundos e continuo (as falas já estão na transcrição).', 9000);
      const again = batch.filter((l) => l.tries < 3);
      batch.filter((l) => l.tries >= 3).forEach((l) => { l.trq = false; l.trFailed = true; renderLine(l); });
      state.pendingTr.unshift(...again);
    } else { batch.forEach((l) => { l.trq = false; l.trFailed = true; renderLine(l); }); toastOnce(`Tradução: ${r.error}`); }
    saveHistory();
  }
  state.trBusy = false;
  if (state.pendingTr.length) pumpTranslate();
}

function tick() { const s = Math.floor((Date.now() - state.startedAt) / 1000); $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }

async function start() {
  if (state.starting || state.recording) return;
  state.settings = await api.getSettings();
  if (!state.settings.hasGroqKey && !state.settings.hasGeminiKey) { toast('Falta a chave da Groq: Ajustes › Reunião, ou peça ao HELIOS.', 6000); setStatus('erro: sem chave'); return; }
  state.starting = true; state.discard = false; state.chunkAuto = 0;
  if (typeof api.warm === 'function') api.warm().catch(() => {}); // aquece a conexão com a Groq enquanto o áudio abre
  const gen = state.gen; const alive = () => state.gen === gen;
  setStatus('abrindo o áudio…');
  const ctx = new AudioContext();
  const sources = []; const problems = []; const opened = [];
  const giveUp = () => { opened.forEach((s) => s.getTracks().forEach((t) => t.stop())); ctx.close(); };
  try {
    try {
      const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      opened.push(sys); sys.getVideoTracks().forEach((t) => t.stop());
      if (!sys.getAudioTracks().length) throw Object.assign(new Error('sem trilha de áudio'), { name: 'NoAudio' });
      sources.push({ who: 'them', stream: new MediaStream(sys.getAudioTracks()) });
    } catch (e) { problems.push(mediaMessage(e, 'Áudio do PC')); }
    if (!alive()) { giveUp(); return; }
    if (state.settings.captureMic) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        opened.push(mic); sources.push({ who: 'me', stream: mic });
      } catch (e) { problems.push(mediaMessage(e, 'Microfone')); }
      if (!alive()) { giveUp(); return; }
    }
    if (!sources.length) { giveUp(); setStatus('parado'); toast(`Não consegui ouvir nada. ${problems.join(' ')} Tente de novo ou use o microfone com o alto-falante ligado.`, 9000); return; }
    const hasThem = sources.some((s) => s.who === 'them');
    if (problems.length) toast(`${problems.join(' ')} Sigo só com ${hasThem ? 'o áudio do PC' : 'o microfone'}.`, 7000);
    state.streams = opened; state.ctx = ctx;
    state.recs = sources.map((s) => makeRecorder(s.stream, ctx, ctx.createMediaStreamSource(s.stream), s.who));
    state.hearingMic = sources.some((s) => s.who === 'me');
    state.recording = true; setTiming({ cap: chunkSecs() });
    state.startedAt = Date.now(); tick(); state.timerIv = setInterval(tick, 1000);
    $('btnStart').classList.add('on'); $('dot').classList.add('live'); $('btnEnd').classList.remove('hidden');
    setStatus('ouvindo'); openCard(true); syncVoiceHint();
    if (api.setHotkeysActive) api.setHotkeysActive(true); // Ctrl+Enter só durante a reunião
  } catch (e) {
    giveUp(); setStatus('parado'); toast(`Não consegui iniciar: ${(e && e.message) || e}`, 7000);
  } finally { state.starting = false; }
}
// Por padrão descarta o que ainda estava a caminho (fechar a janela não manda mais nada para a nuvem); "Parar" mantém o último trecho.
function stopSession(discard = true) {
  state.gen += 1; state.discard = discard;
  state.recs.forEach((r) => r.stop()); state.recs = [];
  state.streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); state.streams = [];
  if (state.ctx) { state.ctx.close(); state.ctx = null; }
  clearInterval(state.timerIv); state.recording = false; state.hearingMic = false; state.voiceQueued = '';
  state.pendingTr.forEach((l) => { l.trq = false; }); state.pendingTr = []; clearTimeout(state.trTimer); state.trTimer = null; state.trPauseUntil = 0;
  if (discard) { deltaHandlers.clear(); streams.clear(); }
  shotDrop(); hideQuestion();
  if (api.setHotkeysActive) api.setHotkeysActive(false);
  $('btnStart').classList.remove('on'); $('dot').classList.remove('live'); $('btnEnd').classList.add('hidden');
  setStatus('parado'); syncVoiceHint(); saveHistory();
}
const toggleStart = () => (state.recording || state.starting ? stopSession(false) : start());
// Encerrar: para, roda o fechamento (resumo + pendências salvos no Second Brain) e já começa uma reunião nova
async function endMeeting() {
  stopSession(false);
  if (state.lines.length) await runAI('Encerrar', (rid) => api.wrapup(linesForAI(), rid), { record: false });
  saveHistory();
  state.lines = []; state.chat = []; state.trShownId = 0; state.sessionId = newSessionId();
  $('transcript').innerHTML = ''; renderHistory(); $('caption').classList.add('hidden');
}

// ---------- menu: tema, opacidade, microfone e tela na pergunta por voz ----------
function applyTheme(t) { document.documentElement.setAttribute('data-mtheme', t === 'light' ? 'light' : 'dark'); }
function fillMenu() {
  $('mOpacity').value = Number(state.settings.opacity) || 1;
  $('mMic').checked = !!state.settings.captureMic;
  $('mVoiceScreen').checked = state.voiceScreen !== false;
}

function bind() {
  $('btnStart').onclick = toggleStart;
  $('btnEnd').onclick = endMeeting;
  $('btnLogo').onclick = () => openCard(!state.cardOpen);
  $('btnHide').onclick = () => { stopSession(); api.hide(); };
  $('btnMenu').onclick = (e) => { e.stopPropagation(); fillMenu(); $('menu').classList.toggle('hidden'); };
  document.addEventListener('click', (e) => { if (!$('menu').contains(e.target)) $('menu').classList.add('hidden'); });
  $('mTheme').onclick = () => { const t = document.documentElement.getAttribute('data-mtheme') === 'light' ? 'dark' : 'light'; applyTheme(t); try { localStorage.setItem('heliosMeetingTheme', t); } catch { /* ok */ } };
  $('mOpacity').onchange = async () => { state.settings = await api.setSettings({ opacity: Number($('mOpacity').value) }); };
  $('mMic').onchange = async () => { state.settings = await api.setSettings({ captureMic: $('mMic').checked }); syncVoiceHint(); };
  $('mVoiceScreen').onchange = () => saveVoiceScreen($('mVoiceScreen').checked);
  $('modePt').onclick = () => setMode('pt'); $('modeEn').onclick = () => setMode('en');
  $('chipSay').onclick = () => assist();
  $('chipSug').onclick = () => assist();
  $('chipAsk').onclick = () => setInput('ask', true);
  $('chipTr').onclick = translateRecent;
  $('chipSayEn').onclick = () => setInput('say', true);
  $('chipLive').onclick = () => setInput(state.input === 'code' ? defaultInput() : 'code', true);
  $('chipShot').onclick = screenAsk;
  $('chipTranscript').onclick = () => toggleTranscript();
  $('chipHist').onclick = () => (state.view === 'history' ? showView(state.last ? 'answer' : '') : (renderHistory(), showView('history')));
  $('chipQ').onclick = () => assist();
  $('btnMore').onclick = () => { if (state.last && state.last.more) state.last.more(); };
  $('btnCopy').onclick = () => { if (state.last) { const a = parseAnswer(state.last.text); copyToast([a.main, ...a.bullets].join('\n'), 'Texto'); } };
  $('trEn').onclick = () => { if (state.trCurrent) copyToast(state.trCurrent.en, 'Inglês'); };
  $('btnCodeCopy').onclick = () => copyToast($('codeText').textContent, 'Código');
  $('btnPrev').onclick = () => stepLive(-1); $('btnNext').onclick = () => stepLive(1);
  api.onLiveSession((session) => { live = session; renderLive(); });
  $('btnShotSend').onclick = shotSend;
  $('btnShotCancel').onclick = shotCancel;
  $('askForm').onsubmit = (e) => { e.preventDefault(); const q = $('askInput').value; $('askInput').value = ''; submitInput(q); };
  api.onHotkey((n) => {
    if (n === 'assist') { if (state.recording) assist(); }
    else if (n === 'translate') { if (state.mode === 'en') translateRecent(); }
    else if (n === 'record') toggleStart();
    else if (n === 'say') setInput(state.mode === 'en' ? 'say' : 'ask', true);
    else if (n === 'live') setInput('code', true);
    else if (n === 'mode') setMode(state.mode === 'en' ? 'pt' : 'en');
    else if (n === 'screen') screenAsk();
    else if (n === 'clickthrough') { state.clickThrough = !state.clickThrough; $('ctBadge').classList.toggle('hidden', !state.clickThrough); }
  });
  // O main avisa quando a janela fecha por fora do botão (Esc, Alt+F4, atalho): para a captura e desliga o modo atravessar.
  api.onMeetingStop((info) => {
    if (info && info.stop) { if (state.recording || state.starting) stopSession(); shotDrop(); }
    if (state.clickThrough) { state.clickThrough = false; $('ctBadge').classList.add('hidden'); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const el = document.activeElement; const typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    // Tab (com foco na janela, fora do campo) responde à pergunta detectada
    if (e.key === 'Tab' && state.question && !typing) { e.preventDefault(); assist(); return; }
    // Ctrl+Enter dentro da janela também pede a resposta, mas só com a reunião ativa
    if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey && state.recording) { e.preventDefault(); assist(); return; }
    if (e.key !== 'Escape') return;
    if (state.shotPending) { shotCancel(); return; }
    if (!$('menu').classList.contains('hidden')) { $('menu').classList.add('hidden'); return; }
    if (state.recording) return;
    if (typing && el.value) { el.blur(); return; }
    api.hide();
  });
  api.onHotkeysFailed((l) => toast(`Atalho em uso por outro app: ${l.join(', ')}`, 6000));
  window.addEventListener('beforeunload', () => saveHistory());
}

// Autoteste (CLUELY_SELFTEST=1): grava 4 s de áudio do sistema sem chamar API e reporta tamanho/pico.
async function selftest() {
  const r = { mime: MIME };
  try {
    const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    sys.getVideoTracks().forEach((t) => t.stop());
    r.audioTracks = sys.getAudioTracks().length;
    const ctx = new AudioContext(); const an = ctx.createAnalyser(); ctx.createMediaStreamSource(sys).connect(an);
    const buf = new Float32Array(an.fftSize); let peak = 0;
    const iv = setInterval(() => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; peak = Math.max(peak, Math.sqrt(s / buf.length)); }, 100);
    const mr = new MediaRecorder(new MediaStream(sys.getAudioTracks()), { mimeType: MIME }); const ch = [];
    mr.ondataavailable = (e) => ch.push(e.data);
    await new Promise((res) => { mr.onstop = res; mr.start(); setTimeout(() => mr.stop(), 4000); });
    clearInterval(iv); r.bytes = ch.reduce((n, b) => n + b.size, 0); r.peak = peak; r.ok = r.bytes > 0;
  } catch (e) { r.ok = false; r.error = String(e); }
  api.selftestResult(r);
}

(async () => {
  if (api.selftest) return selftest();
  loadVoiceScreen();
  bind();
  let savedMode = 'pt'; try { savedMode = localStorage.getItem('heliosMeetingMode') || 'pt'; } catch { /* sem armazenamento */ }
  try { applyTheme(localStorage.getItem('heliosMeetingTheme') || 'dark'); } catch { applyTheme('dark'); }
  setMode(savedMode, false);
  state.settings = await api.getSettings();
  fit();
})();
