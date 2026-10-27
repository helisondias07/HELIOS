'use strict';
const $ = (id) => document.getElementById(id);
const state = {
  lines: [], mode: 'pt', trHist: [], trCurrent: null, recording: false, starting: false, gen: 0, discard: false, shotPending: false, timing: {}, recs: [], streams: [], ctx: null, settings: {}, clickThrough: false,
  sessionId: newSessionId(), chat: [], pendingTr: [], trBusy: false, trPauseUntil: 0, trTimer: null, chunkAuto: 0, rateWaitMs: 5000, trShownId: 0, translating: false, rid: 0, tab: 'chat', startedAt: 0, timerIv: null,
};
function newSessionId() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- janela / painel ----------
const fit = () => api.setHeight(Math.ceil($('root').getBoundingClientRect().height) + 4);
new ResizeObserver(fit).observe($('root'));
function showTab(tab) {
  state.tab = tab;
  $('panel').classList.remove('hidden');
  $('main').classList.toggle('hidden', tab === 'settings');
  $('chatTab').classList.toggle('hidden', tab !== 'chat');
  $('transcriptTab').classList.toggle('hidden', tab !== 'transcript');
  $('liveTab').classList.toggle('hidden', tab !== 'live');
  $('settings').classList.toggle('hidden', tab !== 'settings');
  $('tabChat').classList.toggle('active', tab === 'chat');
  $('tabTranscript').classList.toggle('active', tab === 'transcript');
  $('tabLive').classList.toggle('active', tab === 'live');
}
function toast(msg, ms = 5000) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  $('root').appendChild(t); setTimeout(() => t.remove(), ms);
}
const setStatus = (t) => { $('status').textContent = t; };
// Tempo de cada etapa, discreto na barra de status
function setTiming(part) {
  Object.assign(state.timing, part);
  const t = state.timing; const f = (x) => `${x.toFixed(1).replace('.', ',')}s`;
  $('timing').textContent = [t.cap ? `bloco ${t.cap}s` : '', t.stt != null ? `transcrição ${f(t.stt)}` : '', t.tr != null ? `tradução ${f(t.tr)}` : '', t.ai != null ? `resposta ${f(t.ai)}` : ''].filter(Boolean).join(' · ');
}
// Avisos repetidos (erro a cada bloco de áudio) aparecem no máximo 1 vez a cada 30 s
const lastToast = new Map();
function toastOnce(msg, ms = 6000) { const now = Date.now(); if (now - (lastToast.get(msg) || 0) < 30000) return; lastToast.set(msg, now); toast(msg, ms); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Blocos de áudio em segundos: o automático (depois de um 429 da Groq) vale só nesta sessão
const chunkSecs = () => state.chunkAuto || Number(state.settings.chunkSeconds) || 9;
// Limite da Groq: recua sozinho para blocos de 9 s (menos chamadas por minuto) e avisa em português
function onRateLimit(where) {
  if (chunkSecs() < 9) {
    state.chunkAuto = 9; setTiming({ cap: 9 });
    toastOnce(`Limite da Groq atingido (${where}). Aumentei o bloco de áudio para 9 s automaticamente e vou tentar de novo.`, 9000);
  } else toastOnce(`Limite da Groq atingido (${where}). Espero alguns segundos e continuo; se repetir, confira a cota em console.groq.com.`, 9000);
}
// Respostas em streaming de tradução (rid -> função que recebe o texto parcial)
const deltaHandlers = new Map();
function mediaMessage(e, label) {
  const n = (e && e.name) || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') return `${label}: o Windows ou o app negou a permissão. Libere em Configurações do Windows > Privacidade > Microfone e tente de novo.`;
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return `${label}: nenhum dispositivo encontrado.`;
  if (n === 'NotReadableError' || n === 'AbortError') return `${label}: o dispositivo está em uso por outro app ou indisponível.`;
  if (n === 'NoAudio') return `${label}: a captura não trouxe áudio (compartilhe a tela inteira com o áudio do sistema).`;
  return `${label}: ${(e && e.message) || 'falhou'}.`;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* sem foco: plano B */ }
  try { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch { return false; }
}
async function copyToast(text, what) { toast((await copyText(text)) ? `${what} copiado.` : 'Não consegui copiar. Selecione o texto e use Ctrl+C.', 1800); }

// ---------- transcrição ----------
function renderLine(l) {
  const box = $('transcript');
  let el = box.querySelector(`[data-id="${l.id}"]`);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (!el) { box.querySelector('.empty')?.remove(); el = document.createElement('div'); el.dataset.id = l.id; box.appendChild(el); }
  // Aba em inglês: só a tradução do Outro(s) aparece; o original fica escondido (dá para mostrar)
  const hide = state.mode === 'en' && l.who === 'them' && l.lang !== 'pt';
  el.className = `line ${l.who || ''}${hide ? '' : ' plain'}`;
  const tag = WHO[l.who] ? `<span class="who">${WHO[l.who]}</span>` : '<span class="who"></span>';
  const pt = l.pt || l.live || (hide ? (l.trFailed ? 'não consegui traduzir esta fala (use "Traduzir o que a outra pessoa disse")' : state.settings.translate ? 'traduzindo…' : 'use "Traduzir o que a outra pessoa disse"') : '');
  el.innerHTML = `${tag}<span class="orig">${esc(l.text)}</span><span class="pt">${esc(pt)}</span>`;
  if (atBottom) box.scrollTop = box.scrollHeight;
  const last = state.lines[state.lines.length - 1];
  if (last && last.id === l.id) renderCaption(l);
}
const WHO = { me: 'Você', them: 'Outro(s)' };
// Legenda grande da última fala: original pequeno e tradução em destaque
function renderCaption(l) {
  const el = $('caption'); if (!l || !l.text) return;
  const en = state.mode === 'en' && l.who === 'them' && l.lang !== 'pt';
  el.classList.remove('hidden'); el.classList.toggle('plain', !en);
  el.querySelector('.cap-who').textContent = WHO[l.who] || 'Ouvindo';
  el.querySelector('.cap-orig').textContent = l.text;
  el.querySelector('.cap-pt').textContent = en ? (l.pt || l.live || 'traduzindo…') : '';
}

// ---------- chat ----------
function fmtBot(text) {
  return esc(text).replace(/(https?:\/\/[^\s<)\]]+)/g, '<a class="lnk" data-link="$1">$1</a>').replace(/^(EN:.*)$/gm, '<span class="en">$1</span>').replace(/^(PT:.*)$/gm, '<span class="ptl">$1</span>');
}
function addMsg(role, text, title = '') {
  const m = { role, text, title, prov: '', at: new Date().toLocaleTimeString('pt-BR') };
  state.chat.push(m);
  const box = $('chat'); box.querySelector('.empty')?.remove();
  m.el = document.createElement('div'); m.el.className = `msg ${role}`;
  box.appendChild(m.el); paintMsg(m);
  return m;
}
function paintMsg(m) {
  if (m.role === 'user') m.el.textContent = m.text;
  else m.el.innerHTML = `<div class="t"><span>${esc(m.title)}</span><span>${esc(m.prov)}</span><a data-copy>Copiar</a></div>${fmtBot(m.text)}${m.orig ? `<details class="origbox"><summary>Mostrar original</summary>${esc(m.orig)}</details>` : ''}`;
  const c = m.el.querySelector('[data-copy]'); if (c) c.onclick = () => copyToast(m.text, 'Texto');
  m.el.querySelectorAll('.en').forEach((s) => { s.title = 'Clique para copiar a frase em inglês'; s.onclick = () => copyToast(s.textContent.replace(/^EN:\s*/, ''), 'Inglês'); });
  m.el.querySelectorAll('.ptl').forEach((s) => { s.title = 'Clique para copiar em português'; s.onclick = () => copyToast(s.textContent.replace(/^PT:\s*/, ''), 'Português'); });
  m.el.querySelectorAll('[data-link]').forEach((k) => { k.onclick = async () => { const o = await api.openLink(k.dataset.link); if (!o.ok) toast(o.error || 'Não abri o link.'); }; });
  const box = $('chat'); box.scrollTop = box.scrollHeight;
}
const streams = new Map();
api.onDelta((rid, text) => { const h = deltaHandlers.get(rid); if (h) { h(text); return; } const m = streams.get(rid); if (m) { m.text = text; paintMsg(m); } });

