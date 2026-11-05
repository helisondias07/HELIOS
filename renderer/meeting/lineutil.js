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
  // Microfone da pergunta por voz: fecha na pausa, sem esperar metade do bloco.
  // 5 medições com fala (~0,5 s) e 8 de silêncio (~0,8 s) — o mesmo fim de fala do modo conversa.
  function shouldCutVoice({ elapsedMs = 0, voiced = 0, silentTicks = 0 } = {}) {
    return elapsedMs >= 500 && voiced >= 5 && silentTicks >= 8;
  }
  // "como que eu respondo isso" / "como eu digo" — pedido natural para o HELIOS.
  function asksHowToAnswer(n) {
    return /\bcomo (?:que )?eu (?:respondo|responder|falo|digo)\b/.test(n)
      || /\bo que (?:que )?eu (?:respondo|falo|digo)\b/.test(n);
  }
  // Pergunta do Helison para o HELIOS (não um "sim" nem um relato). Fala natural conta, com ou sem "?".
  function isVoiceQuestion(text) {
    if (isNoise(text)) return false;
    const raw = String(text || '').trim();
    const n = norm(raw);
    if (n.length < 6) return false;
    if (/^(oi|ola|obrigado|obrigada|valeu|ta bom|ok|beleza|entendi|perfeito|sim|nao|yes|yeah|thanks|thank you)$/.test(n)) return false;
    const words = n.split(' ').filter(Boolean);
    const head = words.slice(0, 10).join(' ');
    if (/\b(?:helios|helio)\b/.test(n)) return true;
    if (/\b(?:ve|veja|olha|olhe|mostra)\b/.test(n) && /\btela\b/.test(n)) return true;
    if (asksHowToAnswer(n)) return true;
    // No começo da fala (com um "e", "então", "por favor" ou "Helios" na frente). "ele explica a..." não conta.
    const directed = /^(?:(?:e|entao|por favor|helios|helio) )?(?:nao entendi|me ajuda|me explica|explica|o que (?:e|tem|significa|aparece)|o que eu (?:digo|falo|respondo)|como eu (?:digo|falo|respondo|faco)|como (?:faco|fazer)|what is|what s on|how do i|can you (?:explain|see))\b/.test(n);
    if (directed) return true;
    if (raw.includes('?')) return true;
    if (/^como vai\b/.test(n)) return false;
    const shape = /^(qual|quais|quem|onde|aonde|quando|por que|porque|pra que|para que|quanto|cade|why|where|who|when)\b/.test(head)
      || /\b(por que|porque)\b/.test(head);
    if (!shape) return false;
    return words.length >= 3 && words.length <= 18;
  }
  const api = { norm, isDuplicate, newSince, shownCursor, claimTranslate, isNoise, shouldCut, shouldCutVoice, isVoiceQuestion };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LineUtil = api;
})(typeof window !== 'undefined' ? window : globalThis);
