"use strict";

/* Galeria de conectores. O HTML é puro para o teste; a tela só chama a API local.
   Nenhum campo de client id, chave ou URL fica nesta grade. */

(function () {
  const STATE = {
    connected: ["live", "conectado"],
    waiting: ["warn", "conectando…"],
    reauth: ["warn", "reautenticar"],
    error: ["bad", "erro"],
  };

  function mark(id) {
    const svg = {
      gmail: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#fff"/><path fill="#EA4335" d="M8 14h32v4L24 28 8 18z"/><path fill="#C5221F" d="M8 18v16h8V24l8 6 8-6v10h8V18L24 30z"/><path fill="#FBBC04" d="M8 14l16 12V18z"/><path fill="#34A853" d="M40 14 24 26V18z"/><path fill="#4285F4" d="M16 24v10H8V18z"/><path fill="#1967D2" d="M40 18v16h-8V24z"/></svg>`,
      gcalendar: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#1A73E8"/><rect x="10" y="12" width="28" height="26" rx="3" fill="#fff"/><path fill="#1A73E8" d="M10 18h28v-3a3 3 0 0 0-3-3H13a3 3 0 0 0-3 3z"/><path fill="#EA4335" d="M16 8h4v6h-4zM28 8h4v6h-4z"/><text x="24" y="34" text-anchor="middle" font-size="12" font-family="Georgia, serif" fill="#1A73E8" font-weight="700">31</text></svg>`,
      gdrive: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#fff"/><path fill="#FFBA00" d="M18.2 10h11.6l9.2 16H27.4z"/><path fill="#00AC47" d="M9 34.5 14.2 26h18.4l-5.2 8.5z"/><path fill="#2684FC" d="M9 34.5 18.2 10h6.4L15.6 34.5z"/></svg>`,
      clickup: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#7B68EE"/><path fill="#fff" d="M14 26.5 24 34l10-7.5-2.2-2.4L24 29.2l-7.8-5.1z"/><path fill="#49CCF9" d="M16.5 22.2 24 16l7.5 6.2 2.3-2.5L24 11.2 14.2 19.7z"/></svg>`,
      github: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#181717"/><path fill="#fff" d="M24 10c-7.2 0-13 5.8-13 13 0 5.7 3.7 10.6 8.8 12.3.6.1.9-.3.9-.6v-2.2c-3.6.8-4.3-1.5-4.3-1.5-.6-1.5-1.4-1.9-1.4-1.9-1.2-.8.1-.8.1-.8 1.3.1 2 1.3 2 1.3 1.1 2 3 1.4 3.7 1.1.1-.8.4-1.4.8-1.7-2.9-.3-5.9-1.4-5.9-6.4 0-1.4.5-2.6 1.3-3.5-.1-.3-.6-1.6.1-3.4 0 0 1.1-.3 3.6 1.3a12 12 0 0 1 6.6 0c2.5-1.6 3.6-1.3 3.6-1.3.7 1.8.2 3.1.1 3.4.8.9 1.3 2.1 1.3 3.5 0 5-3 6.1-5.9 6.4.5.4.9 1.1.9 2.3v3.4c0 .3.2.7.9.6A13 13 0 0 0 37 23c0-7.2-5.8-13-13-13z"/></svg>`,
      vercel: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#000"/><path fill="#fff" d="M24 12 38 36H10z"/></svg>`,
      figma: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#1E1E1E"/><circle cx="19" cy="14" r="5" fill="#F24E1E"/><circle cx="29" cy="14" r="5" fill="#FF7262"/><circle cx="19" cy="24" r="5" fill="#A259FF"/><circle cx="29" cy="24" r="5" fill="#1ABCFE"/><circle cx="19" cy="34" r="5" fill="#0ACF83"/></svg>`,
      notion: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#fff"/><path fill="#111" d="M15 10h6.2l7.6 22.2V10H35v28h-6.1L21.2 15.4V38H15z"/></svg>`,
      slack: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#fff"/><path fill="#E01E5A" d="M20 12a4 4 0 0 0-4 4v4h4a4 4 0 0 0 0-8z"/><path fill="#36C5F0" d="M36 20a4 4 0 0 0-4-4h-4v4a4 4 0 0 0 8 0z"/><path fill="#2EB67D" d="M28 36a4 4 0 0 0 4-4v-4h-4a4 4 0 0 0 0 8z"/><path fill="#ECB22E" d="M12 28a4 4 0 0 0 4 4h4v-4a4 4 0 0 0-8 0z"/></svg>`,
      linear: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#5E6AD2"/><path fill="#fff" d="M14 34 34 14v4.5L18.5 34zM14 26.5 26.5 14H31L14 31z"/></svg>`,
      cursor: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#111"/><path fill="#fff" d="M16 12h8.5L34 34h-6.2l-2.2-5.4h-9.2L14.2 34H8z"/><path fill="#E0B44A" d="M20.2 16.5 16.6 25.2h7.2z"/></svg>`,
    };
    return svg[id] || `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#E0B44A"/></svg>`;
  }

  function cardState(preset, mine, cursor) {
    if (preset.configured === false && (preset.setup === "google" || preset.setup === "github")) return "setup";
    if (preset.configured === false) return "soon";
    if (preset.id === "cursor") {
      if (cursor && cursor.login && cursor.login.status === "waiting") return "waiting";
      if (cursor && cursor.accounts && cursor.accounts.length) return "connected";
      if (cursor && cursor.login && (cursor.login.needsKey || cursor.login.status === "error")) return "error";
      return "idle";
    }
    if (mine.some((item) => item.status === "waiting")) return "waiting";
    if (mine.some((item) => item.status === "connected")) return "connected";
    if (mine.some((item) => item.status === "reauth")) return "reauth";
    if (mine.some((item) => item.status === "error")) return "error";
    return "idle";
  }

  function buttonLabel(state, preset, mine, oauthMcpUi) {
    if (state === "soon") return ["Em breve", true];
    if (state === "setup") return ["Configurar", false];
    if (state === "waiting") return ["Conectando…", true];
    if (state === "connected") {
      const hint = (mine.find((m) => m.status === "connected") || {}).accountHint || "";
      return [hint ? `Conectado como ${hint}` : "Conectado", true];
    }
    if (state === "reauth") return ["Reconectar", false];
    // LEVA P3: OAuth MCP incompleto — featured vai para token no Avançado.
    if (oauthMcpUi === false && preset.featured && (preset.id === "clickup" || preset.id === "github" || preset.id === "vercel")) {
      return ["Token no Avançado", false];
    }
    return [preset.enterAs || "Conectar", false];
  }

  function accountRow(preset, item, esc) {
    const chip = STATE[item.status] || ["", item.status];
    const waiting = item.status === "waiting";
    const retry = item.cursor
      ? `<button type="button" class="btn slim" data-cursor-retry="${esc(item.id)}">Reconectar</button>`
      : `<button type="button" class="btn slim" data-retry="${esc(item.id)}">Reconectar</button>`;
    const remove = item.cursor
      ? `<button type="button" class="btn slim danger" data-cursor-rm="${esc(item.id)}">Remover</button>`
      : `<button type="button" class="btn slim danger" data-rmcon="${esc(item.id)}">Remover</button>`;
    const formAttr = item.cursor ? `data-cursor-rename="${esc(item.id)}"` : `data-rename="${esc(item.id)}"`;
    const device = waiting && item.userCode
      ? `<p class="connect-device">Código: <strong>${esc(item.userCode)}</strong>${item.verificationUri ? ` · <a href="#" data-open-url="${esc(item.verificationUri)}">Abrir página</a>` : ""}</p>`
      : "";
    const asHint = item.status === "connected" && item.accountHint
      ? `<p class="muted">Conectado como ${esc(item.accountHint)}</p>`
      : (item.accountHint && item.status !== "connected" ? `<p class="muted">${esc(item.accountHint)}</p>` : "");
    return `<article class="connect-account" data-state="${esc(item.status)}">
      <span class="connect-logo">${mark(preset.id)}</span>
      <div class="connect-account-copy">
        <div class="row"><strong>${esc(preset.name)} — ${esc(item.label)}</strong> <span class="chip ${chip[0]}">${esc(chip[1])}</span></div>
        ${asHint}
        ${device}
        ${item.error ? `<p class="connect-note">${esc(item.error)}</p>` : ""}
        <form class="connect-rename" ${formAttr} hidden>
          <input name="label" value="${esc(item.label)}" maxlength="40" aria-label="Novo nome">
          <button class="btn slim" type="submit">Salvar</button>
        </form>
      </div>
      <div class="connect-actions">
        <button type="button" class="btn slim" data-rename-open>Renomear</button>
        ${waiting ? `<button type="button" class="btn slim" data-cancel="${esc(item.id)}">Cancelar</button>` : retry}
        ${remove}
      </div>
    </article>`;
  }

  function liveHtml(data, esc) {
    const presets = data.presets || [];
    const connections = data.connections || [];
    const cursorAccounts = (data.cursor && data.cursor.accounts) || [];
    const groups = [];
    for (const preset of presets) {
      const mine = preset.id === "cursor"
        ? cursorAccounts.map((account) => ({
          id: account.id,
          label: account.label || "pessoal",
          status: account.issue ? "reauth" : "connected",
          accountHint: account.email || "",
          error: account.issue ? "Esta conta precisa entrar de novo." : "",
          cursor: true,
        }))
        : connections.filter((item) => item.presetId === preset.id);
      if (!mine.length) continue;
      const rows = mine.map((item) => accountRow(preset, item, esc)).join("");
      const add = preset.configured === false
        ? ""
        : `<button type="button" class="btn connect-add" data-add="${esc(preset.id)}">Adicionar outra conta</button>`;
      groups.push(`<div class="connect-group">${rows}${add}</div>`);
    }
    if (!groups.length) return "";
    return `<section class="connect-live-wrap stack"><h2>Conectados</h2>${groups.join("")}</section>`;
  }

  function presetCard(preset, connections, cursor, esc, index, oauthMcpUi) {
    const mine = connections.filter((item) => item.presetId === preset.id);
    const state = cardState(preset, mine, cursor);
    const [label, disabled] = buttonLabel(state, preset, mine, oauthMcpUi);
    const broken = mine.find((item) => item.status === "error" || item.status === "reauth");
    const waiting = mine.find((item) => item.status === "waiting");
    const loginFailed = preset.id === "cursor" && cursor?.login && (cursor.login.status === "error" || cursor.login.needsKey === true);
    const note = state === "soon"
      ? `<p class="connect-note">configuração do app pendente</p>`
      : (loginFailed
        ? `<p class="connect-note">${esc(cursor.login.error || "A entrada não terminou. Tente conectar de novo.")}</p>`
        : (state !== "connected" && broken && broken.error ? `<p class="connect-note">${esc(broken.error)}</p>` : ""));
    const deviceNote = waiting && waiting.userCode
      ? `<p class="connect-device">Código: <strong>${esc(waiting.userCode)}</strong></p>`
      : "";
    const keyButton = loginFailed ? `<button type="button" class="btn" data-keypage>Abrir página de chaves</button>` : "";
    const setup = state === "setup"
      ? (preset.setup === "github" ? githubSetupHtml(preset, esc) : googleSetupHtml(preset, esc))
      : "";
    const compose = preset.id === "gmail" && state !== "setup" && state !== "soon"
      ? `<label class="connect-opt" title="Além de ler, deixa o HELIOS criar rascunhos (nunca envia sozinho)."><input type="checkbox" data-compose> Rascunhos</label>` : "";
    const primaryClass = state === "connected" ? "btn" : "btn primary";
    const oauthOff = oauthMcpUi === false && preset.featured && (preset.id === "clickup" || preset.id === "github" || preset.id === "vercel") && state !== "connected" && state !== "waiting" && state !== "reauth";
    const connectAttr = oauthOff
      ? `data-open-advanced="1"`
      : `data-connect="${esc(preset.id)}"${state === "setup" ? " data-setup-open" : ""}`;
    return `<article class="card connect-card stack" data-preset="${esc(preset.id)}" data-name="${esc(`${preset.name} ${preset.blurb}`)}" data-state="${esc(state)}" style="animation-delay:${index * 40}ms">
      <span class="connect-logo">${mark(preset.id)}</span>
      <h2>${esc(preset.name)}</h2>
      <p>${esc(preset.blurb)}</p>
      ${note}${deviceNote}
      <div class="connect-card-actions">
        <button type="button" class="${primaryClass}" ${connectAttr}${disabled && state !== "reauth" && !oauthOff ? " disabled" : ""}>${esc(label)}</button>
        ${keyButton}${compose}
      </div>
      ${setup}
    </article>`;
  }

  /** Leva G: cartão guiado do Google (client próprio do Helison, guardado no cofre). Texto curto; detalhes no title. */
  function googleSetupHtml(preset, esc) {
    const g = preset.googleSetup || {};
    const prazo = g.prazo ? g.prazo.split("-").reverse().join("/") : "";
    const steps = (g.passos || []).map((p) => `<li>${esc(p)}</li>`).join("");
    return `<form class="connect-setup stack" data-google-setup hidden>
      <ol class="connect-steps">${steps}</ol>
      <p class="connect-setup-link"><a href="#" data-open-url="${esc(g.link || "")}">Abrir Google Cloud</a>
        <span class="chip" title="O Google exige marcar o cliente como agente de IA até ${esc(prazo)}. Sem isso, o login do Gmail para de funcionar.">Agente de IA · até ${esc(prazo)}</span></p>
      <label>ID do cliente<input name="clientId" autocomplete="off" spellcheck="false" required placeholder="….apps.googleusercontent.com"></label>
      <label>Chave secreta<input name="clientSecret" type="password" autocomplete="off" required></label>
      <button class="btn primary" type="submit" title="Fica no cofre deste computador, criptografado.">Salvar no cofre</button>
    </form>`;
  }

  /** Leva P: Client ID do OAuth App GitHub (uma vez; device flow sem secret). */
  function githubSetupHtml(preset, esc) {
    const g = preset.githubSetup || {};
    const steps = (g.passos || []).map((p) => `<li>${esc(p)}</li>`).join("");
    return `<form class="connect-setup stack" data-github-setup hidden>
      <ol class="connect-steps">${steps}</ol>
      <p class="connect-setup-link"><a href="#" data-open-url="${esc(g.link || "")}">Abrir OAuth Apps</a></p>
      <label>Client ID<input name="clientId" autocomplete="off" spellcheck="false" required placeholder="Iv…"></label>
      <button class="btn primary" type="submit" title="Não é segredo; fica no cofre só para reutilizar.">Salvar Client ID</button>
    </form>`;
  }

  function advancedFallbacks(data, esc) {
    const vercelCli = data.vercelCli || {};
    const cliLine = vercelCli.disponivel
      ? `<p class="muted">Vercel CLI: logado como ${esc(vercelCli.user)} (Portfólio pode deployar sem colar token).</p>`
      : `<p class="muted">Vercel CLI: não detectado. <a href="#" data-open-url="https://vercel.com/account/tokens">Abrir tokens</a></p>`;
    return `<div class="card stack connect-advanced-tokens">
      <h2>Tokens manuais</h2>
      <p class="muted">Só se o login pelo navegador não estiver disponível.</p>
      ${cliLine}
      <form class="stack" data-token-preset="github">
        <label>GitHub PAT<input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="ghp_…"></label>
        <button class="btn" type="submit">Salvar GitHub</button>
      </form>
      <form class="stack" data-token-preset="vercel">
        <label>Vercel token<input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="token"></label>
        <button class="btn" type="submit">Salvar Vercel</button>
      </form>
      <form class="stack" data-token-preset="clickup">
        <label>ClickUp token<input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="pk_…"></label>
        <button class="btn" type="submit">Salvar ClickUp</button>
      </form>
      <form class="stack" data-github-client-adv>
        <label>GitHub Client ID (OAuth App)<input name="clientId" autocomplete="off" spellcheck="false" placeholder="Iv…"></label>
        <button class="btn" type="submit">Salvar Client ID</button>
      </form>
    </div>`;
  }

  function galleryHtml(data, esc) {
    const presets = data.presets || [];
    const connections = data.connections || [];
    const oauthMcpUi = data.oauthMcpUi === true;
    // Featured (ClickUp/GitHub/Vercel) primeiro; resto na grade.
    const featured = presets.filter((p) => p.featured);
    const rest = presets.filter((p) => !p.featured);
    const order = featured.length ? [...featured, ...rest] : presets;
    const cards = order.map((item, index) => presetCard(item, connections, data.cursor, esc, index, oauthMcpUi)).join("");
    const oauthNote = oauthMcpUi ? "" : `<p class="muted connect-oauth-off">Login OAuth MCP (ClickUp/GitHub/Vercel) em pausa — use Tokens manuais em Avançado.</p>`;
    return `<div class="stack connect-screen">
      <label class="connect-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 16l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        <input id="connectSearch" type="search" placeholder="Buscar conector" autocomplete="off" aria-label="Buscar conector">
      </label>
      ${oauthNote}
      ${liveHtml(data, esc)}
      <section class="stack">
        <h2 class="connect-catalog-title">Aplicativos</h2>
        <div class="connect-grid">${cards}</div>
        <p class="connect-empty" id="connectEmpty" hidden>Nenhum conector com esse nome.</p>
      </section>
      <p class="connect-advanced"><button type="button" id="connectAdvanced">Avançado</button></p>
      <div id="connectAdvancedPanel" hidden>
        ${advancedFallbacks(data, esc)}
        <form class="card stack" id="mcpForm">
          <h2>Conector personalizado</h2>
          <p class="muted">URL de um servidor MCP. Só use se souber o endereço.</p>
          <label>Nome<input name="name" required placeholder="outro"></label>
          <label>URL<input name="url" required placeholder="https://"></label>
          <input type="hidden" name="type" value="http">
          <button class="btn" type="submit">Adicionar</button>
        </form>
        <div id="mcpManual"></div>
      </div>
    </div>`;
  }

  function create({ call, shell, esc, banner, doc = document, after = null }) {
    let timer = null;
    let manualHtml = "";
    let query = "";
    let advanced = false;
    const $ = (id) => doc.getElementById(id);

    function applyFilter() {
      const q = query.trim().toLowerCase();
      let shown = 0;
      doc.querySelectorAll(".connect-card").forEach((card) => {
        const name = String(card.dataset.name || "").toLowerCase();
        const hide = Boolean(q) && !name.includes(q);
        card.hidden = hide;
        if (!hide) shown += 1;
      });
      const empty = $("connectEmpty");
      if (empty) empty.hidden = !q || shown > 0;
    }

    async function load(servers) {
      if (servers !== undefined) manualHtml = servers;
      const current = $("connectSearch");
      if (current) query = current.value;
      const panel = $("connectAdvancedPanel");
      if (panel) advanced = !panel.hidden;
      const data = await call("GET", "/api/conectores");
      shell(galleryHtml(data, esc));
      const manual = $("mcpManual");
      if (manual) manual.innerHTML = manualHtml;
      const nextPanel = $("connectAdvancedPanel");
      if (nextPanel) nextPanel.hidden = !advanced;
      const box = $("connectSearch");
      if (box) {
        box.value = query;
        box.oninput = () => { query = box.value; applyFilter(); };
      }
      applyFilter();
      bind();
      if (after) after();
      const pending = (data.connections || []).some((item) => item.status === "waiting") || data.cursor?.login?.status === "waiting";
      if (pending) watch();
      else clearInterval(timer);
    }

    function watch() {
      clearInterval(timer);
      timer = setInterval(() => { load().catch((err) => banner(err.message)); }, 1500);
    }

    function connectPreset(id, extra = {}) {
      const request = id === "cursor"
        ? call("POST", "/api/accounts/login", {})
        : call("POST", `/api/conectores/${id}/conectar`, extra);
      return request.then(() => load()).catch((err) => banner(err.message));
    }

    function bind() {
      doc.querySelectorAll("[data-open-advanced]").forEach((button) => {
        button.onclick = () => {
          const pane = $("connectAdvancedPanel");
          if (pane) pane.hidden = false;
          advanced = true;
          const adv = $("connectAdvanced");
          if (adv) adv.scrollIntoView({ block: "nearest" });
        };
      });
      doc.querySelectorAll("[data-connect]").forEach((button) => {
        button.onclick = () => {
          if (button.disabled) return;
          const card = button.closest(".connect-card");
          if (button.hasAttribute("data-setup-open")) {
            const form = card && (card.querySelector("[data-google-setup]") || card.querySelector("[data-github-setup]"));
            if (form) form.hidden = !form.hidden;
            return;
          }
          const compose = card && card.querySelector("[data-compose]");
          connectPreset(button.dataset.connect, compose && compose.checked ? { compose: true } : {});
        };
      });
      doc.querySelectorAll("[data-open-url]").forEach((link) => {
        link.onclick = (event) => {
          event.preventDefault();
          const api = globalThis.helios;
          if (api && api.openExternal) api.openExternal(link.dataset.openUrl);
        };
      });
      doc.querySelectorAll("[data-google-setup]").forEach((form) => {
        form.onsubmit = async (event) => {
          event.preventDefault();
          const data = new FormData(form);
          const id = String(data.get("clientId") || "").trim();
          const secret = String(data.get("clientSecret") || "").trim();
          if (!/\.apps\.googleusercontent\.com$/.test(id)) { banner("Esse ID não parece do Google (termina em .apps.googleusercontent.com)."); return; }
          const api = globalThis.helios;
          if (!api || !api.setKey) { banner("O cofre não está disponível aqui."); return; }
          try {
            const a = await api.setKey("googleClientId", id);
            if (a && a.error) throw new Error(a.error);
            const b = await api.setKey("googleClientSecret", secret);
            if (b && b.error) throw new Error(b.error);
            form.reset();
            await load();
          } catch (err) { banner(err.message || String(err)); }
        };
      });
      doc.querySelectorAll("[data-github-setup], [data-github-client-adv]").forEach((form) => {
        form.onsubmit = async (event) => {
          event.preventDefault();
          const id = String(new FormData(form).get("clientId") || "").trim();
          if (id.length < 8) { banner("Client ID muito curto."); return; }
          const api = globalThis.helios;
          if (!api || !api.setKey) { banner("O cofre não está disponível aqui."); return; }
          try {
            const a = await api.setKey("githubClientId", id);
            if (a && a.error) throw new Error(a.error);
            form.reset();
            await load();
          } catch (err) { banner(err.message || String(err)); }
        };
      });
      doc.querySelectorAll("[data-token-preset]").forEach((form) => {
        form.onsubmit = async (event) => {
          event.preventDefault();
          const token = String(new FormData(form).get("token") || "").trim();
          const preset = form.dataset.tokenPreset;
          if (!token) { banner("Cole um token."); return; }
          try {
            await call("POST", `/api/conectores/${encodeURIComponent(preset)}/token`, { token });
            form.reset();
            await load();
          } catch (err) { banner(err.message || String(err)); }
        };
      });
      doc.querySelectorAll("[data-keypage]").forEach((button) => {
        button.onclick = () => call("POST", "/api/accounts/chave", {}).catch((err) => banner(err.message));
      });
      doc.querySelectorAll("[data-add]").forEach((button) => {
        button.onclick = () => connectPreset(button.dataset.add);
      });
      doc.querySelectorAll("[data-rename]").forEach((form) => {
        form.onsubmit = (event) => {
          event.preventDefault();
          const label = new FormData(form).get("label");
          return call("POST", `/api/conectores/${form.dataset.rename}/renomear`, { label }).then(() => load()).catch((err) => banner(err.message));
        };
      });
      doc.querySelectorAll("[data-cursor-rename]").forEach((form) => {
        form.onsubmit = (event) => {
          event.preventDefault();
          const label = new FormData(form).get("label");
          return call("POST", "/api/accounts/label", { id: form.dataset.cursorRename, label }).then(() => load()).catch((err) => banner(err.message));
        };
      });
      doc.querySelectorAll("[data-rename-open]").forEach((button) => {
        button.onclick = () => {
          const form = button.closest(".connect-account")?.querySelector(".connect-rename");
          if (form) form.hidden = !form.hidden;
        };
      });
      doc.querySelectorAll("[data-rmcon]").forEach((button) => {
        button.onclick = () => call("DELETE", `/api/conectores/${button.dataset.rmcon}`).then(() => load()).catch((err) => banner(err.message));
      });
      doc.querySelectorAll("[data-cursor-rm]").forEach((button) => {
        button.onclick = () => call("DELETE", `/api/accounts/${button.dataset.cursorRm}`).then(() => load()).catch((err) => banner(err.message));
      });
      doc.querySelectorAll("[data-retry]").forEach((button) => {
        button.onclick = () => call("POST", `/api/conectores/${button.dataset.retry}/reconectar`, {}).then(() => load()).catch((err) => banner(err.message));
      });
      doc.querySelectorAll("[data-cursor-retry]").forEach((button) => {
        button.onclick = () => call("POST", "/api/accounts/login", {}).then(() => load()).catch((err) => banner(err.message));
      });
      doc.querySelectorAll("[data-cancel]").forEach((button) => {
        button.onclick = () => call("POST", `/api/conectores/${button.dataset.cancel}/cancelar`, {}).then(() => load()).catch((err) => banner(err.message));
      });
      const advancedButton = $("connectAdvanced");
      if (advancedButton) advancedButton.onclick = () => {
        const pane = $("connectAdvancedPanel");
        if (!pane) return;
        pane.hidden = !pane.hidden;
        advanced = !pane.hidden;
      };
    }

    return { load, stop: () => clearInterval(timer), galleryHtml, presetCard };
  }

  const api = { create, galleryHtml, presetCard, cardState, buttonLabel, githubSetupHtml, advancedFallbacks };
  if (typeof module === "object" && module.exports) module.exports = api;
  else window.HeliosConectores = api;
})();
