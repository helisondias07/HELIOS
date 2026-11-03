"use strict";

/**
 * Captcha só conta se o desafio está visível.
 * Script invisível, iframe 0×0 e o selo pequeno do reCAPTCHA não param a vaga.
 */

function phraseCaptcha(text) {
  const value = String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /nao sou um robo|nao e um robo|i'm not a robot|im not a robot|selecione todas as imagens|verify you are human|verifique que voce e humano/.test(value);
}

function captchaVisivel(widgets = [], text = "") {
  if (phraseCaptcha(text)) return true;
  return (widgets || []).some((widget) => {
    if (!widget || widget.badge || widget.hidden) return false;
    return Number(widget.width) >= 140 && Number(widget.height) >= 50;
  });
}

/**
 * Desafio de verdade: frase do checkbox/puzzle, widget medido, ou o script da página
 * que já separou o selo. `captcha: true` sozinho é o selo antigo (iframe do rodapé).
 */
function desafioVisivel(snapshot = {}) {
  if (snapshot.captchaVisivel === false) return false;
  if (phraseCaptcha(snapshot.text || "")) return true;
  if (Array.isArray(snapshot.captchaWidgets)) return captchaVisivel(snapshot.captchaWidgets, "");
  if (snapshot.captchaVisivel === true) return true;
  return false;
}

/** Trecho que roda na página. Devolve { visible, widgets }. O selo do rodapé fica de fora. */
const CAPTCHA_PAGE_SCRIPT = `(() => {
  const box = (el) => {
    if (!el || !el.getClientRects || !el.getClientRects().length) return null;
    const r = el.getBoundingClientRect();
    let hidden = false;
    try {
      const s = getComputedStyle(el);
      hidden = s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0;
    } catch (e) { hidden = false; }
    const badge = /grecaptcha-badge|rc-anchor-invisible/i.test(String(el.className || "") + " " + String(el.id || ""));
    return { width: r.width, height: r.height, hidden, badge };
  };
  const widgets = [];
  for (const el of document.querySelectorAll("iframe, .g-recaptcha, #captcha, .h-captcha")) {
    const src = String(el.src || "");
    const marked = /captcha|recaptcha|hcaptcha/i.test(src + " " + String(el.className || "") + " " + String(el.id || ""));
    if (!marked && el.tagName === "IFRAME") continue;
    const item = box(el);
    if (item) widgets.push(item);
  }
  const text = (document.body && document.body.innerText || "").slice(0, 4000);
  const phrase = /n[aã]o sou um rob[oô]|n[aã]o [eé] um rob[oô]|i'm not a robot|im not a robot|selecione todas as imagens|verify you are human|verifique que voc[eê]/i.test(text);
  const visible = phrase || widgets.some((w) => !w.badge && !w.hidden && w.width >= 140 && w.height >= 50);
  return { visible: visible, widgets: widgets };
})()`;

module.exports = { captchaVisivel, phraseCaptcha, desafioVisivel, CAPTCHA_PAGE_SCRIPT };
