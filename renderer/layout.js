/* global state, call, setView, renderChat, esc */
// LEVA F: layout no estilo Grok Bot. Sidebar (assistentes + conversas), painel direito e modal de Ajustes.
// Não troca a lógica das telas: só move #view entre o centro e o modal e chama setView().
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  // LEVA O2: básico = conta/aparência/autonomia; restante em Avançado.
  const SETTINGS_BASIC = ["account", "aparencia", "autonomy"];
  const SETTINGS_ADV = ["context", "memory", "routines", "gatilhos", "vagas", "vault", "mcp", "ditado", "activity", "reuniao", "time"];
  const SETTINGS = [...SETTINGS_BASIC, ...SETTINGS_ADV];
  const root = document.documentElement;
  let lastMain = "chefe";
  let settingsOpen = false;
  let rightTab = localStorage.getItem("helios-right-tab") || "detalhes";

  // ---------- tema ----------
  function theme() { return root.getAttribute("data-theme") === "light" ? "light" : "dark"; }
  function setTheme(next) {
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("helios-theme", next); } catch { /* sem storage */ }
    if (window.helios && typeof window.helios.setTheme === "function") { try { window.helios.setTheme(next); } catch { /* ok */ } }
    document.querySelectorAll(".sb-js-theme").forEach((b) => {
      b.setAttribute("aria-label", `Alternar tema (atual: ${next === "light" ? "claro" : "escuro"})`);
      const use = b.querySelector("use");
      if (use) use.setAttribute("href", next === "light" ? "#i-sun" : "#i-moon");
    });
    paintAppearance();
  }
  document.querySelectorAll(".sb-js-theme").forEach((b) => { b.onclick = () => setTheme(theme() === "light" ? "dark" : "light"); });

  // ---------- navegação ----------
  function go(view) {
    if (SETTINGS.includes(view) && view !== "vagas") return openSettings(view);
    if (settingsOpen) closeSettings(false);
    lastMain = view;
    setView(view);
    paintSide();
  }
  window.HeliosLayout = { go, newChat, openSettings: (v) => openSettings(v), closeSettings: (restore = true) => closeSettings(restore), setTheme, paintSide };

  // ---------- modal de Ajustes ----------
  function openSettings(requested) {
    const v = SETTINGS.includes(requested) ? requested : "account";
    const modal = $("lfModal");
    if (!settingsOpen) { lastMain = state.view && !SETTINGS.includes(state.view) ? state.view : lastMain; }
    settingsOpen = true;
    modal.hidden = false;
    // LEVA O2: abre o bloco Avançado se o item estiver lá.
    const adv = $("lfAdv");
    if (adv) adv.open = SETTINGS_ADV.includes(v);
    document.querySelectorAll("#lfMnav [data-set]").forEach((b) => b.classList.toggle("on", b.dataset.set === v));
    const body = $("lfModalBody");
    const view = $("view");
    $("lfMeeting").hidden = v !== "reuniao";
    if (v === "aparencia" || v === "reuniao") {
      view.hidden = true;
      $("lfAppearance").hidden = v !== "aparencia";
      if (v === "aparencia") paintAppearance(); else paintMeeting();
    } else {
      $("lfAppearance").hidden = true;
      view.hidden = false;
      if (view.parentElement !== body) body.appendChild(view);
      body.dataset.set = v;
      setView(v);
    }
    const on = document.querySelector("#lfMnav .on");
    if (on && document.activeElement && !modal.contains(document.activeElement)) on.focus();
  }
  function closeSettings(restore) {
    const view = $("view");
    $("lfModal").hidden = true;
    settingsOpen = false;
    view.hidden = false;
    $("viewHost").appendChild(view);
    if (restore) { setView(lastMain || "chefe"); paintSide(); }
  }
  $("lfSettings").onclick = () => openSettings("account");
  $("lfModalClose").onclick = () => closeSettings(true);
  $("lfModal").addEventListener("mousedown", (e) => { if (e.target === $("lfModal")) closeSettings(true); });
  document.querySelectorAll("#lfMnav [data-set]").forEach((b) => { b.onclick = () => openSettings(b.dataset.set); });

  function paintAppearance() {
    const box = $("lfAppearance");
    if (!box || box.hidden) return;
    const t = theme();
    box.innerHTML = `<h2>Aparência</h2>
      <div class="lf-themes">
        <button type="button" class="lf-theme lf-theme-dark${t === "dark" ? " on" : ""}" data-theme-pick="dark" title="Preto com dourado"><span class="lf-sw"></span>Escuro</button>
        <button type="button" class="lf-theme lf-theme-light${t === "light" ? " on" : ""}" data-theme-pick="light" title="Branco com dourado"><span class="lf-sw"></span>Claro</button>
      </div>`;
    box.querySelectorAll("[data-theme-pick]").forEach((b) => { b.onclick = () => setTheme(b.dataset.themePick); });
  }

  // ---------- Ajustes › Reunião (Leva H: saiu da janela flutuante) ----------
  const MEET_FIELDS = [
    ["captureMic", "Captar meu microfone (Você)", "check"],
    ["translate", "Tradução ao vivo no modo EN", "check"],
    ["chunkSeconds", "Bloco de áudio (s)", "number", 3, 15],
    ["meetingLang", "Idioma do áudio", "select", ["auto", "en", "pt"]],
    ["provider", "Provedor", "select", ["groq", "gemini"]],
    ["formality", "Tom", "select", ["neutro", "formal", "informal"]],
    ["translateHistory", "Falas anteriores na tradução", "number", 0, 6],
    ["opacity", "Opacidade", "number", 0.3, 1],
    ["myContext", "Minhas instruções", "text"],
    ["meetingContext", "Contexto da reunião", "text"],
  ];
  async function paintMeeting() {
    const box = $("lfMeeting");
    if (!box || box.hidden || !window.helios || typeof window.helios.meetingSettings !== "function") return;
    let s = {};
    try { s = await window.helios.meetingSettings(); } catch { /* sem janela de reunião */ }
    const row = ([k, label, kind, a, b]) => {
      const v = s[k];
      if (kind === "check") return `<label class="lf-mrow"><span>${esc(label)}</span><input type="checkbox" data-mk="${k}"${v ? " checked" : ""}></label>`;
      if (kind === "select") return `<label class="lf-mrow"><span>${esc(label)}</span><select data-mk="${k}">${a.map((o) => `<option${o === v ? " selected" : ""}>${o}</option>`).join("")}</select></label>`;
      if (kind === "number") return `<label class="lf-mrow"><span>${esc(label)}</span><input type="number" data-mk="${k}" min="${a}" max="${b}" step="${b <= 1 ? 0.05 : 1}" value="${esc(v ?? "")}"></label>`;
      return `<label class="lf-mrow lf-mcol"><span>${esc(label)}</span><textarea rows="2" data-mk="${k}">${esc(v || "")}</textarea></label>`;
    };
    box.innerHTML = `<h2>Reunião</h2>
      <label class="lf-mrow"><span>Chave da Groq${s.hasGroqKey ? " (salva)" : ""}</span><input type="password" data-mkey="groqKey" autocomplete="off"></label>
      <label class="lf-mrow"><span>Chave do Gemini${s.hasGeminiKey ? " (salva)" : ""}</span><input type="password" data-mkey="geminiKey" autocomplete="off"></label>
      ${MEET_FIELDS.map(row).join("")}
      <div class="lf-mrow"><span id="lfMeetMsg"></span><span><button type="button" id="lfMeetTest">Testar</button> <button type="button" id="lfMeetSave">Salvar</button></span></div>`;
    $("lfMeetSave").onclick = async () => {
      const patch = {};
      box.querySelectorAll("[data-mk]").forEach((el) => { patch[el.dataset.mk] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value; });
      box.querySelectorAll("[data-mkey]").forEach((el) => { if (el.value.trim()) patch[el.dataset.mkey] = el.value.trim(); });
      try { await window.helios.meetingSettingsSet(patch); $("lfMeetMsg").textContent = "Salvo."; } catch (e) { $("lfMeetMsg").textContent = String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""); }
    };
    $("lfMeetTest").onclick = async () => {
      const r = await window.helios.meetingTestKeys();
      $("lfMeetMsg").textContent = r && r.ok ? Object.values(r.result || {}).join(" · ") || "Sem chave." : (r && r.error) || "Falhou.";
    };
  }

  // ---------- menu "+" ----------
  const menu = $("lfMenu");
  $("lfNewMenu").onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; $("lfNewMenu").setAttribute("aria-expanded", String(!menu.hidden)); };
  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
  menu.querySelectorAll("[data-lf-go]").forEach((b) => { b.addEventListener("click", () => { menu.hidden = true; go(b.dataset.lfGo); }); });

  function newChat(assistantId) {
    state.current = null;
    if (assistantId) state.assistantId = assistantId;
    if (settingsOpen) closeSettings(false);
    lastMain = "chat";
    if (state.view !== "chat") setView("chat"); else renderChat();
    paintSide();
    setTimeout(() => { const d = $("draft"); if (d) d.focus(); }, 30);
  }
  $("lfNew").onclick = () => newChat();
  $("lfNewChat").onclick = () => { menu.hidden = true; newChat(); };

  // ---------- sidebar: assistentes e conversas ----------
  let filter = "";
  $("lfSearch").addEventListener("input", (e) => { filter = e.target.value.trim().toLowerCase(); paintSide(); });

  function dayLabel(ts) {
    if (!ts) return "Antes";
    const d = new Date(ts); const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (d.getTime() >= start) return "Hoje";
    if (d.getTime() >= start - 86400000) return "Ontem";
    if (d.getTime() >= start - 6 * 86400000) return "7 dias";
    return "Antes";
  }
  function ico(id) { return `<svg class="sb-ico" aria-hidden="true"><use href="#${id}"/></svg>`; }

  function paintSide() {
    const list = Array.isArray(state.assistants) ? state.assistants : [];
    const fixed = [
      { key: "default", name: "HELIOS", icon: "i-spark", tip: "Assistente principal" },
      { key: "@vagas", name: "Vagas", icon: "i-briefcase", tip: "Vagas e candidaturas" },
    ];
    // Leva G: o assistente Vagas é o mesmo item fixo "Vagas" (abre o painel; dali dá para conversar).
    const mine = list.filter((a) => a && a.id && a.id !== "default" && a.id !== "vagas" && a.id !== "chefe").map((a) => ({ key: a.id, name: a.name || a.id, icon: "i-bot", tip: a.description || a.role || a.name || "" }));
    // LEVA K: com agente aberto, nenhum assistente fica com a barra ouro (só o item do agente em #lfAgents).
    const chatOn = state.view === "chat" && !settingsOpen;
    const agentOn = state.view === "agente";
    const chefeOn = state.view === "chefe" && !settingsOpen;
    document.querySelectorAll(".lf-foot [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view && !settingsOpen));
    const rows = fixed.concat(mine).filter((a) => !filter || a.name.toLowerCase().includes(filter)).map((a) => {
      const on = !agentOn && !chefeOn && ((a.key === "@vagas" && state.view === "vagas" && !settingsOpen) || (a.key === "@search" && state.view === "search") || (chatOn && !state.current && state.assistantId === a.key));
      return `<button type="button" class="lf-it${on ? " on" : ""}" data-lf-asst="${esc(a.key)}" title="${esc(a.tip)}">${ico(a.icon)}<span>${esc(a.name)}</span></button>`;
    }).join("");
    $("lfAssistants").innerHTML = rows;
    const convs = (state.conversations || []).filter((c) => !filter || `${c.title || ""} ${c.preview || ""}`.toLowerCase().includes(filter));
    const groups = {};
    convs.forEach((c) => { const g = dayLabel(c.updatedAt || c.createdAt); (groups[g] = groups[g] || []).push(c); });
    const cur = state.current && chatOn ? state.current.id : "";
    $("lfConvs").innerHTML = ["Hoje", "Ontem", "7 dias", "Antes"].filter((g) => groups[g]).map((g) => `<p class="lf-lbl">${g}</p>${groups[g].map((c) => {
      const busy = c.busy || c.running || c.status === "running";
      const st = busy ? "working" : c.status || "done";
      const stTip = { working: "Trabalhando", waiting: "Aguardando você", done: "Concluído", new: "Novo" }[st] || "";
      const name = !c.title ? "Nova conversa" : c.title;
      return `<div class="lf-agent${c.id === cur ? " on" : ""}"><button type="button" class="lf-it lf-conv${c.id === cur ? " on" : ""}" data-lf-conv="${esc(c.id)}" title="${esc(c.preview || "")}"><i class="lf-st lf-st-${st}" title="${stTip}" aria-label="${stTip}"></i><span>${esc(name)}</span></button>${busy ? "" : `<button type="button" class="lf-del" data-lf-del="${esc(c.id)}" title="Apagar" aria-label="Apagar ${esc(name)}"><svg class="sb-ico"><use href="#i-trash"/></svg></button>`}</div>`;
    }).join("")}`).join("") || (filter ? `<p class="lf-none">Nada encontrado</p>` : "");
    $("lfAssistants").querySelectorAll("[data-lf-asst]").forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.lfAsst;
        if (k === "@vagas") return go("vagas");
        if (k === "@search") return go("search");
        newChat(k);
      };
    });
    $("lfConvs").querySelectorAll("[data-lf-conv]").forEach((b) => { b.onclick = () => openConv(b.dataset.lfConv); });
    $("lfConvs").querySelectorAll("[data-lf-del]").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); delConv(b.dataset.lfDel); }; });
  }

  // Apagar com desfazer: o servidor move para o arquivo de arquivados; "Desfazer" traz de volta.
  let toastTimer = null;
  async function delConv(id) {
    const conv = (state.conversations || []).find((c) => c.id === id);
    try { await call("DELETE", `/api/conversations/${encodeURIComponent(id)}`); } catch (err) { if (typeof window.bannerLf === "function") window.bannerLf(err.message); return; }
    state.conversations = (state.conversations || []).filter((c) => c.id !== id);
    if (state.current && state.current.id === id) { state.current = null; if (state.view === "chat" && !settingsOpen) renderChat(); }
    paintSide();
    const t = $("lfToast");
    $("lfToastMsg").textContent = `"${(conv && conv.title && conv.title !== "Nova conversa") ? conv.title.slice(0, 40) : "Agente"}" apagado`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
    $("lfToastUndo").onclick = async () => {
      t.hidden = true; clearTimeout(toastTimer);
      try { await call("POST", `/api/conversations/${encodeURIComponent(id)}/restore`); } catch { /* ja voltou */ }
      refreshConvs();
    };
  }

  async function openConv(id) {
    if (settingsOpen) closeSettings(false);
    lastMain = "chat";
    try {
      const data = await call("GET", `/api/conversations/${encodeURIComponent(id)}`);
      state.current = data.conversation;
      if (state.view !== "chat") setView("chat"); else renderChat();
    } catch (err) { if (typeof window.bannerLf === "function") window.bannerLf(err.message); }
    paintSide();
  }

  async function refreshConvs() {
    if (document.hidden) return;
    try {
      const data = await call("GET", "/api/conversations");
      state.conversations = data.conversations || [];
      if (!state.assistants || !state.assistants.length) {
        const a = await call("GET", "/api/assistants").catch(() => null);
        if (a && a.assistants) state.assistants = a.assistants;
      }
      paintSide();
    } catch { /* servidor ainda subindo */ }
  }
  document.addEventListener("helios:chat", paintSide);
  setInterval(refreshConvs, 3000);
  refreshConvs();

  // ---------- painel direito ----------
  const right = $("lfRight");
  const PANEL_KEY = "helios-right-v1";
  function setPanel(open) {
    document.body.classList.toggle("lf-right-off", !open);
    $("lfPanelToggle").setAttribute("aria-expanded", String(open));
    try { localStorage.setItem(PANEL_KEY, open ? "1" : "0"); } catch { /* ok */ }
    if (open) paintRight();
  }
  // Hotfix layout: abaixo de 1100px o painel vira gaveta sobreposta (nao rouba largura do chat).
  const narrowMq = window.matchMedia("(max-width: 1100px)");
  function setDrawer(open) {
    document.body.classList.toggle("lf-right-drawer", open);
    $("lfPanelToggle").setAttribute("aria-expanded", String(open));
    if (open) { document.body.classList.remove("lf-right-off"); paintRight(); }
    else if (localStorage.getItem(PANEL_KEY) === "0") document.body.classList.add("lf-right-off");
  }
  narrowMq.addEventListener("change", () => { if (!narrowMq.matches) setDrawer(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("lf-right-drawer")) setDrawer(false); });
  document.addEventListener("mousedown", (e) => {
    if (!document.body.classList.contains("lf-right-drawer")) return;
    if (right.contains(e.target) || $("lfPanelToggle").contains(e.target)) return;
    setDrawer(false);
  });
  $("lfPanelToggle").onclick = () => {
    if (narrowMq.matches) return setDrawer(!document.body.classList.contains("lf-right-drawer"));
    setPanel(document.body.classList.contains("lf-right-off"));
  };
  // LEVA P3: painel de detalhes oculto por padrão (abre pelo botão do topo).
  setPanel(localStorage.getItem(PANEL_KEY) === "1");
  right.querySelectorAll("[data-lf-tab]").forEach((b) => { b.onclick = () => { rightTab = b.dataset.lfTab; localStorage.setItem("helios-right-tab", rightTab); paintRight(); }; });

  function sec(title, inner, more) {
    return `<section class="lf-sec"><header><h3>${title}</h3>${more || ""}</header>${inner}</section>`;
  }
  async function paintRight() {
    if (document.body.classList.contains("lf-right-off")) return;
    right.querySelectorAll("[data-lf-tab]").forEach((b) => b.classList.toggle("on", b.dataset.lfTab === rightTab));
    const body = $("lfRightBody");
    const tab = rightTab;
    let html = "";
    try {
      if (tab === "detalhes") {
        // LEVA O2: no Chefe o painel resume quadro + agentes (inbox/parking fundidos no resumo).
        const [inbox, routines, vagas, chefe] = await Promise.all([
          call("GET", "/api/inbox").catch(() => null),
          call("GET", "/api/routines").catch(() => null),
          call("GET", "/api/vagas").catch(() => null),
          call("GET", "/api/chefe").catch(() => null),
        ]);
        if (chefe) {
          // LEVA O9: na tela do Chefe os 4 cartões já estão no centro — não duplicar AGENTES.
          if (state.view !== "chefe") {
            const agentes = Array.isArray(chefe.agentes) ? chefe.agentes : [];
            const usoTxt = (a) => (a.usoPct == null ? "" : `Uso ${a.usoPct}%`);
            html += sec("Agentes", agentes.length ? agentes.map((a) => `<button type="button" class="lf-row" data-lf-go="chefe"><i class="lf-dot${a.pausado ? " off" : ""}"></i>${esc(a.nome)} <small>${esc(a.status || "")}${usoTxt(a) ? ` · ${esc(usoTxt(a))}` : ""}</small></button>`).join("") : `<p class="lf-none">Sem agentes</p>`, `<button type="button" class="lf-link" data-lf-go="chefe">Chefe</button>`);
          }
          if (chefe.ultimoResumo) html += sec("Resumo do Chefe", `<p class="lf-none">${esc(chefe.ultimoResumo)}</p>`);
        }
        const busy = (state.conversations || []).filter((c) => c.busy || c.running || c.status === "running");
        html += sec("Em andamento", busy.length ? busy.map((c) => `<button type="button" class="lf-row" data-lf-conv="${esc(c.id)}"><i class="lf-dot"></i>${esc(c.title || "Conversa")}</button>`).join("") : `<p class="lf-none">Nada agora</p>`);
        // LEVA L/O2: aprovações + handoffs (também no Chefe); atalho vai ao Chefe.
        const items = inbox && Array.isArray(inbox.items) ? inbox.items : [];
        const waitingCount = typeof inbox?.count === "number" ? inbox.count : items.length;
        const pendChefe = Array.isArray(chefe?.pendenciasAprovacao) ? chefe.pendenciasAprovacao.length : 0;
        html += sec("Aguardando você", items.length ? items.slice(0, 5).map((it) => `<button type="button" class="lf-row" data-lf-go="chefe">${esc(String(it.summary || it.title || it.question || it.pergunta || it.kind || "Pendência").slice(0, 80))}</button>`).join("") : `<p class="lf-none">Nada pendente</p>`, `<span class="lf-count" id="lfWaitingCount">${waitingCount + pendChefe}</span>`);
        const rs = routines && Array.isArray(routines.routines) ? routines.routines : [];
        html += sec("Rotinas", rs.length ? rs.slice(0, 5).map((r) => `<button type="button" class="lf-row" data-lf-set="routines">${esc(r.title || r.name || r.prompt || "Rotina")}${r.enabled === false ? ` <small>pausada</small>` : ""}</button>`).join("") : `<p class="lf-none">Nenhuma</p>`, `<button type="button" class="lf-link" data-lf-set="routines">Ver</button>`);
        const crit = vagas && Array.isArray(vagas.criticas) ? vagas.criticas : null;
        if (crit) html += sec("Vagas", crit.length ? crit.slice(0, 4).map((v) => `<button type="button" class="lf-row" data-lf-go="vagas">${esc(v.title || v.titulo || "Vaga")}</button>`).join("") : `<p class="lf-none">Sem pendências críticas</p>`, `<button type="button" class="lf-link" data-lf-go="vagas">Abrir</button>`);
      } else if (tab === "biblioteca") {
        const data = await call("GET", "/api/brain").catch(() => null);
        const notes = data && Array.isArray(data.notes) ? data.notes : [];
        html += sec("Second Brain", notes.length ? notes.slice(0, 12).map((n) => `<button type="button" class="lf-row" data-lf-go="brain">${n.pinned ? `<svg class="sb-ico hx-inline" aria-label="Fixada"><use href="#i-pin"/></svg> ` : ""}${esc(n.title)}</button>`).join("") : `<p class="lf-none">Nenhuma nota</p>`, `<button type="button" class="lf-link" data-lf-go="brain">Abrir</button>`);
      } else {
        const data = await call("GET", "/api/atividade").catch(() => null);
        const helpers = data && Array.isArray(data.helpers) ? data.helpers.slice().reverse() : [];
        html += sec("Atividade", helpers.length ? helpers.slice(0, 10).map((h) => `<div class="lf-row lf-static" title="${esc(h.task || h.goal || "")}"><i class="lf-dot${h.status === "running" ? "" : " off"}"></i>${esc(String(h.name || h.title || h.task || h.goal || "Ajudante").slice(0, 70))}</div>`).join("") : `<p class="lf-none">Nenhuma</p>`, `<button type="button" class="lf-link" data-lf-set="activity">Ver tudo</button>`);
      }
    } catch { html = `<p class="lf-none">Indisponível</p>`; }
    if (tab !== rightTab) return;
    body.innerHTML = html;
    body.querySelectorAll("[data-lf-conv]").forEach((b) => { b.onclick = () => openConv(b.dataset.lfConv); });
    body.querySelectorAll("[data-lf-go]").forEach((b) => { b.onclick = () => go(b.dataset.lfGo); });
    body.querySelectorAll("[data-lf-set]").forEach((b) => { b.onclick = () => openSettings(b.dataset.lfSet); });
  }
  setInterval(() => { if (!document.hidden) paintRight(); }, 8000);

  // ---------- sem textos explicativos: parágrafos longos viram dica no hover ----------
  // LEVA N4/N4b: bloco de conta (card de uso, fallback, caption) nunca vira "Saiba mais"/lf-explain.
  // Causa do ▼ no fallback: <details open> sem <summary> (marcador anônimo). Render N4b usa <div>.
  function tidy(rootEl) {
    rootEl.querySelectorAll("p.muted:not([id]), p.hint:not([id]), .lead:not([id])").forEach((p) => {
      if (p.dataset.lfTidy) return;
      const text = p.textContent.trim();
      if (text.length < 70 || p.closest(".msg, .message, .bubble, .status-line, .connect-account, form, .acct, #accountList, #keyForm, .acct-uso, .acct-limit-wrap, .acct-head")) return;
      if (p.classList.contains("acct-bar-label") || p.classList.contains("acct-secondary") || p.classList.contains("acct-pools") || p.classList.contains("acct-me") || p.classList.contains("acct-uso-cap") || p.classList.contains("acct-uso-renew") || p.classList.contains("acct-uso-title") || p.classList.contains("acct-uso-fail-msg") || p.classList.contains("acct-uso-fail-reason")) return;
      p.dataset.lfTidy = "1";
      let h = p.previousElementSibling;
      while (h && !/^H[1-4]$/.test(h.tagName)) h = h.previousElementSibling;
      if (!h) { const sec2 = p.parentElement && p.parentElement.querySelector("h1,h2,h3,h4"); h = sec2; }
      if (h && !h.title) h.title = text;
      p.classList.add("lf-explain");
    });
    // LEVA N4b: se algo criar details/summary "Saiba mais" (ou details sem summary) dentro de .acct, desfaz.
    rootEl.querySelectorAll(".acct details, #accountList details").forEach((d) => {
      if (d.classList.contains("acct-replace") || d.classList.contains("acct-key") || d.classList.contains("acct-mcp")) return;
      const sum = d.querySelector(":scope > summary") || [...d.children].find((c) => c.tagName === "SUMMARY");
      if (!sum) {
        const kids = [...d.childNodes];
        d.replaceWith(...kids);
        return;
      }
      if (/^\s*▼?\s*Saiba mais\s*$/i.test(sum.textContent || "")) {
        sum.remove();
        d.replaceWith(...[...d.childNodes]);
      }
    });
  }
  // Conectores: abas Todos / Conectados / Personalizado (MCP). Só visual; a lógica continua em conectores.js.
  let ctab = "todos";
  function connectTabs(rootEl) {
    const screen = rootEl.querySelector(".connect-screen");
    if (!screen) return;
    if (!screen.querySelector(".connect-tabs")) {
      const bar = document.createElement("div");
      bar.className = "connect-tabs";
      bar.setAttribute("role", "tablist");
      bar.innerHTML = [["todos", "Todos"], ["conectados", "Conectados"], ["mcp", "Personalizado (MCP)"]].map(([k, l]) => `<button type="button" role="tab" data-ctab="${k}">${l}</button>`).join("");
      const search = screen.querySelector(".connect-search");
      if (search) search.after(bar); else screen.prepend(bar);
      bar.querySelectorAll("[data-ctab]").forEach((b) => { b.onclick = () => { ctab = b.dataset.ctab; applyCtab(screen); }; });
    }
    applyCtab(screen);
  }
  function applyCtab(screen) {
    screen.querySelectorAll("[data-ctab]").forEach((b) => b.classList.toggle("on", b.dataset.ctab === ctab));
    const live = screen.querySelector(".connect-live-wrap");
    const grid = screen.querySelector(".connect-grid");
    const catalog = grid ? grid.closest("section") : null;
    const adv = screen.querySelector(".connect-advanced");
    const panel = $("connectAdvancedPanel");
    const set = (el, hide) => { if (el) { if (hide) el.setAttribute("data-lf-ctab-hide", ""); else el.removeAttribute("data-lf-ctab-hide"); } };
    set(live, ctab === "mcp");
    set(catalog, ctab !== "todos");
    set(adv, ctab !== "todos");
    if (panel && ctab === "mcp") panel.hidden = false;
  }
  let busyObs = false;
  new MutationObserver(() => {
    if (busyObs) return;
    busyObs = true;
    try { tidy($("view")); connectTabs($("view")); } finally { busyObs = false; }
  }).observe($("view"), { childList: true, subtree: true });

  // ---------- atalhos ----------
  document.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (e.key === "Escape") {
      if (!menu.hidden) { menu.hidden = true; return; }
      if (settingsOpen) { closeSettings(true); return; }
    }
    if (!e.ctrlKey && !e.metaKey) return;
    if (k === "k") { e.preventDefault(); $("lfSearch").focus(); }
    else if (k === "n" && !e.shiftKey) { e.preventDefault(); newChat(); }
    else if (k === "," ) { e.preventDefault(); openSettings("account"); }
    else if (k === ".") { e.preventDefault(); $("lfPanelToggle").click(); }
    else if (k === "b") { e.preventDefault(); document.body.classList.toggle("lf-side-off"); }
    else if (k === "l" && e.shiftKey) { e.preventDefault(); setTheme(theme() === "light" ? "dark" : "light"); }
  });

  setTheme(theme());
  paintSide();
})();
