'use strict';
// Utilitários de falas (usados no renderer e nos testes)
(function (root) {
  const SILENCE_MS = 550;
  const OVERLAP_MS = 400;
  const LAST_N = 8;

  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const tokens = (t) => norm(t).split(' ').filter((word) => word.length > 1);

  function nearDuplicate(a, b) {
    const left = tokens(a);
    const right = tokens(b);
    if (left.length < 4 || right.length < 4) return false;
    const sa = new Set(left);
    const sb = new Set(right);
    let shared = 0;
    for (const word of sa) if (sb.has(word)) shared += 1;
    const denom = Math.min(sa.size, sb.size);
    return denom > 0 && shared / denom >= 0.82;
  }

  function isDuplicate(prev, text) {
    const current = norm(text);
    if (!current) return false;
    const list = (Array.isArray(prev) ? prev : (prev ? [prev] : [])).slice(-LAST_N);
    return list.some((item) => {
      const other = norm(item);
      return !!other && (other === current || nearDuplicate(item, text));
    });
  }

  /** Remove palavras repetidas na borda entre dois blocos com sobreposição de ~400 ms. */
  function trimOverlap(prevText, nextText) {
    const nextRaw = String(nextText || '').trim();
    const prevRaw = String(prevText || '').trim();
    if (!prevRaw || !nextRaw) return nextRaw;
    const prevWords = prevRaw.split(/\s+/);
    const nextWords = nextRaw.split(/\s+/);
    const maxK = Math.min(6, prevWords.length, nextWords.length);
    for (let k = maxK; k >= 1; k--) {
      const tail = norm(prevWords.slice(prevWords.length - k).join(' '));
      const head = norm(nextWords.slice(0, k).join(' '));
      if (tail && tail.length >= 3 && tail === head) {
        return nextWords.slice(k).join(' ').replace(/^[,.;:!?\s-]+/, '').trim();
      }
    }
    return nextRaw;
  }

  const newSince = (lines, lastId) => (lines || []).filter((l) => l.id > (lastId || 0));

  function shownCursor(lines, fromId) {
    let cursor = fromId || 0;
    for (const line of lines || []) {
      if (!line || line.id <= cursor) continue;
      if (line.pt || line.lang === 'pt') cursor = line.id;
      else break;
    }
    return cursor;
  }

  function claimTranslate(lines, shownId, translating) {
    const current = shownId || 0;
    if (translating) return { claimed: false, reason: 'ocupado', shownId: current };
    const fresh = newSince(lines, current);
    if (!fresh.length) return { claimed: false, reason: 'nada', shownId: current };
    const upTo = fresh[fresh.length - 1].id;
    return { claimed: true, reason: '', previous: current, upTo, shownId: upTo, fresh };
  }

  const NOISE = /amara\.org|legendas? (pela|por|de)\b|subtitles? (by|from)|thanks? for watching|obrigad[oa] por assistir|inscreva-se|subscribe to/i;
  function isNoise(text) {
    const t = String(text || '').trim();
    if (!t || !/[\p{L}\p{N}]/u.test(t)) return true;
    if (norm(t).length < 2) return true;
    if (NOISE.test(t)) return true;
    return /^(\S+)(\s+\1){4,}[.!?]*$/i.test(t);
  }

  function shouldCut({ elapsedMs = 0, maxMs = 5000, voicedMs, voiced = 0, silentMs, silentTicks = 0 } = {}) {
    const vMs = voicedMs != null ? voicedMs : voiced * 100;
    const sMs = silentMs != null ? silentMs : silentTicks * 100;
    return elapsedMs >= Math.min(1300, maxMs * 0.4) && vMs >= 200 && sMs >= SILENCE_MS;
  }

  function shouldCutVoice({ elapsedMs = 0, voicedMs, voiced = 0, silentMs, silentTicks = 0 } = {}) {
    const vMs = voicedMs != null ? voicedMs : voiced * 100;
    const sMs = silentMs != null ? silentMs : silentTicks * 100;
    return elapsedMs >= 700 && vMs >= 200 && sMs >= SILENCE_MS;
  }

  function shouldStartOverlap({ elapsedMs = 0, maxMs = 5000, overlapMs = OVERLAP_MS } = {}) {
    return elapsedMs >= Math.max(1200, maxMs - overlapMs);
  }

  function toProse(text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n').map((line) => {
      let s = line.trim();
      if (!s) return '';
      s = s.replace(/^#{1,6}\s+/, '');
      s = s.replace(/^[-+•*]\s+/, '');
      s = s.replace(/^\d{1,2}[.)]\s+/, '');
      return s.trim();
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function proseParts(text) {
    const body = toProse(text);
    const rows = body.split('\n').map((s) => s.trim()).filter(Boolean);
    const en = rows.find((r) => /^EN:/i.test(r));
    const pt = rows.find((r) => /^PT:/i.test(r));
    if (!en) return { main: body, sub: '' };
    const rest = rows.filter((r) => r !== en && r !== pt).join('\n\n');
    const main = [en.replace(/^EN:\s*/i, '').trim(), rest].filter(Boolean).join('\n\n');
    return { main, sub: pt ? pt.replace(/^PT:\s*/i, '').trim() : '' };
  }

  function enqueueStt(queue, item, max = 2) {
    const list = (Array.isArray(queue) ? queue : []).concat([item]);
    const dropped = list.length > max;
    return { queue: dropped ? list.slice(list.length - max) : list, dropped };
  }

  /** Extrai a pergunta somente quando o usuário chama explicitamente "Helios, ..." (zero falso positivo em perguntas ao cliente). */
  function extractVoiceQuestion(text) {
    if (isNoise(text)) return '';
    const raw = String(text || '').trim();
    const match = raw.match(/^(?:(?:ei|oi|ol[aá]|hey|ok|e|ent[aã]o|por favor)[,\s]+)?h[eé]lios?\b[,:\s-]*(.+)$/iu);
    if (!match) return '';
    const body = match[1].trim();
    return norm(body).length >= 3 ? body : '';
  }

  function isVoiceQuestion(text) {
    return Boolean(extractVoiceQuestion(text));
  }

  const exported = {
    SILENCE_MS, OVERLAP_MS, norm, isDuplicate, trimOverlap, newSince, shownCursor, claimTranslate,
    isNoise, shouldCut, shouldCutVoice, shouldStartOverlap, extractVoiceQuestion, isVoiceQuestion,
    enqueueStt, toProse, proseParts,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.LineUtil = exported;
})(typeof window !== 'undefined' ? window : globalThis);
