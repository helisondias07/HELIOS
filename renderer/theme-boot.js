"use strict";
/* Aplica o tema e o estado da sidebar salvos antes de pintar (evita piscar). Claro e expandida são o padrão;
   a janela de reunião não carrega este arquivo. A chave da sidebar é a mesma das versões anteriores
   ("full"/"panel" = expandida, "rail" = recolhida); o formato novo é {"v":2,"expanded":true|false}. */
(function () {
  var theme = "light";   /* Leva J: claro é o tema principal */
  var sb = "expanded";
  try {
    /* migração única da Leva J: quem já usava o escuro passa para o claro uma vez; depois vale a escolha salva */
    if (localStorage.getItem("helios-theme-migr-levaJ") !== "1") {
      localStorage.setItem("helios-theme", "light");
      localStorage.setItem("helios-theme-migr-levaJ", "1");
    }
    if (localStorage.getItem("helios-theme") === "dark") theme = "dark";
  } catch { /* sem armazenamento: fica claro */ }
  try {
    var saved = JSON.parse(localStorage.getItem("helios-sidebar-v1") || "null");
    if (saved && (saved.v === 2 ? saved.expanded === false : saved.variant === "rail")) sb = "collapsed";
  } catch { /* valor inválido: fica expandida */ }
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-sb", sb);
})();
