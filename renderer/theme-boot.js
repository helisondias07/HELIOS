"use strict";
/* Aplica o tema e o estado da sidebar salvos antes de pintar (evita piscar). Escuro e expandida são o padrão;
   a janela de reunião não carrega este arquivo. A chave da sidebar é a mesma das versões anteriores
   ("full"/"panel" = expandida, "rail" = recolhida); o formato novo é {"v":2,"expanded":true|false}. */
(function () {
  var theme = "dark";
  var sb = "expanded";
  try { if (localStorage.getItem("helios-theme") === "light") theme = "light"; } catch { /* sem armazenamento: fica escuro */ }
  try {
    var saved = JSON.parse(localStorage.getItem("helios-sidebar-v1") || "null");
    if (saved && (saved.v === 2 ? saved.expanded === false : saved.variant === "rail")) sb = "collapsed";
  } catch { /* valor inválido: fica expandida */ }
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-sb", sb);
})();