async function runAI(title, fn, userText) {
  showTab('chat');
  if (userText) addMsg('user', userText);
  const m = addMsg('bot', 'Pensando…', title);
  const rid = ++state.rid; streams.set(rid, m);
  const t0 = performance.now();
  const r = await fn(rid);
  setTiming({ ai: (performance.now() - t0) / 1000 });
  streams.delete(rid);
  m.text = r.ok ? (r.text || '(sem resposta)') : `Erro: ${r.error}`; m.prov = r.ok && r.provider ? `via ${r.provider}` : '';
  paintMsg(m); saveHistory(); refreshRate();
}

const linesForAI = () => state.lines.map(({ who, text }) => ({ who, text }));
const chatContext = () => state.chat.filter((m) => m.text && m.text !== 'Pensando…').slice(-4)
  .map((m) => `${m.role === 'user' ? 'Helison perguntou' : 'Você respondeu'}: ${m.text.slice(0, 400)}`).join('\n');

const sugEn = () => runAI('Sugerir em inglês (2 opções + português)', (rid) => api.suggest(linesForAI(), 'en', rid));
const sugPt = () => runAI('O que eu digo? (2 opções)', (rid) => api.suggest(linesForAI(), 'pt', rid));
// ---------- contexto da reunião ----------
// Tradutor (aba em inglês): digita em português, recebe o inglês grande para ler em voz alta; não usa o chat nem outras funções
function showTranslation(item) {
  state.trCurrent = item; $('trOut').classList.remove('hidden');
  $('trEn').textContent = item.en; $('trPt').textContent = item.pt ? `Em português: ${item.pt}` : '';
}
function renderTrHist() {
  const box = $('trHist'); box.innerHTML = '';
  state.trHist.forEach((it) => { const b = document.createElement('button'); b.className = 'mini'; b.type = 'button'; b.textContent = it.src; b.title = it.en; b.onclick = () => showTranslation(it); box.appendChild(b); });
}
async function translatePhrase(text) {
  const t = String(text || '').trim(); if (!t) return;
  $('trOut').classList.remove('hidden'); $('trEn').textContent = 'Traduzindo…'; $('trPt').textContent = '';
  const t0 = performance.now();
  const rid = ++state.rid;
  deltaHandlers.set(rid, (text) => { const part = (text.match(/^EN:\s*(.*)$/m) || [])[1]; if (part) $('trEn').textContent = part; });
  const r = await api.sayEn(t, rid);
  deltaHandlers.delete(rid);
  setTiming({ ai: (performance.now() - t0) / 1000 });
  if (r.cancelled) return;
  if (!r.ok) { $('trEn').textContent = ''; $('trPt').textContent = `Erro: ${r.error}`; return; }
  const en = ((r.text || '').match(/^EN:\s*(.*)$/m) || [])[1] || (r.text || '').trim();
  const pt = ((r.text || '').match(/^PT:\s*(.*)$/m) || [])[1] || '';
  const item = { src: t, en, pt };
  state.trHist.unshift(item); state.trHist = state.trHist.slice(0, 5);
  renderTrHist(); showTranslation(item);
}
// Alterna entre "Reunião em português" e "Reunião em inglês" (lembra a última escolha)
function setMode(mode, persist = true) {
  state.mode = mode === 'en' ? 'en' : 'pt';
  $('root').classList.toggle('mode-en', state.mode === 'en'); $('root').classList.toggle('mode-pt', state.mode === 'pt');
  $('modePt').classList.toggle('active', state.mode === 'pt'); $('modeEn').classList.toggle('active', state.mode === 'en');
  if (persist) { try { localStorage.setItem('heliosMeetingMode', state.mode); } catch { /* sem armazenamento */ } }
  state.lines.forEach(renderLine);
  const last = state.lines[state.lines.length - 1]; if (last) renderCaption(last);
}
const onlyIn = (mode, what) => { if (state.mode === mode) return true; toast(`${what} fica na aba "Reunião em ${mode === 'en' ? 'inglês' : 'português'}".`, 3000); return false; };
// Falas anteriores (só texto original) que acompanham a tradução; a quantidade vem das configurações
function historyBefore(id) {
  const n = Number(state.settings.translateHistory ?? 3);
  return n > 0 ? state.lines.filter((l) => l.id < id && l.text).slice(-n).map((l) => l.text) : [];
}
const rpcError = (e) => String((e && e.message) || e || 'erro').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
function fillContext() { $('meetingContext').value = state.settings.meetingContext || ''; $('ctxState').textContent = state.settings.meetingContext ? '(preenchido)' : ''; }
async function saveMeetingContext() {
  try {
    state.settings = await api.setSettings({ meetingContext: $('meetingContext').value });
    fillContext(); toast('Contexto da reunião salvo.', 1200);
  } catch (e) { toast(rpcError(e), 5000); }
}
const glossaryNote = (r, verb) => `${r.count} termos${verb}${r.skipped ? ` · ${r.skipped} linha(s) ignorada(s) por parecer segredo` : ''}`;
async function loadGlossaryUi() {
  const r = await api.glossaryGet();
  if (!r.ok) { $('glossaryState').textContent = r.error || 'Não li o glossário.'; return; }
  $('glossary').value = r.text; $('glossary').dataset.dirty = '';
  $('glossaryState').textContent = glossaryNote(r, '');
}
async function saveGlossary() {
  const r = await api.glossarySet($('glossary').value);
  if (!r.ok) { toast(r.error || 'Não salvei o glossário.'); return; }
  $('glossary').dataset.dirty = '';
  $('glossaryState').textContent = glossaryNote(r, ' salvos');
}
// Pesquisa só de leitura, com o contexto da vaga: resposta curta em português com as fontes
async function searchWithContext() {
  showTab('chat');
  const sel = String(window.getSelection() || '').trim();
  const last = [...state.lines].reverse().find((l) => l.text);
  const r = await api.searchBuild(sel, last ? last.text : '');
  if (!r.ok) { addMsg('bot', r.error || 'Não montei a pesquisa.', 'Pesquisa'); return; }
  const m = addMsg('bot', `Pesquisando: ${r.query}…`, 'Pesquisa com contexto');
  const rid = ++state.rid; streams.set(rid, m);
  const t0 = performance.now();
  const res = await api.research(linesForAI(), r.query, rid);
  setTiming({ ai: (performance.now() - t0) / 1000 });
  streams.delete(rid);
  if (res.ok) {
    const text = res.text || '(sem resposta)';
    m.text = /https?:\/\//.test(text) ? text : `${text}\n\n(Sem fontes citadas: confirme antes de usar.)`;
    m.prov = res.provider ? `via ${res.provider}` : '';
  } else m.text = `A pesquisa não funcionou: ${res.error}\nVocê ainda pode abrir a busca no Google pelo botão abaixo.`;
  paintMsg(m); saveHistory();
  const open = document.createElement('button'); open.className = 'mini'; open.textContent = 'Abrir no Google';
  open.onclick = async () => { const o = await api.searchOpen(r.query); if (!o.ok) toast(o.error || 'Não abri o navegador.'); };
  m.el.appendChild(open);
}

