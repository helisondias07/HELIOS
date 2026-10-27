"use strict";

// Guarda quais blocos <details> estao abertos, para que o redesenho periodico da tela (innerHTML) nao os feche.
(function () {
  function create() {
    const open = new Set();
    return {
      has: (id) => open.has(String(id)),
      set(id, isOpen) {
        if (isOpen) open.add(String(id)); else open.delete(String(id));
      },
      attr: (id) => (open.has(String(id)) ? " open" : ""),
      size: () => open.size,
    };
  }
  const api = { create };
  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.HeliosDetailsState = api;
})();
