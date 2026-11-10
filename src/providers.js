'use strict';
// Chamadas às APIs (somente no processo main). Nunca logar chaves.
const GROQ = 'https://api.groq.com/openai/v1';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function readErr(res) {
  let t = '';
  try { t = await res.text(); } catch { /* ignore */ }
  try { const j = JSON.parse(t); t = (j.error && (j.error.message || j.error.status)) || t; } catch { /* texto puro */ }
  const hint = res.status === 401 || res.status === 403 ? ' (chave inválida?)' : res.status === 429 ? ' (limite do plano gratuito atingido, aguarde um pouco)' : '';
  return new ApiError(`HTTP ${res.status}${hint}: ${String(t).slice(0, 300)}`, res.status);
}

// Cota da Groq lida dos cabeçalhos x-ratelimit-* (mostrada na UI)
const rate = {};
function recordRate(url, res) {
  if (!url.startsWith(GROQ)) return;
  const h = (k) => res.headers.get(k);
  const kind = url.includes('/audio/') ? 'audio' : 'chat';
  const r = { reqLeft: h('x-ratelimit-remaining-requests'), reqLimit: h('x-ratelimit-limit-requests'), tokLeft: h('x-ratelimit-remaining-tokens'), tokLimit: h('x-ratelimit-limit-tokens'), at: Date.now(), status: res.status };
  if (r.reqLeft !== null || res.status === 429) rate[kind] = r;
}
function getRate() { return JSON.parse(JSON.stringify(rate)); }

// fetch com nova tentativa em 429/503 (limite do plano gratuito), respeitando retry-after
// opts.signal (opcional) cancela a chamada e a espera entre tentativas (usado ao fechar a janela de reunião)
async function fetchRetry(url, opts, { tries = 3, maxWait = 8000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let res;
  const user = opts && opts.signal;
  for (let i = 0; i < tries; i++) {
    if (user && user.aborted) throw user.reason || new Error('cancelado');
    const signal = user ? AbortSignal.any([AbortSignal.timeout(60000), user]) : AbortSignal.timeout(60000);
    res = await fetch(url, { ...opts, signal });
    recordRate(url, res);
    if (res.status !== 429 && res.status !== 503) return res;
    if (i === tries - 1) break;
    const ra = Number(res.headers.get('retry-after'));
    await sleep(Math.min(maxWait, ra > 0 ? ra * 1000 : 1000 * (i * 2 + 1)));
  }
  return res;
}

// Aquece DNS/TLS da Groq (uma chamada barata) para o primeiro bloco de áudio não pagar o handshake
async function groqWarm({ key, signal }) {
  try {
    const res = await fetch(`${GROQ}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: signal ? AbortSignal.any([AbortSignal.timeout(5000), signal]) : AbortSignal.timeout(5000) });
    await res.arrayBuffer().catch(() => {});
    return res.ok;
  } catch { return false; }
}

// ---------- Groq ----------
async function groqTranscribe({ key, model, audio, mime, language, signal }) {
  const fd = new FormData();
  const ext = (mime || '').includes('ogg') ? 'ogg' : 'webm';
  fd.append('file', new Blob([audio], { type: mime || 'audio/webm' }), `chunk.${ext}`);
  fd.append('model', model || 'whisper-large-v3-turbo');
  fd.append('response_format', 'verbose_json');
  fd.append('temperature', '0');
  if (language && language !== 'auto') fd.append('language', language);
  // áudio: no máximo 2 tentativas e espera curta; se a cota acabou, quem chamou decide (aumentar o bloco e tentar de novo)
  const res = await fetchRetry(`${GROQ}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd, signal }, { tries: 2, maxWait: 3000 });
  if (!res.ok) throw await readErr(res);
  const j = await res.json();
  // descarta segmentos com alta probabilidade de silêncio (alucinações do Whisper)
  let text = j.text || '';
  if (Array.isArray(j.segments) && j.segments.length) text = keepSpeech(j.segments).map((s) => s.text).join(' ');
  return { text: cleanHallucination(text.trim()), language: normLang(j.language) };
}

// Mantém só os trechos com fala: descarta os que o Whisper marcou como silêncio (alucinação típica)
function keepSpeech(segments) {
  return (segments || []).filter((s) => !(s.no_speech_prob > 0.6 && s.avg_logprob < -0.8) && !(s.no_speech_prob > 0.85));
}

async function groqChat({ key, model, messages, maxTokens = 600, temperature = 0.4, onDelta = null, search = false, signal }) {
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (search && /gpt-oss/.test(model)) body.tools = [{ type: 'browser_search' }]; // o modelo decide quando pesquisar
  if (onDelta) body.stream = true;
  if (/gpt-oss/.test(model)) { body.reasoning_effort = 'low'; body.include_reasoning = false; }
  let res = await fetchRetry(`${GROQ}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  if (res.status === 400 && (body.reasoning_effort || body.include_reasoning === false)) {
    delete body.reasoning_effort; delete body.include_reasoning;
    res = await fetchRetry(`${GROQ}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
  }
  if (!res.ok) throw await readErr(res);
  if (onDelta) return stripCites(await readSSE(res, (t) => onDelta(stripCites(t))));
  const j = await res.json();
  return stripCites((j.choices?.[0]?.message?.content || '').trim());
}

const stripCites = (t) => String(t).replace(/【[^】]*】/g, '').replace(/[ \t]+\n/g, '\n');

// Lê stream SSE (formato OpenAI) chamando onDelta(textoAcumulado)
async function readSSE(res, onDelta) {
  const dec = new TextDecoder(); let buf = ''; let full = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return full.trim();
      try { const d = JSON.parse(data).choices?.[0]?.delta?.content; if (d) { full += d; onDelta(full); } } catch { /* linha parcial */ }
    }
  }
  return full.trim();
}