const summary = () => runAI('Resumo da reunião', (rid) => api.summary(linesForAI(), rid));
function explain() {
  const sel = String(window.getSelection() || '').trim();
  return runAI(sel ? sel.slice(0, 40) : 'Explica isso', (rid) => api.explain(linesForAI(), sel || null, rid));
}
const roteiro = () => runAI('Roteiro', (rid) => api.roteiro(linesForAI(), '', rid));

let live = null;
function renderLive() {
  const box = $('livePlan');
  const btn = $('btnNext');
  const prev = $('btnPrev');
  const progress = $('liveProgress');
  const bar = $('liveBar');
  if (!live) {
    box.innerHTML = '<div class="empty">Descreva o que vamos construir. O roteiro aparece aqui para você digitar. Nada é gravado e nenhum editor abre.</div>';
    btn.disabled = true;
    if (prev) prev.disabled = true;
    btn.textContent = 'Próximo, 1 de 1';
    if (progress) progress.hidden = true;
    return;
  }
  const total = live.total || 1;
  const cursor = Number(live.cursor) || 0;
  const n = Math.min(total, cursor + 1);
  if (progress) progress.hidden = false;
  if (bar) bar.style.transform = `scaleX(${Number(live.progresso) || 0})`;
  let body = '';
  if (live.tela === 'mapa' || !live.atual) {
    const files = (live.arquivos || []).map((file) => `<li><code>${esc(file.path)}</code><span>${esc(file.papel)}</span></li>`).join('');
    body = `<section class="roteiro"><p class="kicker">Visão geral</p><h3>${esc(live.title)}</h3><p>${esc(live.visao || '')}</p><p>Arquivos, nesta ordem:</p><ul class="file-list">${files}</ul><p class="onde">Nada foi gravado em disco e nenhum editor foi aberto.</p></section>`;
  } else {
    const atual = live.atual;
    const code = atual.codigo ? `<pre class="roteiro-code">${esc(atual.codigo)}</pre><button type="button" class="mini" id="btnCopyCode">Copiar bloco</button>` : '';
    body = `<section class="roteiro"><p class="kicker">Seção ${esc(String(atual.n))} de ${esc(String((live.secoes && live.secoes.length) || total - 1))}</p><h3>${esc(atual.titulo)}</h3><p>${esc(atual.explicacao)}</p>${atual.arquivo ? `<p><code>${esc(atual.arquivo)}</code></p>` : ''}${atual.onde ? `<p class="onde">Onde colar: ${esc(atual.onde)}</p>` : ''}${code}</section>`;
  }
  box.innerHTML = body;
  const copy = $('btnCopyCode');
  if (copy && live.atual) copy.onclick = () => copyToast(live.atual.codigo, 'Bloco');
  const atEnd = live.status === 'done' || cursor >= total - 1;
  btn.disabled = atEnd;
  if (prev) prev.disabled = cursor <= 0;
  btn.textContent = atEnd ? `Roteiro concluído, ${total} de ${total}` : `Próximo, ${n} de ${total}`;
}
async function startLive(description) {
  const r = await api.liveStart(description);
  if (!r.ok) { toast(r.error || 'Não abri o livecoding.'); return; }
  live = r.session;
  showTab('live');
  renderLive();
}
async function nextLive() {
  if (!live || live.status === 'done') return;
  $('btnNext').disabled = true;
  const r = await api.liveNext(live.id);
  $('btnNext').disabled = false;
  if (!r.ok) { toast(r.error || 'O passo não rodou.'); return; }
  live = r.session;
  renderLive();
}
async function prevLive() {
  if (!live || !api.livePrev || !live.cursor) return;
  $('btnPrev').disabled = true;
  const r = await api.livePrev(live.id);
  $('btnPrev').disabled = false;
  if (!r.ok) { toast(r.error || 'Não voltei o roteiro.'); return; }
  live = r.session;
  renderLive();
}
// Print da tela: mostra a prévia e só envia depois do clique em Enviar
async function screenAsk() {
  showTab('chat');
  const r = await api.screenPreview();
  if (!r.ok) { toast(r.error || 'Não consegui capturar a tela.', 7000); return; }
  state.shotPending = true; $('shotImg').src = r.preview; $('shotBox').classList.remove('hidden');
}
function shotHide() { state.shotPending = false; $('shotBox').classList.add('hidden'); $('shotImg').removeAttribute('src'); }
function shotCancel() { shotHide(); api.screenCancel(); toast('Print descartado: nada foi enviado.', 2200); }
function shotDrop() { if (state.shotPending) { shotHide(); api.screenCancel(); } }
async function shotSend() { shotHide(); await runAI('Análise da tela', (rid) => api.ask(linesForAI(), 'Analise minha tela junto com a conversa e diga, em português, o que eu devo fazer ou dizer agora.', true, rid)); }
function ask(q) {
  if (!q) return;
  const ctx = chatContext();
  const question = ctx ? `${q}\n\n(Conversa anterior no chat, para contexto:\n${ctx})` : q;
  const only = state.mode === 'pt' ? '\n\n(Responda somente em português, sem frases em inglês.)' : '';
  return runAI('Resposta', (rid) => api.ask(linesForAI(), `${question}${only}`, false, rid), q);
}

