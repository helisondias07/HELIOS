"use strict";

/* Galeria de conectores. O HTML é puro para o teste; a tela só chama a API local. */

(function () {
  const STATE = {
    connected: ["live", "conectado"],
    waiting: ["warn", "no navegador"],
    reauth: ["warn", "precisa entrar de novo"],
    error: ["bad", "não conectou"],
  };

  function presetCard(preset, connections, esc) {
    const mine = connections.filter((item) => item.presetId === preset.id);
    const rows = mine.map((item) => {
      const chip = STATE[item.status] || ["", item.status];
      const code = item.userCode ? `<p>Código para digitar no site: <strong>${esc(item.userCode)}</strong></p>` : "";
      return `<article class="connect-account" data-state="${esc(item.status)}">
        <div class="row"><strong>${esc(item.label)}</strong> <span class="chip ${chip[0]}">${esc(chip[1])}</span></div>
        ${item.accountHint ? `<p class="muted">${esc(item.accountHint)}</p>` : ""}
        ${code}
        ${item.error ? `<p class="muted">${esc(item.error)}</p>` : ""}
        <form class="row" data-rename="${esc(item.id)}"><input name="label" value="${esc(item.label)}" maxlength="40" aria-label="Novo nome"><button class="btn" type="submit">Renomear</button></form>
        <div class="row">
          ${item.status === "reauth" || item.status === "error" ? `<button type="button" class="btn" data-retry="${esc(preset.id)}" data-client="${esc(preset.needsClientId ? "1" : "")}">Conectar de novo</button>` : ""}
          ${item.status === "waiting" ? `<button type="button" class="btn" data-cancel="${esc(item.id)}">Cancelar</button>` : ""}
          <button type="button" class="btn danger" data-rmcon="${esc(item.id)}">Remover</button>
        </div>
      </article>`;
    }).join("");
    const field = preset.needsClientId
      ? `<label>${esc(preset.clientHint || "Client id")}<input name="clientId" autocomplete="off" spellcheck="false"></label>`
      : "";
    return `<article class="card connect-card stack" data-preset="${esc(preset.id)}" data-state="${mine.some((item) => item.status === "connected") ? "connected" : (mine[0]?.status || "idle")}">
      <p class="kicker">${esc(preset.name)}</p>
      <h2>${esc(preset.name)}</h2>
      <p>${esc(preset.blurb)}</p>
      ${preset.limitation ? `<p class="muted">${esc(preset.limitation)}</p>` : ""}
      ${rows}
      <form class="stack" data-connect="${esc(preset.id)}">
        ${field}
        <label>Nome desta conta<input name="label" maxlength="40" placeholder="${esc(preset.name)}"></label>
        <button class="btn primary" type="submit">Conectar</button>
      </form>
    </article>`;
  }

  function cursorCard(cursor, esc) {
    const login = cursor && cursor.login;
    const waiting = login && login.status === "waiting";
    const failed = login && login.needsKey;
    return `<article class="card connect-card stack" data-preset="cursor" data-state="${failed ? "error" : waiting ? "waiting" : "idle"}">
      <p class="kicker">Cursor</p>
      <h2>Cursor</h2>
      <p>O login oficial abre o site do Cursor, espera você entrar e guarda a chave no cofre. Sem isso, o chat fica em demonstração.</p>
      <p class="muted">Se o site não entregar a chave, o caminho honesto é a página de chaves do Cursor. O HELIOS não inventa uma conta.</p>
      ${failed ? `<p><span class="chip bad">sem conta</span> ${esc(login.error || "")}</p>` : ""}
      ${waiting ? `<p>Aguardando o navegador. ${login.url ? `<a href="${esc(login.url)}" target="_blank" rel="noreferrer">abrir de novo</a>` : ""}</p>` : ""}
      <div class="row">
        <button type="button" class="btn primary" id="cursorLogin">Conectar</button>
        <button type="button" class="btn" id="cursorLocal">Usar o login deste computador</button>
        <button type="button" class="btn" id="cursorKey">Abrir a página da chave</button>
      </div>
    </article>`;
  }

  function galleryHtml(data, esc) {
    const presets = data.presets || [];
    const connections = data.connections || [];
    const cards = presets.filter((item) => item.id !== "cursor").map((item) => presetCard(item, connections, esc)).join("");
    return `<div class="stack">
      <section class="card stack hero">
        <p class="eyebrow">Um clique, o navegador, de volta</p>
        <h2 class="hero-title">Conectores</h2>
        <p>Escolha o aplicativo. O HELIOS abre o site, guarda o acesso no cofre e não mostra o token de novo.</p>
      </section>
      <div class="connect-grid">
        ${cursorCard(data.cursor, esc)}
        ${cards}
      </div>
      <details class="card stack">
        <summary>Adicionar um servidor manual</summary>
        <form class="stack" id="mcpForm">
          <label>Nome<input name="name" required placeholder="outro"></label>
          <label>Tipo<select name="type"><option value="stdio">stdio</option><option value="http">http</option></select></label>
          <label>Comando<input name="command" placeholder="npx"></label>
          <label>Argumentos, um por linha<textarea name="args" placeholder="--stdio"></textarea></label>
          <label>Variáveis só deste conector<textarea name="env" placeholder="MINHA_API_URL=https://exemplo"></textarea></label>
          <label>URL<input name="url" placeholder="https://exemplo/mcp"></label>
          <button class="btn" type="submit">Adicionar</button>
        </form>
      </details>
      <div class="card" id="mcpManual"></div>
    </div>`;
  }

  function create({ call, shell, esc, banner, doc = document, after = null }) {
    let timer = null;
    let manualHtml = "";
    const $ = (id) => doc.getElementById(id);

    async function load(servers) {
      if (servers !== undefined) manualHtml = servers;
      const data = await call("GET", "/api/conectores");
      shell(galleryHtml(data, esc));
      const manual = $("mcpManual");
      if (manual) manual.innerHTML = manualHtml;
      bind(data);
      if (after) after();
      const pending = (data.connections || []).some((item) => item.status === "waiting") || data.cursor?.login?.status === "waiting";
      if (pending) watch();
      else clearInterval(timer);
    }

    function watch() {
      clearInterval(timer);
      timer = setInterval(() => { load().catch((err) => banner(err.message)); }, 1500);
    }

    function bind() {
      doc.querySelectorAll("[data-connect]").forEach((form) => {
        form.onsubmit = (event) => {
          event.preventDefault();
          const fields = new FormData(form);
          return call("POST", `/api/conectores/${form.dataset.connect}/conectar`, {
            clientId: fields.get("clientId") || "",
            label: fields.get("label") || "",
          }).then(() => load()).catch((err) => banner(err.message));
        };
      });
      doc.querySelectorAll("[data-rename]").forEach((form) => {
        form.onsubmit = (event) => {
          event.preventDefault();
          const label = new FormData(form).get("label");
          return call("POST", `/api/conectores/${form.dataset.rename}/renomear`, { label }).then(() => load()).catch((err) => banner(err.message));
        };
      });
      doc.querySelectorAll("[data-rmcon]").forEach((button) => {
        button.onclick = () => call("DELETE", `/api/conectores/${button.dataset.rmcon}`).then(() => load()).catch((err) => banner(err.message));
      });
      doc.querySelectorAll("[data-cancel]").forEach((button) => {
        button.onclick = () => call("POST", `/api/conectores/${button.dataset.cancel}/cancelar`, {}).then(() => load()).catch((err) => banner(err.message));
      });
      const login = $("cursorLogin");
      if (login) login.onclick = () => call("POST", "/api/accounts/login", {}).then(() => load()).catch((err) => banner(err.message));
      const local = $("cursorLocal");
      if (local) local.onclick = () => call("POST", "/api/accounts/login/local", {}).then(() => { banner("Usei o login que já estava neste computador."); return load(); }).catch((err) => banner(err.message));
      const key = $("cursorKey");
      if (key) key.onclick = () => call("POST", "/api/accounts/chave", {}).then(() => pasteSoon()).catch((err) => banner(err.message));
    }

    function pasteSoon() {
      let left = 30;
      const tick = () => call("POST", "/api/accounts/colar", {}).then((result) => {
        if (result.found && result.account) { banner("Chave conferida e guardada no cofre."); return load(); }
        if (result.found && result.error) { banner(result.error); return null; }
        if (--left > 0) setTimeout(tick, 2000);
        else banner("Não vi uma chave do Cursor na área de transferência. Cole na aba Conta Cursor se preferir.");
        return null;
      }).catch((err) => banner(err.message));
      tick();
    }

    return { load, stop: () => clearInterval(timer), galleryHtml, presetCard, cursorCard };
  }

  const api = { create, galleryHtml, presetCard, cursorCard };
  if (typeof module === "object" && module.exports) module.exports = api;
  else window.HeliosConectores = api;
})();
