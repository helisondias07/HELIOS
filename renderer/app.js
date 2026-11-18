"use strict";

const $ = (id) => document.getElementById(id);
const state = { view: "home", meetings: [], current: null, settings: {}, info: {}, draft: null, mics: [], screens: [] };

const DEFAULT_PLAYBOOKS = [
  { id: "geral", label: "Geral", defaultLang: "auto", objectivePlaceholder: "O que precisa ficar decidido nesta conversa", agendaTemplate: "" },
  { id: "ecommerce", label: "Cliente E-commerce (Wake / Nuvemshop)", defaultLang: "pt", objectivePlaceholder: "Alinhar escopo técnico, layout e publicação da loja", agendaTemplate: "Escopo de vitrine, PDP, PLP ou checkout\nAprovações pendentes e assets\nIntegrações e plataforma (Wake, Scriban, Nuvemshop, VTEX, Fbits)\nPrazo de homologação e entrada no ar" },
  { id: "daily", label: "Daily Agência", defaultLang: "pt", objectivePlaceholder: "Sincronizar entregas, foco do dia e bloqueios do time", agendaTemplate: "O que foi entregue ontem\nFoco técnico de hoje\nBloqueios, revisões de PR ou dependências" },
  { id: "entrevista", label: "Entrevista Técnica (PT / EN)", defaultLang: "auto", objectivePlaceholder: "Apresentar experiência real em frontend, e-commerce e automação com clareza", agendaTemplate: "Apresentação objetiva da trajetória\nProjetos reais em produção e decisões técnicas\nPerguntas sobre o time, arquitetura e próximos passos" },
  { id: "saas", label: "Discovery SaaS", defaultLang: "pt", objectivePlaceholder: "Mapear dores operacionais, impacto e validação de produto (Ronda / Prancheta)", agendaTemplate: "Fluxo atual da operação e gargalos\nFrequência e custo do problema hoje\nDemonstração focada na dor principal\nCritérios de decisão e próximo passo" },
];