// ---------- Gemini ----------
function toGemini(messages, imageBase64, { temperature, maxOutputTokens } = {}) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: typeof m.content === 'string' ? m.content : '' }],
  }));
  if (imageBase64 && contents.length) contents[contents.length - 1].parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } });
  const hasImage = Boolean(imageBase64);
  const body = {
    contents,
    generationConfig: {
      temperature: temperature != null ? temperature : (hasImage ? 0.1 : 0.4),
      maxOutputTokens: Math.min(4096, Math.max(hasImage ? 1600 : 800, Number(maxOutputTokens) || 0)),
    },
  };
  if (sys) body.system_instruction = { parts: [{ text: sys }] };
  return body;
}

async function geminiGenerate({ key, model, body, signal }) {
  const res = await fetchRetry(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  if (!res.ok) throw await readErr(res);
  const j = await res.json();
  return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

async function geminiChat({ key, model, messages, imageBase64, search = false, signal, maxTokens, temperature }) {
  const body = toGemini(messages, imageBase64, { temperature: temperature != null ? temperature : (imageBase64 ? 0.1 : undefined), maxOutputTokens: maxTokens });
  if (search) body.tools = [{ google_search: {} }]; // grounding com Google Search
  return geminiGenerate({ key, model, body, signal });
}

async function geminiTranscribe({ key, model, audio, mime, signal }) {
  const body = {
    contents: [{ role: 'user', parts: [
      { text: 'Transcreva literalmente a fala deste áudio, no idioma original. Responda só com a transcrição, sem comentários. Se não houver fala, responda vazio.' },
      { inline_data: { mime_type: (mime || 'audio/webm').split(';')[0], data: Buffer.from(audio).toString('base64') } },
    ] }],
    generationConfig: { temperature: 0 },
  };
  const text = await geminiGenerate({ key, model, body, signal });
  return { text: cleanHallucination(text), language: guessLang(text) };
}

// TTS do Gemini: devolve PCM 16 bits, mono, em base64 (24 kHz por padrão). Sem nova tentativa, para cair logo na voz do Windows.
async function geminiTts({ key, model, text, voice }) {
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } } },
  };
  const res = await fetchRetry(`${GEMINI}/models/${encodeURIComponent(model || 'gemini-2.5-flash-preview-tts')}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, { tries: 1 });
  if (!res.ok) throw await readErr(res);
  const j = await res.json();
  const part = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
  const data = part && (part.inlineData || part.inline_data);
  if (!data || !data.data) throw new ApiError('O Gemini não devolveu áudio.', 502);
  const rate = /rate=(\d+)/.exec(data.mimeType || data.mime_type || '');
  return { audio: data.data, sampleRate: rate ? Number(rate[1]) : 24000 };
}

// ---------- utilidades ----------
function normLang(l) {
  if (!l) return '';
  const s = String(l).toLowerCase();
  if (s.startsWith('en') || s === 'english') return 'en';
  if (s.startsWith('pt') || s === 'portuguese') return 'pt';
  return s.slice(0, 2);
}

function guessLang(text) {
  const t = ` ${String(text).toLowerCase()} `;
  const pt = (t.match(/ (não|você|que|de|é|uma|para|com|está|isso) /g) || []).length;
  const en = (t.match(/ (the|and|is|you|to|of|that|it|we|this) /g) || []).length;
  return pt > en ? 'pt' : en > 0 ? 'en' : '';
}

const HALLUCINATIONS = [
  /^thank(s| you)( (so much|very much))?( for watching)?[.!]*$/i,
  /^(please )?subscribe.*$/i, /^you$/i, /^bye[.!]*$/i,
  /^obrigad[oa]( por assistir)?[.!]*$/i, /^legendas? (pela|por) .*$/i, /^\.+$/,
];
function cleanHallucination(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (HALLUCINATIONS.some((r) => r.test(t))) return '';
  return t;
}

module.exports = { stripCites, readSSE, getRate, fetchRetry, groqWarm, keepSpeech, groqTranscribe, groqChat, geminiChat, geminiTranscribe, geminiTts, toGemini, cleanHallucination, normLang, guessLang, ApiError };