// Aba em inglês: só a tradução em português do que o Outro(s) disse por último (3 falas); o original é opcional
async function translateRecent() {
  showTab('chat');
  const them = state.lines.filter((l) => l.who === 'them' && l.lang !== 'pt').slice(-3);
  if (!them.length) { toast('Ainda não ouvi a outra pessoa. Clique em Iniciar.', 2500); return; }
  const m = addMsg('bot', 'Traduzindo…', 'O que a outra pessoa disse');
  $('btnTranslate').disabled = true;
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
      if (r.ok) { for (const it of r.items) { const l = state.lines.find((x) => x.id === it.id); if (l && it.pt) { l.pt = it.pt; renderLine(l); } } m.prov = r.provider ? `via ${r.provider}` : ''; } else err = r.error || 'falha na tradução';
    }
  } catch (e) { err = (e && e.message) || 'falha na tradução'; }
  $('btnTranslate').disabled = false;
  m.text = err ? `Erro: ${err}` : (them.map((l) => l.pt).filter(Boolean).join('\n') || 'Não consegui traduzir esse trecho.');
  m.orig = err ? '' : them.map((l) => l.text).join('\n');
  state.trShownId = LineUtil.shownCursor(state.lines, state.trShownId);
  paintMsg(m); saveHistory(); refreshRate();
}