function playbooksList() {
  return Array.isArray(state.settings.playbooks) && state.settings.playbooks.length ? state.settings.playbooks : DEFAULT_PLAYBOOKS;
}
function esc(s) { return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function banner(msg, on = true, ok = false) {
  const el = $("banner");
  el.textContent = msg || "";
  el.classList.toggle("hidden", !on || !msg);
  el.classList.toggle("ok-banner", Boolean(ok));
}
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

async function copyClip(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fallback */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

async function loadDevicesAndSources() {
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const all = await navigator.mediaDevices.enumerateDevices();
      state.mics = all.filter((d) => d.kind === "audioinput");
    }
  } catch { state.mics = []; }
  try {
    if (helios.listScreenSources) {
      const res = await helios.listScreenSources();
      state.screens = res && res.ok && Array.isArray(res.sources) ? res.sources : [];
    }
  } catch { state.screens = []; }
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
    const modeTag = row.mode === "livecoding" ? " · código" : "";
    b.innerHTML = `<span>${esc(row.title)}</span><small>${esc(statusLabel(row))}${modeTag} · ${row.lineCount} falas${row.example ? " · exemplo" : ""}</small>`;
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
      <p>Escolha um Playbook (E-commerce, Daily, Entrevista PT/EN ou Discovery SaaS) ou o modo Código / Pair Programming. Durante a conversa, use <code>Alt+S</code> para sugestão de fala, <code>Alt+P</code> para consultar termos ao vivo, <code>Alt+C</code> para análise de código e o bloco de notas rápido.</p>
      <div class="row"><button type="button" class="secondary" id="goNew">Nova reunião</button></div>
      <p class="muted">Transcrição via Groq Whisper (&lt; 2 s com glossário). Contexto de tela e visão via Gemini em streaming SSE real. Proteção nativa contra captura ativa por padrão.</p>
    </div>`;
  $("goNew").onclick = () => startPrep();
}

async function startPrep(base) {
  state.view = "prep";
  await loadDevicesAndSources();
  state.draft = base || {
    title: "",
    objective: "",
    agenda: "",
    notes: "",
    mode: state.settings.meetingMode || "meeting",
    playbook: "geral",
    lang: state.settings.meetingLang || "auto",
    micDeviceId: state.settings.micDeviceId || "",
    screenSourceId: state.settings.screenSourceId || "",
    captureMic: state.settings.captureMic !== false,
    captureSystem: state.settings.captureSystem !== false,
    captureScreen: state.settings.meetingMode === "livecoding",
    consented: false,
  };
  renderPrep(state.draft);
}

function renderPrep(d) {
  const pbs = playbooksList();
  const activePb = pbs.find((p) => p.id === d.playbook) || pbs[0];
  $("view").innerHTML = `
    <h1>Antes de começar</h1>
    <p class="lead">Título, objetivo, playbook e notas entram no contexto ao vivo e na ata final. Todas as falas são salvas incrementalmente no seu computador.</p>
    <form class="card" id="prep">
      <div>
        <p class="muted" style="margin:0 0 8px">Modo da sessão</p>
        <div class="pb-bar" id="pModes">
          <button type="button" class="pb-chip ${d.mode !== "livecoding" ? "on" : ""}" data-mode="meeting">Reunião (Copiloto + Notas)</button>
          <button type="button" class="pb-chip ${d.mode === "livecoding" ? "on" : ""}" data-mode="livecoding">Código / Pair Programming</button>
        </div>
      </div>
      <div>
        <p class="muted" style="margin:0 0 8px">Playbook de 1 clique</p>
        <div class="pb-bar" id="pPlaybooks">
          ${pbs.map((p) => `<button type="button" class="pb-chip ${p.id === activePb.id ? "on" : ""}" data-pb="${esc(p.id)}">${esc(p.label)}</button>`).join("")}
        </div>
      </div>
      <div class="grid2">
        <label class="field">Título<input id="pTitle" maxlength="120" value="${esc(d.title)}" placeholder="${d.mode === "livecoding" ? "Pair programming / Desafio técnico" : "Alinhamento semanal"}"></label>
        <label class="field">Idioma da conversa
          <select id="pLang">
            <option value="auto" ${d.lang === "auto" ? "selected" : ""}>Automático (PT / EN)</option>
            <option value="pt" ${d.lang === "pt" ? "selected" : ""}>Português (PT)</option>
            <option value="en" ${d.lang === "en" ? "selected" : ""}>Inglês com tradução ao vivo (EN)</option>
          </select>
        </label>
      </div>
      <label class="field">Objetivo<textarea id="pObj" maxlength="2000" placeholder="${esc(activePb.objectivePlaceholder || "O que precisa ficar decidido")}">${esc(d.objective)}</textarea></label>
      <label class="field">Pauta<textarea id="pAgenda" maxlength="4000" placeholder="Uma linha por ponto">${esc(d.agenda)}</textarea></label>
      <label class="field">Notas só suas (bloco híbrido)<textarea id="pNotes" maxlength="12000" placeholder="Opcional. Suas notas entram nas sugestões ao vivo e na ata final.">${esc(d.notes)}</textarea></label>
      <div class="grid2">
        <label class="field">Microfone
          <select id="pMicDevice">
            <option value="">Padrão do sistema</option>
            ${state.mics.map((m, i) => `<option value="${esc(m.deviceId)}" ${d.micDeviceId === m.deviceId ? "selected" : ""}>${esc(m.label || "Microfone " + (i + 1))}</option>`).join("")}
          </select>
        </label>
        <label class="field">Monitor ou janela para captura
          <select id="pScreenSource">
            <option value="">Tela principal</option>
            ${state.screens.map((s) => `<option value="${esc(s.id)}" ${d.screenSourceId === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="checks">
        <label class="check"><input type="checkbox" id="pMic" ${d.captureMic ? "checked" : ""}><span>Microfone<small>Sua fala separada como [Você] com cancelamento de eco.</small></span></label>
        <label class="check"><input type="checkbox" id="pSys" ${d.captureSystem ? "checked" : ""}><span>Áudio do computador<small>Outras pessoas na call separadas como [Outro] via loopback do Windows.</small></span></label>
        <label class="check"><input type="checkbox" id="pScreen" ${d.captureScreen ? "checked" : ""}><span>Contexto de tela desta reunião<small>Lê o monitor ou janela selecionada acima via Gemini SSE quando solicitado.</small></span></label>
        <label class="check"><input type="checkbox" id="pOk" ${d.consented ? "checked" : ""}><span>Avisei as outras pessoas<small>Confirme o aviso de transcrição antes de iniciar a sessão.</small></span></label>
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
    mode: state.draft.mode || "meeting",
    playbook: state.draft.playbook || "geral",
    lang: $("pLang").value,
    micDeviceId: $("pMicDevice").value,
    screenSourceId: $("pScreenSource").value,
    captureMic: $("pMic").checked,
    captureSystem: $("pSys").checked,
    captureScreen: $("pScreen").checked,
    consented: $("pOk").checked,
  });

  document.querySelectorAll("#pModes .pb-chip").forEach((btn) => {
    btn.onclick = () => {
      const cur = read();
      cur.mode = btn.dataset.mode;
      if (cur.mode === "livecoding") {
        cur.captureScreen = true;
        if (cur.playbook === "geral") cur.playbook = "entrevista";
      }
      state.draft = cur;
      renderPrep(state.draft);
    };
  });

  document.querySelectorAll("#pPlaybooks .pb-chip").forEach((btn) => {
    btn.onclick = () => {
      const cur = read();
      const chosen = pbs.find((p) => p.id === btn.dataset.pb) || pbs[0];
      const prevPb = pbs.find((p) => p.id === cur.playbook);
      cur.playbook = chosen.id;
      if (!cur.agenda.trim() || (prevPb && cur.agenda.trim() === (prevPb.agendaTemplate || "").trim())) {
        cur.agenda = chosen.agendaTemplate || "";
      }
      if (chosen.defaultLang) cur.lang = chosen.defaultLang;
      state.draft = cur;
      renderPrep(state.draft);
    };
  });

  $("prep").onsubmit = async (e) => {
    e.preventDefault();
    const input = read();
    if (!input.consented) { $("pErr").textContent = "Marque o aviso às outras pessoas para iniciar."; $("pErr").classList.remove("hidden"); return; }
    if (!input.captureMic && !input.captureSystem) { $("pErr").textContent = "Ligue o microfone ou o áudio do computador."; $("pErr").classList.remove("hidden"); return; }
    state.settings = await helios.setSettings({
      meetingLang: input.lang,
      meetingMode: input.mode,
      micDeviceId: input.micDeviceId,
      screenSourceId: input.screenSourceId,
    });
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
    const input = read();
    const created = await helios.createMeeting(input);
    state.current = await helios.getMeeting(created.id);
    state.view = "detail";
    await refresh();
  };
}

function formatActionLines(list) {
  return (list || []).map((x) => `${x && x.done ? "[x] " : "[ ] "}${typeof x === "string" ? x : (x.text || "")}`).join("\n");
}
function parseEditedActions(raw, prevList = []) {
  const prevByText = new Map((prevList || []).map((it) => [String(it.text || "").toLowerCase(), it]));
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const explicitDone = /^\[[xX]\]\s*/.test(line);
      const explicitOpen = /^\[\s\]\s*/.test(line);
      const clean = line.replace(/^\[[ xX]\]\s*/, "").trim();
      if (!clean) return null;
      const old = prevByText.get(clean.toLowerCase());
      const ownerMatch = clean.match(/^(?:você|helison|outro\(s\)|[\p{L}.][\p{L}\p{N}. -]{1,40}?)\s*[:—-]\s+/iu);
      const dueMatch = clean.match(/\b(?:até|prazo|para o dia|dia)\s+([^.,;]+)/i);
      return {
        text: clean,
        owner: ownerMatch ? ownerMatch[0].replace(/[:—-]\s+$/, "").trim() : (old ? old.owner : ""),
        due: dueMatch ? dueMatch[1].trim().slice(0, 80) : (old ? old.due : ""),
        done: explicitDone ? true : (explicitOpen ? false : Boolean(old && old.done)),
      };
    })
    .filter(Boolean);
}

function renderChecklist(items, kind) {
  if (!Array.isArray(items) || !items.length) {
    return `<p class="muted">Nenhum item citado.</p>`;
  }
  return `<ul class="checklist">${items.map((x, idx) => {
    const label = esc(x.text || x) + (x.owner ? ` · <strong>${esc(x.owner)}</strong>` : "") + (x.due ? ` · ${esc(x.due)}` : "");
    return `<li class="${x.done ? "done" : ""}"><input type="checkbox" data-kind="${kind}" data-idx="${idx}" ${x.done ? "checked" : ""}><span>${label}</span></li>`;
  }).join("")}</ul>`;
}

function renderDetail(row) {
  if (!row) return renderHome();
  const w = row.wrapup || {};
  const ended = row.status === "ended";
  const pbs = playbooksList();
  const pb = pbs.find((p) => p.id === row.playbook) || pbs[0];
  const hasContent = Boolean((row.lines && row.lines.length) || (row.notes && row.notes.trim()));

  $("view").innerHTML = `
    <p class="status"><span class="dot ${row.status === "live" ? "live" : ended ? "ended" : ""}"></span>${esc(statusLabel(row))}${row.durationMs ? " · " + fmtDur(row.durationMs) : ""}</p>
    <h1>${esc(row.title)}</h1>
    <div class="meta-pills">
      <span class="meta-pill">Modo: ${row.mode === "livecoding" ? "Código / Pair Programming" : "Reunião"}</span>
      <span class="meta-pill">Playbook: ${esc(pb.label)}</span>
      <span class="meta-pill">${(row.lines || []).length} falas salvas</span>
    </div>
    ${row.example ? '<p class="example">Exemplo de demonstração — não é uma reunião real.</p>' : ""}
    ${row.warn ? `<div class="warn-box">${esc(row.warn)}</div>` : ""}
    <p class="lead">${esc(row.objective || "Sem objetivo informado.")}</p>
    <div class="card">
      <p class="muted" style="margin:0">Pauta</p>
      <p style="margin:0;white-space:pre-wrap">${esc(row.agenda || "Sem pauta.")}</p>
      <div class="row">
        ${ended ? "" : '<button type="button" class="primary" id="dOpen">Abrir painel</button>'}
        ${row.status === "prep" ? '<button type="button" class="secondary" id="dStart">Iniciar</button>' : ""}
        ${hasContent ? '<button type="button" class="secondary" id="wRegen">Regenerar ata</button>' : ""}
        <button type="button" class="secondary" id="wCopyMd">Copiar Markdown</button>
        <button type="button" class="secondary" id="wExportMd">Exportar .md</button>
        <button type="button" class="ghost" id="dDel">Excluir desta máquina</button>
      </div>
    </div>
    <div class="wrap">
      <h2>Resumo</h2>
      ${ended ? `<textarea id="wResumo">${esc(w.resumo || "")}</textarea>` : '<p class="muted">O resumo estruturado aparece ao encerrar a sessão (ou clique em Regenerar ata).</p>'}

      <h2>Decisões</h2>
      <ul>${(w.decisoes || []).map((x) => `<li>${esc(x)}</li>`).join("") || '<li class="muted">Nenhuma decisão citada.</li>'}</ul>

      <h2>Pendências (marque concluídas)</h2>
      ${renderChecklist(w.pendencias, "pendencias")}

      <h2>Próximos passos</h2>
      ${renderChecklist(w.proximosPassos, "proximosPassos")}

      <h2>Notas da reunião (bloco híbrido)</h2>
      <textarea id="wNotes" placeholder="Suas notas rápidas e observações desta conversa…">${esc(row.notes || "")}</textarea>

      ${ended ? `
      <details style="margin-top:12px">
        <summary class="muted" style="cursor:pointer">Editar listas em texto (decisões, pendências e próximos passos)</summary>
        <div style="display:flex;flex-direction:column;gap:12px;margin-top:12px">
          <label class="field">Decisões (uma por linha)<textarea id="wDecisoes">${esc((w.decisoes || []).join("\n"))}</textarea></label>
          <label class="field">Pendências (uma por linha; use [x] ou [ ])<textarea id="wPendencias">${esc(formatActionLines(w.pendencias))}</textarea></label>
          <label class="field">Próximos passos (um por linha; use [x] ou [ ])<textarea id="wPassos">${esc(formatActionLines(w.proximosPassos))}</textarea></label>
        </div>
      </details>
      ` : ""}

      <div class="row" style="margin-top:12px">
        <button type="button" class="secondary" id="wSave">Salvar edição</button>
      </div>

      <h2>Transcrição</h2>
      <pre class="tr">${esc((row.lines || []).map((l) => `${l.who === "me" ? "Você" : "Outro(s)"}: ${l.text}${l.pt ? " (" + l.pt + ")" : ""}`).join("\n") || "Ainda não há transcrição.")}</pre>
    </div>`;

  const open = $("dOpen");
  if (open) open.onclick = () => helios.openMeeting(row.id);

  const start = $("dStart");
  if (start) {
    start.onclick = async () => {
      try {
        await helios.startMeeting(row.id);
        await helios.openMeeting(row.id);
        await refresh();
      } catch (err) { banner(err.message || String(err)); }
    };
  }

  $("dDel").onclick = async () => {
    await helios.deleteMeeting(row.id);
    state.current = null;
    await refresh();
    renderHome();
  };

  const regen = $("wRegen");
  if (regen) {
    regen.onclick = async () => {
      regen.disabled = true;
      regen.textContent = "Gerando ata…";
      const r = await helios.regenerateWrapup(row.id);
      regen.disabled = false;
      regen.textContent = "Regenerar ata";
      if (!r || !r.ok) {
        banner((r && r.error) || "Não foi possível regenerar a ata.");
        return;
      }
      banner("Ata regenerada com sucesso.", true, true);
      setTimeout(() => banner(""), 2800);
      await refresh();
    };
  }

  $("wCopyMd").onclick = async () => {
    try {
      const { markdown } = await helios.getMarkdown(row.id);
      const ok = await copyClip(markdown);
      banner(ok ? "Ata em Markdown copiada para a área de transferência." : "Não consegui copiar.", true, ok);
      setTimeout(() => banner(""), 2600);
    } catch (err) { banner(err.message || String(err)); }
  };

  $("wExportMd").onclick = async () => {
    const r = await helios.exportMarkdown(row.id);
    if (!r || !r.ok) { banner((r && r.error) || "Falha ao exportar Markdown."); return; }
    if (r.saved) {
      banner(`Arquivo salvo em: ${r.filePath}`, true, true);
      setTimeout(() => banner(""), 3500);
    }
  };

  document.querySelectorAll('.checklist input[type="checkbox"]').forEach((box) => {
    box.onchange = async () => {
      const kind = box.dataset.kind;
      const idx = Number(box.dataset.idx);
      const nextWrap = { ...w, [kind]: (w[kind] || []).map((item, i) => (i === idx ? { ...item, done: box.checked } : item)), edited: true };
      await helios.updateMeeting(row.id, { wrapup: nextWrap });
      await refresh();
    };
  });

  $("wSave").onclick = async () => {
    const patch = { notes: $("wNotes").value };
    if (ended) {
      const decisoes = $("wDecisoes")
        ? $("wDecisoes").value.split(/\r?\n/).map((s) => s.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean)
        : (w.decisoes || []);
      const pendencias = $("wPendencias") ? parseEditedActions($("wPendencias").value, w.pendencias) : (w.pendencias || []);
      const proximosPassos = $("wPassos") ? parseEditedActions($("wPassos").value, w.proximosPassos) : (w.proximosPassos || []);
      patch.wrapup = {
        ...w,
        resumo: $("wResumo").value,
        decisoes,
        pendencias,
        proximosPassos,
        edited: true,
      };
    }
    await helios.updateMeeting(row.id, patch);
    banner("Alterações salvas neste computador.", true, true);
    setTimeout(() => banner(""), 2500);
    await refresh();
  };
}

async function renderSettings() {
  state.view = "settings";
  await loadDevicesAndSources();
  const s = state.settings;
  const keys = s.hasGroqKey ? "Groq definida" : "Groq ausente";
  const gem = s.hasGeminiKey ? "Gemini definida" : "Gemini ausente";
  $("view").innerHTML = `
    <h1>Ajustes</h1>
    <p class="lead">Chaves ficam no cofre do sistema (DPAPI no Windows). Nada entra no git nem na tela depois de colar.</p>
    <form class="card" id="set">
      <p>${esc(keys)} · ${esc(gem)}${s.mock ? " · modo demonstração (HELIOS_MOCK=1)" : ""}</p>
      ${s.vaultBlocked ? `<p class="err">${esc(s.vaultBlockedMessage)}</p>` : ""}
      <label class="field">Chave Groq (transcrição Whisper e texto rápido)<input id="sGroq" type="password" autocomplete="off" placeholder="${s.hasGroqKey ? "definida — cole para trocar" : "gsk_…"}"></label>
      <label class="field">Chave Gemini (tela, visão e streaming multimodal)<input id="sGem" type="password" autocomplete="off" placeholder="${s.hasGeminiKey ? "definida — cole para trocar" : "AIza…"}"></label>
      <div class="grid2">
        <label class="field">Provedor preferido
          <select id="sProv"><option value="groq">Groq</option><option value="gemini">Gemini</option></select>
        </label>
        <label class="field">Idioma padrão
          <select id="sLang">
            <option value="auto">Automático (PT / EN)</option>
            <option value="pt">Português (PT)</option>
            <option value="en">Inglês com tradução (EN)</option>
          </select>
        </label>
      </div>
      <div class="grid2">
        <label class="field">Microfone padrão
          <select id="sMicDevice">
            <option value="">Padrão do sistema</option>
            ${state.mics.map((m, i) => `<option value="${esc(m.deviceId)}" ${s.micDeviceId === m.deviceId ? "selected" : ""}>${esc(m.label || "Microfone " + (i + 1))}</option>`).join("")}
          </select>
        </label>
        <label class="field">Monitor / janela padrão
          <select id="sScreenSource">
            <option value="">Tela principal</option>
            ${state.screens.map((src) => `<option value="${esc(src.id)}" ${s.screenSourceId === src.id ? "selected" : ""}>${esc(src.name)}</option>`).join("")}
          </select>
        </label>
      </div>
      <label class="field">Bloco máximo de áudio (3–15 s; cortes por pausa ocorrem antes)<input id="sChunk" type="number" min="3" max="15" value="${Number(s.chunkSeconds) || 5}"></label>
      <label class="check"><input type="checkbox" id="sTray" ${s.closeToTray ? "checked" : ""}><span>Fechar a janela manda para a bandeja</span></label>
      <p class="muted">Atalhos sem roubar foco: Ctrl+Shift+Espaço oculta/mostra o painel sem parar a gravação · Alt+S sugere fala · Alt+P consulta conceito · Alt+C analisa código.</p>
      <div class="row">
        <button type="submit" class="primary">Salvar</button>
        <button type="button" class="secondary" id="sTest">Testar chaves</button>
        <button type="button" class="ghost" id="sProf">Editar contexto.md</button>
        <button type="button" class="ghost" id="sGloss">Editar glossario.md</button>
      </div>
      <p id="sOut" class="muted"></p>
    </form>`;
  $("sProv").value = s.provider === "gemini" ? "gemini" : "groq";
  $("sLang").value = ["auto", "pt", "en"].includes(s.meetingLang) ? s.meetingLang : "auto";
  $("set").onsubmit = async (e) => {
    e.preventDefault();
    const patch = {
      provider: $("sProv").value,
      meetingLang: $("sLang").value,
      micDeviceId: $("sMicDevice").value,
      screenSourceId: $("sScreenSource").value,
      chunkSeconds: Number($("sChunk").value),
      closeToTray: $("sTray").checked,
    };
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
  $("sGloss").onclick = () => helios.glossaryOpen();
}

function bind() {
  const curTheme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  helios.setTheme(curTheme);
  $("btnTheme").querySelector("use").setAttribute("href", curTheme === "light" ? "#i-moon" : "#i-sun");

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
