"use strict";

const $ = (id) => document.getElementById(id);
const state = { view: "home", meetings: [], current: null, settings: {}, info: {}, draft: null };

function esc(s) { return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function banner(msg, on = true) { $("banner").textContent = msg || ""; $("banner").classList.toggle("hidden", !on || !msg); }
function fmtDur(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function statusLabel(row) {
  if (row.status === "live") return "Ouvindo";
  if (row.status === "paused") return "Pausado";
  if (row.status === "ended") return "Encerrada";
  return "Preparação";
}

async function refresh() {
  state.meetings = await helios.listMeetings();
  renderList();
  if (state.view === "home") renderHome();
  if (state.view === "prep") renderPrep(state.draft);
  if (state.view === "detail" && state.current) {
    state.current = await helios.getMeeting(state.current.id);
    renderDetail(state.current);
  }
}

function renderList() {
  const box = $("list");
  box.innerHTML = "";
  if (!state.meetings.length) {
    box.innerHTML = '<p class="muted">Nenhuma reunião ainda.</p>';
    return;
  }
  for (const row of state.meetings) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "item" + (state.current && state.current.id === row.id ? " on" : "");
    b.innerHTML = `<span>${esc(row.title)}</span><small>${esc(statusLabel(row))} · ${row.lineCount} falas${row.example ? " · exemplo" : ""}</small>`;
    b.onclick = async () => {
      state.current = await helios.getMeeting(row.id);
      state.view = "detail";
      renderDetail(state.current);
      renderList();
    };
    box.appendChild(b);
  }
}

function renderHome() {
  state.view = "home";
  $("view").innerHTML = `
    <h1>Preparar uma reunião</h1>
    <p class="lead">O HELIOS fica no seu computador. Ele não entra na chamada. Você inicia a sessão, avisa as outras pessoas e encerra de verdade — áudio, timers e pedidos à IA param juntos.</p>
    <div class="card">
      <p>Comece pela pauta. Durante a conversa, o painel compacto mostra a transcrição e a ajuda. No fim, o resumo só usa o que foi dito.</p>
      <div class="row"><button type="button" class="secondary" id="goNew">Nova reunião</button></div>
      <p class="muted">A transcrição usa Groq (Whisper). A tela, se você ligar, usa Gemini. Sem chave, o HELIOS avisa — não finge que funcionou.</p>
    </div>`;
  $("goNew").onclick = () => startPrep();
}

function startPrep(base) {
  state.view = "prep";
  state.draft = base || {
    title: "",
    objective: "",
    agenda: "",
    notes: "",
    captureMic: state.settings.captureMic !== false,
    captureSystem: state.settings.captureSystem !== false,
    captureScreen: false,
    consented: false,
  };
  renderPrep(state.draft);
}

function renderPrep(d) {
  $("view").innerHTML = `
    <h1>Antes de começar</h1>
    <p class="lead">Título, objetivo e pauta entram no contexto da sessão. Nada é gravado em nuvem nossa: o áudio vai só ao provedor de transcrição que você configurou, e some da memória ao encerrar.</p>
    <form class="card" id="prep">
      <label class="field">Título<input id="pTitle" maxlength="120" value="${esc(d.title)}" placeholder="Alinhamento semanal"></label>
      <label class="field">Objetivo<textarea id="pObj" maxlength="2000" placeholder="O que precisa ficar decidido">${esc(d.objective)}</textarea></label>
      <label class="field">Pauta<textarea id="pAgenda" maxlength="4000" placeholder="Uma linha por ponto">${esc(d.agenda)}</textarea></label>
      <label class="field">Notas só suas<textarea id="pNotes" maxlength="4000" placeholder="Opcional. Não é lido em voz alta.">${esc(d.notes)}</textarea></label>
      <div class="checks">
        <label class="check"><input type="checkbox" id="pMic" ${d.captureMic ? "checked" : ""}><span>Microfone<small>Sua fala. No Windows, o HELIOS pede permissão do sistema.</small></span></label>
        <label class="check"><input type="checkbox" id="pSys" ${d.captureSystem ? "checked" : ""}><span>Áudio do computador<small>Outras pessoas na call. No Windows usa loopback. No Linux isso costuma falhar: use o microfone com o alto-falante, ou só o que você fala.</small></span></label>
        <label class="check"><input type="checkbox" id="pScreen" ${d.captureScreen ? "checked" : ""}><span>Contexto de tela desta reunião<small>Só a tela, quando você ligar aqui e confirmar o print. Não é um assistente genérico do PC.</small></span></label>
        <label class="check"><input type="checkbox" id="pOk" ${d.consented ? "checked" : ""}><span>Avisei as outras pessoas<small>Transcrever uma conversa sem consentimento pode ser ilegal. O HELIOS não fica invisível de propósito.</small></span></label>
      </div>
      <p class="err hidden" id="pErr"></p>
      <div class="row">
        <button type="submit" class="primary">Iniciar reunião</button>
        <button type="button" class="secondary" id="pSave">Só salvar rascunho</button>
      </div>
    </form>`;
  const read = () => ({
    title: $("pTitle").value,
    objective: $("pObj").value,
    agenda: $("pAgenda").value,
    notes: $("pNotes").value,
    captureMic: $("pMic").checked,
    captureSystem: $("pSys").checked,
    captureScreen: $("pScreen").checked,
    consented: $("pOk").checked,
  });
  $("prep").onsubmit = async (e) => {
    e.preventDefault();
    const input = read();
    if (!input.consented) { $("pErr").textContent = "Marque o aviso às outras pessoas para iniciar."; $("pErr").classList.remove("hidden"); return; }
    if (!input.captureMic && !input.captureSystem) { $("pErr").textContent = "Ligue o microfone ou o áudio do computador."; $("pErr").classList.remove("hidden"); return; }
    const created = await helios.createMeeting(input);
    try {
      await helios.startMeeting(created.id);
    } catch (err) {
      $("pErr").textContent = err.message || String(err);
      $("pErr").classList.remove("hidden");
      return;
    }
    await helios.openMeeting(created.id);
    state.current = await helios.getMeeting(created.id);
    state.view = "detail";
    await refresh();
  };
  $("pSave").onclick = async () => {
    const created = await helios.createMeeting(read());
    state.current = await helios.getMeeting(created.id);
    state.view = "detail";
    await refresh();
  };
}

function renderDetail(row) {
  if (!row) return renderHome();
  const w = row.wrapup || {};
  const ended = row.status === "ended";
  $("view").innerHTML = `
    <p class="status"><span class="dot ${row.status === "live" ? "live" : row.status === "ended" ? "ended" : ""}"></span>${esc(statusLabel(row))}${row.durationMs ? " · " + fmtDur(row.durationMs) : ""}</p>
    <h1>${esc(row.title)}</h1>
    ${row.example ? '<p class="example">Exemplo de demonstração — não é uma reunião real.</p>' : ""}
    <p class="lead">${esc(row.objective || "Sem objetivo informado.")}</p>
    <div class="card">
      <p class="muted">Pauta</p>
      <p>${esc(row.agenda || "Sem pauta.")}</p>
      <div class="row">
        ${ended ? "" : '<button type="button" class="primary" id="dOpen">Abrir painel</button>'}
        ${row.status === "prep" ? '<button type="button" class="secondary" id="dStart">Iniciar</button>' : ""}
        <button type="button" class="ghost" id="dDel">Excluir desta máquina</button>
      </div>
    </div>
    <div class="wrap">
      <h2>Resumo</h2>
      ${ended ? `<textarea id="wResumo">${esc(w.resumo || "")}</textarea><p class="muted">Editável. O HELIOS não envia follow-up sozinho.</p>` : '<p class="muted">O resumo aparece ao encerrar a sessão.</p>'}
      <h2>Decisões</h2>
      <ul>${(w.decisoes || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li class=\"muted\">Nenhuma decisão citada.</li>"}</ul>
      <h2>Pendências</h2>
      <ul>${(w.pendencias || []).map((x) => `<li>${esc(x.text || x)}${x.owner ? " · " + esc(x.owner) : ""}${x.due ? " · " + esc(x.due) : ""}</li>`).join("") || "<li class=\"muted\">Nenhuma pendência citada.</li>"}</ul>
      <h2>Próximos passos</h2>
      <ul>${(w.proximosPassos || []).map((x) => `<li>${esc(x.text || x)}${x.owner ? " · " + esc(x.owner) : ""}${x.due ? " · " + esc(x.due) : ""}</li>`).join("") || "<li class=\"muted\">Nenhum passo citado.</li>"}</ul>
      ${ended ? '<div class="row"><button type="button" class="secondary" id="wSave">Salvar edição</button></div>' : ""}
      <h2>Transcrição</h2>
      <pre class="tr">${esc((row.lines || []).map((l) => `${l.who === "me" ? "Você" : "Outro(s)"}: ${l.text}`).join("\n") || "Ainda não há transcrição.")}</pre>
    </div>`;
  const open = $("dOpen"); if (open) open.onclick = () => helios.openMeeting(row.id);
  const start = $("dStart");
  if (start) start.onclick = async () => {
    try { await helios.startMeeting(row.id); await helios.openMeeting(row.id); await refresh(); }
    catch (err) { banner(err.message || String(err)); }
  };
  $("dDel").onclick = async () => { await helios.deleteMeeting(row.id); state.current = null; await refresh(); renderHome(); };
  const save = $("wSave");
  if (save) save.onclick = async () => {
    await helios.updateMeeting(row.id, { wrapup: { ...w, resumo: $("wResumo").value, edited: true } });
    banner("Resumo salvo neste computador.", true);
    setTimeout(() => banner(""), 2500);
    await refresh();
  };
}

function renderSettings() {
  state.view = "settings";
  const s = state.settings;
  const keys = s.hasGroqKey ? "Groq definida" : "Groq ausente";
  const gem = s.hasGeminiKey ? "Gemini definida" : "Gemini ausente";
  $("view").innerHTML = `
    <h1>Ajustes</h1>
    <p class="lead">Chaves ficam no cofre do sistema (DPAPI no Windows). Nada entra no git nem na tela depois de colar.</p>
    <form class="card" id="set">
      <p>${esc(keys)} · ${esc(gem)}${s.mock ? " · modo demonstração (HELIOS_MOCK=1)" : ""}</p>
      ${s.vaultBlocked ? `<p class="err">${esc(s.vaultBlockedMessage)}</p>` : ""}
      <label class="field">Chave Groq (transcrição e texto)<input id="sGroq" type="password" autocomplete="off" placeholder="${s.hasGroqKey ? "definida — cole para trocar" : "gsk_…"}"></label>
      <label class="field">Chave Gemini (tela, opcional)<input id="sGem" type="password" autocomplete="off" placeholder="${s.hasGeminiKey ? "definida — cole para trocar" : "AIza…"}"></label>
      <label class="field">Provedor preferido
        <select id="sProv"><option value="groq">Groq</option><option value="gemini">Gemini</option></select>
      </label>
      <label class="field">Bloco de áudio (3–15 s)<input id="sChunk" type="number" min="3" max="15" value="${Number(s.chunkSeconds) || 9}"></label>
      <label class="check"><input type="checkbox" id="sTray" ${s.closeToTray ? "checked" : ""}><span>Fechar a janela manda para a bandeja</span></label>
      <p class="muted">Linux: o áudio do sistema depende do Chromium/loopback e muitas vezes não existe. Windows 10/11 64 bits é o alvo. HELIOS_NO_PROTECT=1 desliga a exclusão de captura do painel, só para gravar a própria tela em desenvolvimento.</p>
      <div class="row">
        <button type="submit" class="primary">Salvar</button>
        <button type="button" class="secondary" id="sTest">Testar chaves</button>
        <button type="button" class="ghost" id="sProf">Abrir perfil local</button>
      </div>
      <p id="sOut" class="muted"></p>
    </form>`;
  $("sProv").value = s.provider === "gemini" ? "gemini" : "groq";
  $("set").onsubmit = async (e) => {
    e.preventDefault();
    const patch = { provider: $("sProv").value, chunkSeconds: Number($("sChunk").value), closeToTray: $("sTray").checked };
    if ($("sGroq").value.trim()) patch.groqKey = $("sGroq").value.trim();
    if ($("sGem").value.trim()) patch.geminiKey = $("sGem").value.trim();
    try {
      state.settings = await helios.setSettings(patch);
      $("sOut").textContent = "Salvo.";
      $("sOut").className = "ok";
    } catch (err) {
      $("sOut").textContent = err.message || String(err);
      $("sOut").className = "err";
    }
  };
  $("sTest").onclick = async () => {
    $("sOut").textContent = "Testando…";
    const r = await helios.testKeys();
    $("sOut").textContent = r.ok ? JSON.stringify(r.result) : (r.error || "falhou");
    $("sOut").className = r.ok ? "ok" : "err";
  };
  $("sProf").onclick = () => helios.openPersonal();
}

function bind() {
  $("btnNew").onclick = () => startPrep();
  $("btnSettings").onclick = () => renderSettings();
  $("btnTheme").onclick = () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("helios-theme", next); } catch { /* ok */ }
    helios.setTheme(next);
    $("btnTheme").querySelector("use").setAttribute("href", next === "light" ? "#i-moon" : "#i-sun");
  };
  helios.onMeetingsChanged(() => { refresh().catch(() => {}); });
}

(async () => {
  bind();
  try {
    state.info = await helios.info();
    state.settings = await helios.getSettings();
    if (state.info && state.info.vaultBlocked) banner("O cofre não abriu. Nada será gravado por cima do arquivo atual.");
    await refresh();
    renderHome();
  } catch (err) {
    banner(err.message || String(err));
  }
})();