// ---------- histórico ----------
let saveTimer = null;
function saveHistory() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!state.lines.length && !state.chat.length) return;
    const md = `# Reunião ${state.sessionId}\n\n## Transcrição\n\n` +
      state.lines.map((l) => `- ${l.who === 'me' ? '**Você:** ' : l.who === 'them' ? '**Outro(s):** ' : ''}${l.text}${l.pt ? `\n  > ${l.pt}` : ''}`).join('\n') +
      (state.chat.length ? '\n\n## Chat\n\n' + state.chat.map((m) => (m.role === 'user' ? `**Você (${m.at}):** ${m.text}` : `**${m.title} (${m.at}):**\n\n${m.text}`)).join('\n\n') : '') + '\n';
    api.saveHistory(state.sessionId, md);
  }, 1500);
}

async function refreshRate() {
  if (state.settings.mock) { $('quota').textContent = 'modo demonstração: sem chamadas à IA'; return; }
  const r = await api.getRate();
  const f = (x, label) => (x ? `${label} ${x.reqLeft ?? '?'}/${x.reqLimit ?? '?'}${x.status === 429 ? ' ⚠' : ''}` : '');
  const t = [f(r.audio, 'áudio'), f(r.chat, 'IA')].filter(Boolean).join(' · ');
  $('quota').textContent = t ? `cota hoje: ${t}` : '';
}

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
    // pausa na fala depois de metade do bloco: fecha o bloco já (a legenda sai antes e o corte cai entre frases)
    if (rec.mr && rec.mr.state === 'recording' && LineUtil.shouldCut({ elapsedMs: Date.now() - rec.startAt, maxMs: chunkSecs() * 1000, voiced: rec.voiced, silentTicks: rec.silent })) rec.mr.stop();
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
  if (LineUtil.isDuplicate(recent, r.text)) return; // bloco repetido, quase igual ou eco do microfone
  const line = { id, who, text: r.text, lang: r.language || '', pt: '' };
  state.lines.push(line); state.lines.sort((a, b) => a.id - b.id);
  renderLine(line); saveHistory();
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
  if (!state.settings.hasGroqKey && !state.settings.hasGeminiKey) { openSettings(); toast('Cole sua chave da Groq em Configurações para começar.'); setStatus('sem chave'); return; }
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
    if (!sources.length) { giveUp(); setStatus('parado'); toast(`Não consegui ouvir nada. ${problems.join(' ')} Tente de novo; se o som do PC não funcionar, use o microfone com o alto-falante ligado.`, 14000); return; }
    const hasThem = sources.some((s) => s.who === 'them'); const hasMe = sources.some((s) => s.who === 'me');
    if (problems.length) toast(`${problems.join(' ')} Sigo só com ${hasThem ? 'o áudio do PC (suas falas não serão captadas)' : 'o seu microfone (as falas dos outros não serão captadas)'}.`, 14000);
    state.streams = opened; state.ctx = ctx;
    state.recs = sources.map((s) => makeRecorder(s.stream, ctx, ctx.createMediaStreamSource(s.stream), s.who));
    state.recording = true; state.listenText = `ouvindo: ${[hasMe ? 'você' : '', hasThem ? 'outros' : ''].filter(Boolean).join(' + ')}`;
    setTiming({ cap: chunkSecs() });
    state.startedAt = Date.now(); tick(); state.timerIv = setInterval(tick, 1000);
    $('btnStart').textContent = 'Parar'; $('btnStart').classList.add('on'); $('dot').classList.add('live'); $('timer').classList.remove('hidden');
    setStatus(state.listenText); showTab(state.tab === 'settings' ? 'chat' : state.tab);
  } catch (e) {
    giveUp(); setStatus('parado'); toast(`Não consegui iniciar: ${(e && e.message) || e}`, 10000);
  } finally { state.starting = false; }
}
// Por padrão descarta o que ainda estava a caminho (fechar a janela não manda mais nada para a nuvem); "Parar" mantém o último trecho.
function stopSession(discard = true) {
  state.gen += 1; state.discard = discard; state.listenText = '';
  state.recs.forEach((r) => r.stop()); state.recs = [];
  state.streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); state.streams = [];
  if (state.ctx) { state.ctx.close(); state.ctx = null; }
  clearInterval(state.timerIv); state.recording = false;
  state.pendingTr.forEach((l) => { l.trq = false; }); state.pendingTr = []; clearTimeout(state.trTimer); state.trTimer = null; state.trPauseUntil = 0;
  if (discard) { deltaHandlers.clear(); streams.clear(); }
  shotDrop();
  $('btnStart').textContent = 'Iniciar'; $('btnStart').classList.remove('on'); $('dot').classList.remove('live'); $('timer').classList.add('hidden');
  setStatus('parado'); saveHistory();
}
const toggleStart = () => (state.recording || state.starting ? stopSession(false) : start());

