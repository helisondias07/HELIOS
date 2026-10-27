"use strict";
/* HELIOS: comportamento da sidebar única (recolhida só com ícones / expandida com rótulos e grupos).
   Não mexe nos data-view nem nos ids: o app.js continua dono da navegação.
   Aqui ficam: estado recolhido/expandido (persistido), tema, tooltip, atalhos e aria-current. */
(function () {
  const doc = document;
  const root = doc.documentElement;
  const $ = (id) => doc.getElementById(id);
  const $$ = (sel, scope) => Array.from((scope || doc).querySelectorAll(sel));
  const sidebar = $("sidebar");
  const toggleBtn = $("sbToggle");
  const tip = $("sbTip");
  const live = $("sbLive");
  if (!sidebar || !toggleBtn) return;

  const KEY = "helios-sidebar-v1"; // mesma chave das versões anteriores; formato novo {v:2, expanded}
  const THEME_KEY = "helios-theme";
  const NARROW = window.matchMedia("(max-width: 760px)");
  const REDUCE = window.matchMedia("(prefers-reduced-motion: reduce)");
  const state = { expanded: true };

  function say(text) {
    live.textContent = "";
    setTimeout(() => { live.textContent = text; }, 30);
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ v: 2, expanded: state.expanded })); } catch { /* sem armazenamento: vale só nesta sessão */ }
  }
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!saved) return;
      // valores antigos: variant "rail" = recolhida; "full" e "panel" = expandida
      state.expanded = saved.v === 2 ? saved.expanded !== false : saved.variant !== "rail";
    } catch { /* valor inválido: usa o padrão */ }
  }

  /* ---------- recolhida / expandida ---------- */
  function render(announce) {
    const open = state.expanded && !NARROW.matches; // em janela estreita fica sempre recolhida
    root.setAttribute("data-sb", open ? "expanded" : "collapsed");
    toggleBtn.setAttribute("aria-expanded", String(open));
    const label = open ? "Recolher menu lateral" : "Expandir menu lateral";
    toggleBtn.setAttribute("aria-label", label);
    toggleBtn.setAttribute("data-tip", open ? "Recolher menu" : "Expandir menu");
    toggleBtn.hidden = NARROW.matches;
    hideTip();
    if (announce) say(open ? "Menu lateral expandido" : "Menu lateral recolhido");
  }
  function setExpanded(value, announce) {
    state.expanded = value;
    save();
    render(announce);
  }
  function toggle() { setExpanded(!state.expanded, true); }
  NARROW.addEventListener("change", () => render(false));
  toggleBtn.addEventListener("click", toggle);

  /* ---------- tema claro/escuro (View Transitions com fallback imediato) ---------- */
  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    const dark = theme === "dark";
    $$(".sb-ico-theme use").forEach((u) => u.setAttribute("href", dark ? "#i-moon" : "#i-sun"));
    $$(".sb-js-theme").forEach((b) => b.setAttribute("aria-label", "Alternar tema (atual: " + (dark ? "escuro" : "claro") + ")"));
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* sem armazenamento */ }
    /* barra de título nativa (titleBarOverlay) acompanha o tema; fora do Electron/sem a ponte, não faz nada */
    try { if (window.helios && typeof window.helios.setTheme === "function") window.helios.setTheme(theme); } catch { /* sem ponte */ }
  }
  function toggleTheme() {
    const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    if (doc.startViewTransition && !REDUCE.matches) doc.startViewTransition(() => applyTheme(next));
    else applyTheme(next);
    say(next === "light" ? "Tema claro" : "Tema escuro");
  }
  $$(".sb-js-theme").forEach((b) => b.addEventListener("click", toggleTheme));

  /* ---------- aria-current acompanha a classe .active que o app.js já troca ---------- */
  function syncCurrent() {
    $$("nav button[data-view]").forEach((b) => {
      if (b.classList.contains("active")) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
  }
  const navObserver = new MutationObserver(syncCurrent);
  $$("nav button[data-view]").forEach((b) => navObserver.observe(b, { attributes: true, attributeFilter: ["class"] }));
  syncCurrent();

  /* ---------- tooltip: só com a sidebar recolhida (expandida já mostra os nomes) e no botão de alternar ---------- */
  const collapsed = () => root.getAttribute("data-sb") === "collapsed";
  function showTip(el) {
    const text = el.getAttribute("data-tip");
    if (!text) return;
    const isToggle = el === toggleBtn;
    if (!collapsed() && !isToggle) return;
    tip.querySelector(".sb-tip-text").textContent = text;
    const keys = tip.querySelector(".sb-tip-keys");
    keys.textContent = "";
    for (const k of (el.getAttribute("data-keys") || "").split(" ")) {
      if (!k) continue;
      const kb = doc.createElement("kbd");
      kb.textContent = k;
      keys.appendChild(kb);
    }
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const margin = 8;
    // recolhida: ao lado do ícone; botão de alternar expandido: abaixo, sem cobrir o título da tela
    const side = collapsed();
    tip.classList.toggle("is-below", !side);
    let left = side ? r.right + margin : r.right - tip.offsetWidth;
    let top = side ? r.top + r.height / 2 - tip.offsetHeight / 2 : r.bottom + margin;
    left = Math.max(margin, Math.min(left, window.innerWidth - tip.offsetWidth - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - tip.offsetHeight - margin));
    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(top) + "px";
    requestAnimationFrame(() => tip.classList.add("is-on"));
  }
  function hideTip() { tip.classList.remove("is-on"); tip.hidden = true; }
  doc.addEventListener("mouseover", (e) => { const el = e.target.closest && e.target.closest("[data-tip]"); if (el) showTip(el); });
  doc.addEventListener("mouseout", (e) => { if (e.target.closest && e.target.closest("[data-tip]")) hideTip(); });
  doc.addEventListener("focusin", (e) => { const el = e.target.closest && e.target.closest("[data-tip]"); if (el && e.target.matches(":focus-visible")) showTip(el); });
  doc.addEventListener("focusout", hideTip);
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });

  /* ---------- botões que repassam para o que o app.js já faz ---------- */
  const go = (view) => { const b = doc.querySelector('.sb-nav button[data-view="' + view + '"]'); if (b) b.click(); };
  $("sbLogo").addEventListener("click", () => go("chat"));

  /* ---------- atalhos: Ctrl+B recolhe/expande, Ctrl+K pesquisa, Ctrl+Shift+L tema ---------- */
  doc.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === "b" && !e.shiftKey) { e.preventDefault(); toggle(); }
    else if (k === "k" && !e.shiftKey) { e.preventDefault(); go("search"); }
    else if (k === "l" && e.shiftKey) { e.preventDefault(); toggleTheme(); }
  });

  /* ---------- início: aplica o estado salvo sem animar, depois liga a transição ---------- */
  load();
  applyTheme(root.getAttribute("data-theme") === "light" ? "light" : "dark");
  render(false);
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("sb-ready")));
})();
