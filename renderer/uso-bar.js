// LEVA P3: barra fina de uso sob o composer — % da conta Cursor ativa + "Renova em N dias".
// Mesma regra do card Ajustes › Conta. Sem simbolo de moeda. Sem dado → esconde a barra.
(function () {
  "use strict";
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const call = (m, p, b) => window.heliosCall(m, p, b);

  let cache = null;
  let lastFetch = 0;

  async function fetchActive() {
    const now = Date.now();
    if (cache && now - lastFetch < 60000) return cache;
    try {
      const data = await call("GET", "/api/accounts");
      const list = Array.isArray(data.accounts) ? data.accounts : [];
      const active = list.find((a) => a.active) || list[0] || null;
      cache = active;
      lastFetch = now;
      return active;
    } catch {
      return cache;
    }
  }

  function renderHtml(account) {
    const C = window.HeliosContas;
    if (!C || !account) return "";
    const cu = account.cursorUsage;
    if (!cu) return "";
    const top = C.usageTopPercent(cu);
    const showPct = top != null && cu.showBar && cu.source !== "auth" && cu.source !== "indisponivel" && cu.source !== "none";
    if (!showPct) return "";
    const width = Math.min(100, top);
    const pctTxt = C.pct(top) || `${Math.round(width)}%`;
    const cycleEnd = cu.real?.cycleEnd || cu.nextResetAt || null;
    const renew = C.renewLabel(cycleEnd);
    const tip = C.usageTip(cu) || `${pctTxt} usado`;
    // Remove simbolos de moeda do tooltip (nunca exibir valor).
    const tipSafe = String(tip).replace(/\bUSD\b|\bBRL\b|[$]/gi, "").trim();
    const label = renew ? `${pctTxt} · ${renew}` : pctTxt;
    return `<div class="hx-uso-bar-inner" title="${esc(tipSafe)}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(Math.round(width))}" aria-label="Uso da conta Cursor">
      <div class="hx-uso-track"><span style="width:${esc(width)}%"></span></div>
      <span class="hx-uso-label">${esc(label)}</span>
    </div>`;
  }

  async function mount(el) {
    if (!el) return;
    const account = await fetchActive();
    const html = renderHtml(account);
    if (!html) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = html;
  }

  /** Anexa barra sob cada .composer ainda sem wrap. */
  async function mountAll(root) {
    const scope = root || document;
    const composers = scope.querySelectorAll(".composer");
    for (const form of composers) {
      let wrap = form.closest(".hx-composer-wrap");
      let bar = wrap && wrap.querySelector(".hx-uso-bar");
      if (!bar) {
        if (!wrap) {
          wrap = document.createElement("div");
          wrap.className = "hx-composer-wrap";
          form.parentNode.insertBefore(wrap, form);
          wrap.appendChild(form);
        }
        bar = document.createElement("div");
        bar.className = "hx-uso-bar";
        bar.hidden = true;
        wrap.appendChild(bar);
      }
      await mount(bar);
    }
  }

  window.HeliosUsoBar = { mount, mountAll, renderHtml, fetchActive };
})();