// ---------- configurações ----------
const FIELDS = ['provider', 'meetingLang', 'captureMic', 'myContext', 'sttModel', 'chunkSeconds', 'llmModel', 'fastModel', 'geminiModel', 'opacity', 'formality', 'translateHistory', 'translateContextChars'];
function fillSettings() {
  const s = state.settings;
  for (const f of FIELDS) { const el = $(f); if (el.type === 'checkbox') el.checked = !!s[f]; else el.value = s[f] ?? ''; }
  $('groqKey').value = ''; $('geminiKey').value = '';
  $('groqState').textContent = s.hasGroqKey ? '✓ chave salva (criptografada)' : '';
  $('geminiState').textContent = s.hasGeminiKey ? '✓ chave salva (criptografada)' : '';
  $('liveTr').checked = !!s.translate;
  fillContext(); loadGlossaryUi();
}
function openSettings() { if (state.tab === 'settings' && !$('panel').classList.contains('hidden')) return showTab(state.prevTab || 'chat'); state.prevTab = state.tab; fillSettings(); showTab('settings'); api.focus(); }
async function saveSettings() {
  if ($('glossary').dataset.dirty) await saveGlossary();
  const patch = {};
  for (const f of FIELDS) { const el = $(f); patch[f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value; }
  if ($('groqKey').value.trim()) patch.groqKey = $('groqKey').value.trim();
  if ($('geminiKey').value.trim()) patch.geminiKey = $('geminiKey').value.trim();
  state.settings = await api.setSettings(patch);
  fillSettings(); $('testResult').textContent = 'Salvo.';
}

function showPersonal(i) {
  if (!i) return;
  const tok = Math.round(i.chars / 4);
  $('personalState').textContent = i.error ? `Erro: ${i.error}` : i.truncated
    ? `⚠ meu contexto tem ~${tok} tokens; só os primeiros ~1.500 são usados. Encurte o arquivo.`
    : `personallycontext.md carregado (~${tok} tokens)`;
  $('personalState').style.color = i.truncated ? '#ffb84d' : '';
}

function bind() {
  $('btnStart').onclick = toggleStart;
  $('tabChat').onclick = () => showTab('chat');
  $('tabTranscript').onclick = () => showTab('transcript');
  $('tabLive').onclick = () => { showTab('live'); renderLive(); };
  $('btnHide').onclick = () => { stopSession(); api.hide(); };
  $('btnSettings').onclick = openSettings;
  $('btnCloseSettings').onclick = () => showTab(state.prevTab || 'chat');
  $('btnSaveSettings').onclick = saveSettings;
  $('btnTest').onclick = async () => {
    await saveSettings(); $('testResult').textContent = 'Testando…';
    const r = await api.testKeys();
    $('testResult').textContent = !r.ok ? r.error : (Object.entries(r.result).map(([k, v]) => `${k === 'groq' ? 'Groq' : 'Gemini'}: ${v}`).join(' · ') || 'Nenhuma chave salva.');
    refreshRate();
  };
  $('btnPersonal').onclick = async () => showPersonal(await api.openPersonal());
  api.onPersonal(showPersonal);
  $('btnSugEn').onclick = sugEn;
  $('btnSugBoth').onclick = sugPt;
  $('sayForm').onsubmit = (e) => { e.preventDefault(); const q = $('sayInput').value; $('sayInput').value = ''; translatePhrase(q); };
  $('btnTrCopy').onclick = () => { if (state.trCurrent) copyToast(state.trCurrent.en, 'Inglês'); };
  $('trEn').onclick = () => { if (state.trCurrent) copyToast(state.trCurrent.en, 'Inglês'); };
  $('modePt').onclick = () => setMode('pt'); $('modeEn').onclick = () => setMode('en');
  $('showOrig').onchange = () => { $('root').classList.toggle('show-orig', $('showOrig').checked); };
  $('btnShot').onclick = screenAsk;
  $('btnShotSend').onclick = shotSend;
  $('btnShotCancel').onclick = shotCancel;
  $('chunk6').onclick = () => { $('chunkSeconds').value = 6; };
  $('chunk9').onclick = () => { $('chunkSeconds').value = 9; };
  $('btnSearch').onclick = searchWithContext;
  $('meetingContext').onchange = saveMeetingContext;
  $('glossary').oninput = () => { $('glossary').dataset.dirty = '1'; };
  $('btnGlossarySave').onclick = saveGlossary;
  $('btnGlossaryOpen').onclick = () => api.glossaryOpen();
  $('btnTranslate').onclick = translateRecent;
  $('btnSummary').onclick = summary;
  $('btnExplain').onclick = () => explain();
  $('btnRoteiro').onclick = roteiro;
  $('liveForm').onsubmit = (e) => { e.preventDefault(); const q = $('liveInput').value.trim(); if (q) startLive(q); };
  $('btnNext').onclick = nextLive;
  if ($('btnPrev')) $('btnPrev').onclick = prevLive;
  api.onLiveSession((session) => { live = session; showTab('live'); renderLive(); });
  $('btnHistory').onclick = () => api.openHistory();
  $('btnNew').onclick = () => {
    saveHistory(); state.lines = []; state.chat = []; state.trShownId = 0; $('caption').classList.add('hidden'); state.sessionId = newSessionId();
    $('transcript').innerHTML = '<div class="empty">Nova reunião.</div>'; $('chat').innerHTML = '<div class="empty">Nova reunião.</div>';
  };
  $('liveTr').onchange = async () => { state.settings = await api.setSettings({ translate: $('liveTr').checked }); };
  $('askForm').onsubmit = (e) => { e.preventDefault(); const q = $('askInput').value.trim(); $('askInput').value = ''; ask(q); };
  api.onHotkey((n) => {
    if (n === 'sugEn' || n === 'sugPt') (state.mode === 'en' ? sugEn() : sugPt());
    else if (n === 'translate') { if (onlyIn('en', 'Traduzir o que a outra pessoa disse')) translateRecent(); }
    else if (n === 'record') toggleStart();
    else if (n === 'ask') { if (onlyIn('pt', 'A pergunta livre')) { showTab('chat'); api.focus(); setTimeout(() => $('askInput').focus(), 50); } }
    else if (n === 'screen') screenAsk();
    else if (n === 'say') { if (onlyIn('en', 'O tradutor')) { showTab('chat'); api.focus(); setTimeout(() => $('sayInput').focus(), 50); } }
    else if (n === 'settings') openSettings();
    else if (n === 'clickthrough') { state.clickThrough = !state.clickThrough; $('ctBadge').classList.toggle('hidden', !state.clickThrough); toast(state.clickThrough ? 'Modo atravessar ligado (Ctrl+Shift+T desliga).' : 'Modo atravessar desligado.', 2500); }
  });
  // O main avisa quando a janela fecha por fora do botão (Esc, Alt+F4, atalho): para a captura e desliga o modo atravessar.
  api.onMeetingStop((info) => {
    if (info && info.stop) { if (state.recording || state.starting) stopSession(); shotDrop(); }
    if (state.clickThrough) { state.clickThrough = false; $('ctBadge').classList.add('hidden'); }
  });
  // Esc fecha o modo de reunião, mas não enquanto grava; nas configurações só volta; em campo de texto com conteúdo só tira o foco.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    if (state.shotPending) { shotCancel(); return; }
    if (state.recording) return;
    const el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.value) { el.blur(); return; }
    if (state.tab === 'settings' && !$('panel').classList.contains('hidden')) { showTab(state.prevTab || 'chat'); return; }
    api.hide();
  });
  api.onHotkeysFailed((l) => toast(`Atalhos já usados por outro app: ${l.join(', ')}`, 8000));
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
  bind();
  let savedMode = 'pt'; try { savedMode = localStorage.getItem('heliosMeetingMode') || 'pt'; } catch { /* sem armazenamento */ }
  setMode(savedMode, false);
  state.settings = await api.getSettings();
  fillSettings();
  showPersonal(await api.personalInfo());
  if (!state.settings.hasGroqKey && !state.settings.hasGeminiKey) showTab('settings');
  else showTab('chat');
  fit();
})();
