'use strict';
// Utilitarios de falas (usados no renderer e nos testes)
(function (root) {
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const tokens = (t) => norm(t).split(' ').filter((word) => word.length > 1);
  const LAST_N = 8;
  // frases curtas demais não entram na comparação aproximada (hello × olá continua diferente)
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
  // true se o bloco novo repete alguma das últimas falas (igual ou quase igual)
  function isDuplicate(prev, text) {
    const current = norm(text);
    if (!current) return false;
    const list = (Array.isArray(prev) ? prev : (prev ? [prev] : [])).slice(-LAST_N);
    return list.some((item) => {
      const other = norm(item);
      return !!other && (other === current || nearDuplicate(item, text));
    });
  }
  // falas novas desde a ultima traducao mostrada
  const newSince = (lines, lastId) => (lines || []).filter((l) => l.id > (lastId || 0));
  // avança só pelo prefixo que já está em português; para no primeiro buraco
  function shownCursor(lines, fromId) {
    let cursor = fromId || 0;
    for (const line of lines || []) {
      if (!line || line.id <= cursor) continue;
      if (line.pt || line.lang === 'pt') cursor = line.id;
      else break;
    }
    return cursor;
  }
  // avança o cursor antes do await e recusa um segundo clique enquanto traduz
  function claimTranslate(lines, shownId, translating) {
    const current = shownId || 0;
    if (translating) return { claimed: false, reason: "ocupado", shownId: current };
    const fresh = newSince(lines, current);
    if (!fresh.length) return { claimed: false, reason: "nada", shownId: current };
    const upTo = fresh[fresh.length - 1].id;
    return { claimed: true, reason: "", previous: current, upTo, shownId: upTo, fresh };
  }
  // lixo de transcrição: só pontuação, 1 letra, legendas de vídeo que o Whisper inventa no silêncio ou palavra repetida várias vezes
  const NOISE = /amara\.org|legendas? (pela|por|de)\b|subtitles? (by|from)|thanks? for watching|obrigad[oa] por assistir|inscreva-se|subscribe to/i;
  function isNoise(text) {
    const t = String(text || '').trim();
    if (!t || !/[\p{L}\p{N}]/u.test(t)) return true;
    if (norm(t).length < 2) return true;
    if (NOISE.test(t)) return true;
    return /^(\S+)(\s+\1){4,}[.!?]*$/i.test(t);
  }
  // Corta o bloco de áudio mais cedo quando há uma pausa na fala (menos espera até a legenda): precisa de pelo menos
  // metade do bloco (mínimo 3 s), ter fala no bloco e ~0,8 s de silêncio seguido (8 medições de 100 ms).
  function shouldCut({ elapsedMs = 0, maxMs = 6000, voiced = 0, silentTicks = 0 } = {}) {
    return elapsedMs >= Math.max(3000, maxMs * 0.5) && voiced >= 5 && silentTicks >= 8;
  }
  const api = { norm, isDuplicate, newSince, shownCursor, claimTranslate, isNoise, shouldCut };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LineUtil = api;
})(typeof window !== 'undefined' ? window : globalThis);
