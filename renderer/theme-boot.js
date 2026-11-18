"use strict";
(function () {
  var theme = "light";
  try {
    if (localStorage.getItem("helios-theme") === "dark") theme = "dark";
  } catch { /* sem armazenamento: fica claro */ }
  document.documentElement.setAttribute("data-theme", theme);
})();
