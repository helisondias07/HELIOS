"use strict";
/* global HeliosDetailsState */

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const TITLES = {
  chefe: ["Chefe", "Ordens, aprovações e os 4 agentes. O Chefe pergunta só o que faltar."],
  inbox: ["Decisões", "Aprovações e perguntas que precisam de você — reunidas em um só lugar."],
  chat: ["Conversas", "O agente usa ferramentas, memória e pede aprovação antes de enviar, apagar ou pagar."],
  assistants: ["Assistentes", "Cada assistente tem função, instruções, memória e conectores próprios. As conversas pertencem a um deles."],
  vault: ["Cofre", "Logins e chaves ficam criptografados neste computador. A senha não vai para o chat."],
  mcp: ["Conectores", "Escolha um aplicativo, entre no navegador e volte."],
  search: ["Pesquisa", "Resultados com a fonte ao lado, para você conferir."],
  memory: ["Memória", "Fatos estáveis sobre você, enxuta: o que fecha vai para o arquivo e sai do prompt. Segredos são recusados."],
  vagas: ["Vagas", "Busca vagas, dá nota pelo seu contexto.md e prepara a inscrição. No modo com aprovação nada é enviado sem o seu clique; no modo Automático o HELIOS se inscreve sozinho e só pergunta o que for crítico."],
  brain: ["Second Brain", "Suas notas e conhecimento, pesquisáveis e guardados só neste computador. Use [[Título]] para ligar notas."],
  context: ["Contexto", "Exporte e importe o seu contexto (sem segredos), leia ClickUp e e-mail só para consulta e escolha as pastas do PC que o HELIOS pode usar."],
  routines: ["Rotinas", "Horário, intervalo ou evento. Morning Brief e Monitor são só leitura. Ação irreversível continua pedindo aprovação."],
  gatilhos: ["Gatilhos", "Agendados e por evento, idempotentes. Conteúdo de e-mail nunca concede permissão. Pause ou remova aqui."],
  ditado: ["Ditado", "Segure ou alterne um atalho e o texto entra na janela em foco. O áudio não fica salvo."],
  time: ["Montar time", "Descreva o objetivo. O HELIOS propõe assistentes que já existem e só cria depois do seu clique."],
  activity: ["Atividade", "Ajudantes temporários, consultas entre assistentes, limites e o tamanho do contexto de cada assistente."],
  autonomy: ["Autonomia", "Para cada tipo de ação, escolha se o HELIOS pede antes ou faz sozinho. Pagar e usar senha do cofre sempre pedem."],
  account: ["Conta Cursor", "Até 3 contas. As chaves ficam no cofre e você escolhe qual está ativa. O modo Auto escolhe o modelo mais barato que der conta."],
};

const state = { switched: {}, view: "chefe", conversations: [], current: null, level: "auto", error: "", poll: null, assistants: [], assistantId: "chefe", memoryAssistant: "default", dictationPhase: "idle", vagasPrevia: null };

const voice = window.HeliosVoice ? window.HeliosVoice.createController({
  banner: (text) => banner(text),
  status: () => helios.voiceStatus(),
  transcribe: (buf, mime) => helios.voiceTranscribe(buf, mime),
  speakRemote: (text) => helios.voiceSpeak(text),
  sendText: (text) => sendText(text),
  getMessage: (index) => (state.current ? state.current.messages[index] : null),
  onPhase: () => syncSolar(),
}) : null;

function banner(text) {
  // O Electron prefixa "Error invoking remote method 'x': Error: " nos erros do processo principal.
  text = String(text || "").replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
  state.error = text || "";
  $("banner").classList.toggle("hidden", !text);
  $("banner").textContent = text || "";
}

async function call(method, pathname, body) {
  const res = await helios.request(method, pathname, body);
  if (!res.ok) throw new Error(res.error || "Não deu certo.");
  return res.data;
}

function syncSolar() {
  const html = document.documentElement;
  const phase = voice && voice.phase ? voice.phase() : "off";
  const dict = state.dictationPhase || "idle";
  const busy = Boolean(state.current && state.current.busy) || phase === "thinking" || dict === "transcribing";
  html.dataset.solar = busy ? "thinking" : "idle";
  const heard = phase === "listening" || phase === "speaking" ? phase : (dict === "recording" ? "listening" : "");
  if (heard) html.dataset.voice = heard;
  else delete html.dataset.voice;
  const bar = $("solarBar");
  if (bar) bar.hidden = !busy;
}

function dawn() {
  const view = $("view");
  view.classList.remove("is-dawn");
  void view.offsetWidth;
  view.classList.add("is-dawn");
}

function setView(view) {
  state.view = view;
  if (voice && view !== "chat") voice.stopAll();
  document.querySelectorAll("nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  const meta = TITLES[view] || TITLES.chefe;
  const [title, eyebrow] = meta;
  $("title").textContent = title;
  $("eyebrow").textContent = eyebrow;
  $("title").title = eyebrow; // explicação só no hover
  banner("");
  dawn();
  syncSolar();
  if (view === "chefe") {
    if (window.HeliosChefe) window.HeliosChefe.open();
    else banner("Chefe indisponível.");
  }
  else if (view === "chat") loadChat().catch((err) => banner(err.message));
  else if (view === "inbox") loadInbox().catch((err) => banner(err.message));
  else if (view === "assistants") loadAssistants().catch((err) => banner(err.message));
  else if (view === "ditado") loadDitado().catch((err) => banner(err.message));
  else if (view === "time") loadTime().catch((err) => banner(err.message));
  else if (view === "vault") loadVault().catch((err) => banner(err.message));
  else if (view === "mcp") loadMcp().catch((err) => banner(err.message));
  else if (view === "search") renderSearch({ query: "", results: [], error: "" });
  else if (view === "memory") loadMemory().catch((err) => banner(err.message));
  else if (view === "vagas") loadVagas().catch((err) => banner(err.message));
  else if (view === "brain") loadBrain().catch((err) => banner(err.message));
  else if (view === "context") contextView.load().catch((err) => banner(err.message));
  else if (view === "routines") loadRoutines().catch((err) => banner(err.message));
  else if (view === "gatilhos") loadGatilhos().catch((err) => banner(err.message));
  else if (view === "activity") loadActivity().catch((err) => banner(err.message));
  else if (view === "autonomy") loadAutonomy().catch((err) => banner(err.message));
  else loadAccount().catch((err) => banner(err.message));
}

const contextView = window.HeliosContexto.create({ call, shell: (html) => shell(html), esc, banner, helios });

// Estado dos <details> (ex.: Registro de fontes) preservado entre redesenhos da tela.
const detailsOpen = HeliosDetailsState.create();
$("view").addEventListener("toggle", (event) => {
  const el = event.target;
  if (el && el.tagName === "DETAILS" && el.dataset.ledger) detailsOpen.set(el.dataset.ledger, el.open);
}, true);

function shell(html) {
  $("view").innerHTML = html;
}

async function refreshAssistants() {
  const data = await call("GET", "/api/assistants");
  state.assistants = data.assistants;
  state.templates = data.templates;
  if (!state.assistants.some((item) => item.id === state.assistantId)) state.assistantId = "default";
  if (!state.assistants.some((item) => item.id === state.memoryAssistant)) state.memoryAssistant = "default";
  return data;
}

const assistantName = (id) => (state.assistants.find((item) => item.id === id) || { name: "HELIOS" }).name;
const assistantOptions = (selected) => state.assistants.map((item) => `<option value="${esc(item.id)}"${item.id === selected ? " selected" : ""}>${esc(item.name)}${item.role ? " · " + esc(item.role) : ""}</option>`).join("");

async function loadChat() {
  const [data] = await Promise.all([call("GET", "/api/conversations"), refreshAssistants().catch(() => null)]);
  state.conversations = data.conversations;
  if (state.current) {
    const fresh = state.conversations.find((item) => item.id === state.current.id);
    if (fresh) state.current = fresh;
  }
  renderChat();
}

let lastRenderedConv = null;
function renderChat() {
  // Esta tela é redesenhada a cada 500 ms enquanto o agente responde: guarda foco, cursor e rolagem.
  const focused = document.activeElement;
  let focusSel = "";
  let caret = null;
  if (focused && focused.closest && focused.closest("#view")) {
    if (focused.id) focusSel = `#${focused.id}`;
    else if (focused.dataset && focused.dataset.note) focusSel = `[data-note="${focused.dataset.note}"]`;
    else if (focused.dataset && focused.dataset.answer) focusSel = `[data-answer="${focused.dataset.answer}"]`;
    if (focusSel && typeof focused.selectionStart === "number") caret = [focused.selectionStart, focused.selectionEnd];
  }
  const prevBox = $("messages");
  const prevTop = prevBox ? prevBox.scrollTop : 0;
  const stick = !prevBox || (state.current && state.current.id) !== lastRenderedConv
    || prevBox.scrollHeight - prevBox.scrollTop - prevBox.clientHeight < 80;
  lastRenderedConv = state.current ? state.current.id : null;
  const kept = {};
  document.querySelectorAll("#view textarea, #view input").forEach((el) => {
    if (el.id) kept[el.id] = el.value;
    if (el.dataset.note) kept[`note:${el.dataset.note}`] = el.value;
    if (el.dataset.answer) kept[`answer:${el.dataset.answer}`] = el.value;
  });
  const current = state.current;
  const items = state.conversations.map((conv) => `
    <button type="button" class="conv${current && current.id === conv.id ? " active" : ""}" data-conv="${esc(conv.id)}">
      <strong>${esc(conv.title || "Nova conversa")}</strong>
      ${conv.assistantId && conv.assistantId !== "default" ? `<span class="chip">${esc(assistantName(conv.assistantId))}</span>` : ""}
      <span>${esc(conv.preview || "sem mensagens")}</span>
    </button>`).join("");
  const messages = current ? current.messages.map(renderMessage).join("") : `<div class="lf-hello"><span class="hx-glow lf-hello-logo" role="img" aria-label="HELIOS"><span class="hx-mark hx-96"></span></span><p>Como posso ajudar?</p></div>`;
  syncSolar();
  shell(`
    <div class="layout">
      <div class="panel list">
        <header><strong>Suas conversas</strong><button type="button" class="btn" id="newConv">Nova</button></header>
        <label class="pick">Nova conversa com
          <select id="newAssistant">${assistantOptions(state.assistantId)}</select>
        </label>
        <div>${items || `<div class="empty">Nenhuma conversa ainda.</div>`}</div>
      </div>
      <div class="panel thread">
        <header>
          <strong>${esc(current ? current.title : "Nova conversa")}</strong>
          <span class="chip" id="threadAssistant">${esc(assistantName(current ? current.assistantId : state.assistantId))}</span>
          ${current && current.readOnly ? `<span class="chip">só leitura</span>` : ""}
          ${current && current.summary && current.summary.active ? `<span class="chip summary" id="threadSummary" tabindex="0" title="${esc(`Conversa longa: o assistente recebe um resumo (${current.summary.chars} caracteres, cobre ${current.summary.covered} mensagens) mais as últimas mensagens. Resumo: ${current.summary.text}`)}">contexto resumido</span>` : ""}
          <span class="chat-opts-wrap">
            <button type="button" class="btn icon-btn" id="chatOpts" title="Voz e nível de raciocínio" aria-label="Opções da conversa" aria-expanded="false"><span class="hx-mark hx-18 chat-opts-mark" aria-hidden="true"></span></button>
            <div class="chat-pop" id="chatPop" hidden>
              ${voice ? voice.ui.options() : ""}
              <label title="Auto escolhe sozinho. Avançado pensa mais e demora mais.">Nível
                <select id="level">
                  <option value="auto">Auto</option>
                  <option value="rapido">Rápido</option>
                  <option value="padrao">Padrão</option>
                  <option value="avancado">Avançado</option>
                </select>
              </label>
            </div>
          </span>
        </header>
        <div class="messages" id="messages">${messages}</div>
        ${routerHintHtml()}
        <div class="hx-composer-wrap">
          <form class="composer" id="composer">
            <textarea id="draft" placeholder="Pergunte ou peça algo ao HELIOS…" rows="1"></textarea>
            <input type="file" id="attachFile" hidden multiple>
            <button type="button" class="btn icon-btn" id="attachBtn" title="Anexar arquivo de texto" aria-label="Anexar arquivo"><svg class="sb-ico" aria-hidden="true"><use href="#i-clip"/></svg></button>
            ${voice ? voice.ui.mic() : ""}
            <button type="button" class="btn icon-btn" id="routeBtn" title="Quem cuida disso? Sugere o assistente. Não envia nada." aria-label="Quem cuida disso?"><svg class="sb-ico" aria-hidden="true"><use href="#i-spark"/></svg></button>
            <button class="btn primary send-btn" type="submit" title="Enviar (Enter)" aria-label="Enviar"><svg class="sb-ico" aria-hidden="true"><use href="#i-send"/></svg></button>
          </form>
          <div class="hx-uso-bar" id="hxUsoBarChat" hidden></div>
        </div>
      </div>
    </div>`);
  try { window.HeliosUsoBar?.mount?.($("hxUsoBarChat")); } catch { /* opcional */ }
  $("level").value = state.level;
  $("level").onchange = () => { state.level = $("level").value; };
  // Leva G: voz e nível saem da barra do chat e ficam num popover.
  $("chatOpts").onclick = (event) => {
    event.stopPropagation();
    const pop = $("chatPop");
    pop.hidden = !pop.hidden;
    $("chatOpts").setAttribute("aria-expanded", String(!pop.hidden));
  };
  $("chatPop").onclick = (event) => event.stopPropagation();
  document.addEventListener("click", () => { const pop = $("chatPop"); if (pop) pop.hidden = true; }, { once: true });
  $("newAssistant").onchange = () => { state.assistantId = $("newAssistant").value; if (!state.current) $("threadAssistant").textContent = assistantName(state.assistantId); };
  $("newConv").onclick = async () => {
    const data = await call("POST", "/api/conversations", { assistantId: state.assistantId });
    state.current = data.conversation;
    await loadChat();
  };
  document.querySelectorAll("[data-conv]").forEach((button) => {
    button.onclick = async () => {
      const data = await call("GET", `/api/conversations/${button.dataset.conv}`);
      state.current = data.conversation;
      renderChat();
      if (state.current.busy) watch(state.current.id);
    };
  });
  $("draft").onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit(); }
  };
  $("composer").onsubmit = async (event) => {
    event.preventDefault();
    const text = $("draft").value.trim();
    if (!text) return;
    $("draft").value = "";
    try {
      await sendText(text);
    } catch (err) {
      banner(err.message);
    }
  };
  bindApprovals();
  bindAccountNotices();
  bindAttach();
  if ($("draft") && kept.draft) $("draft").value = kept.draft;
  if ($("draft") && state.pendingDraft) {
    $("draft").value = state.pendingDraft;
    state.pendingDraft = "";
  }
  bindRouter();
  document.querySelectorAll("[data-note]").forEach((input) => {
    const value = kept[`note:${input.dataset.note}`];
    if (value) input.value = value;
  });
  document.querySelectorAll("[data-answer]").forEach((input) => {
    const value = kept[`answer:${input.dataset.answer}`];
    if (value) input.value = value;
  });
  if (voice) {
    voice.bind();
    voice.onRender(current);
  }
  const box = $("messages");
  if (box) box.scrollTop = stick ? box.scrollHeight : prevTop;
  document.dispatchEvent(new CustomEvent("helios:chat"));
  if (focusSel) {
    let target = null;
    try { target = document.querySelector(focusSel); } catch { /* seletor inválido: sem foco */ }
    if (target && target !== document.activeElement) {
      target.focus({ preventScroll: true });
      if (caret && typeof target.setSelectionRange === "function") {
        try { target.setSelectionRange(caret[0], caret[1]); } catch { /* campo sem seleção */ }
      }
    }
  }
}

// Anexo: lê arquivos de texto pequenos e coloca o conteúdo no rascunho (nada é enviado antes do Enter).
function bindAttach() {
  const btn = $("attachBtn");
  const input = $("attachFile");
  if (!btn || !input) return;
  btn.onclick = () => input.click();
  input.onchange = async () => {
    const parts = [];
    for (const file of [...input.files].slice(0, 5)) {
      if (file.size > 200000) { banner(`${file.name}: grande demais (máx. 200 KB).`); continue; }
      const text = await file.text();
      if (text.slice(0, 2000).includes("\u0000")) { banner(`${file.name}: só arquivos de texto.`); continue; }
      parts.push(`Arquivo ${file.name}:\n\`\`\`\n${text}\n\`\`\``);
    }
    input.value = "";
    if (!parts.length) return;
    const draft = $("draft");
    draft.value = `${draft.value ? draft.value + "\n\n" : ""}${parts.join("\n\n")}`;
    draft.focus();
  };
}

// "Chefe de gabinete": só sugere. Quem decide é você; nada é enviado por este atalho.
function routerHintHtml() {
  const hint = state.routerHint;
  if (!hint) return "";
  const s = hint.suggestion;
  const conf = { alta: "confiança alta", media: "confiança média", baixa: "confiança baixa" }[s.confidence] || "";
  const others = (hint.alternatives || []).map((item) => `<button type="button" class="btn" data-route-use="${esc(item.assistantId)}">${esc(item.name)}</button>`).join(" ");
  return `<div class="router-hint" id="routerHint">
    <p><strong>Sugestão: ${esc(s.name)}</strong> <span class="chip">${esc(conf)}</span> <span class="muted">${esc(s.reason)}${s.why && s.why.length ? ` Palavras: ${esc(s.why.join(", "))}.` : ""} É só uma sugestão, nada foi enviado.</span></p>
    <div class="row"><button type="button" class="btn primary" data-route-use="${esc(s.assistantId)}">Abrir conversa com ${esc(s.name)}</button> ${others} <button type="button" class="btn" id="routeClose">Fechar</button></div>
  </div>`;
}

function bindRouter() {
  const btn = $("routeBtn");
  if (btn) {
    btn.onclick = async () => {
      const text = $("draft").value.trim();
      if (!text) { banner("Escreva o pedido no campo e eu sugiro quem cuida dele."); return; }
      try {
        state.routerHint = { ...(await call("POST", "/api/roteador", { texto: text })), text };
        renderChat();
      } catch (err) { banner(err.message); }
    };
  }
  const close = $("routeClose");
  if (close) close.onclick = () => { state.routerHint = null; renderChat(); };
  document.querySelectorAll("[data-route-use]").forEach((button) => {
    button.onclick = async () => {
      try {
        const text = state.routerHint ? state.routerHint.text : "";
        const data = await call("POST", "/api/conversations", { assistantId: button.dataset.routeUse });
        state.assistantId = button.dataset.routeUse;
        state.current = data.conversation;
        state.routerHint = null;
        state.pendingDraft = text;
        await loadChat();
      } catch (err) { banner(err.message); }
    };
  });
}

async function sendText(text) {
  if (!state.current) {
    const created = await call("POST", "/api/conversations", { assistantId: state.assistantId });
    state.current = created.conversation;
  }
  const sent = await call("POST", `/api/conversations/${state.current.id}/messages`, { text, level: state.level });
  state.current = sent.conversation;
  renderChat();
  watch(state.current.id);
  refreshConversationList();
}

// A conversa criada pelo primeiro envio (e o preview das outras) só aparecia na lista ao sair e voltar da tela.
async function refreshConversationList() {
  try {
    const data = await call("GET", "/api/conversations");
    state.conversations = data.conversations;
    if (state.view === "chat") renderChat();
  } catch {
    /* a lista se atualiza na próxima visita */
  }
}

const STATE_LABEL = { done: "feito", adjust: "ajuste pedido", denied: "negado", error: "erro", answered: "respondida", dismissed: "dispensada", expired: "expirado: nada foi feito" };
const PARK_REASON = { aprovacao: "falta aprovação", informacao: "falta informação", limite: "limite atingido" };
const HOLD_MS = 1500;

function formatExpires(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "Expirado";
  if (ms < 3600000) return `Expira em ${Math.max(1, Math.ceil(ms / 60000))} min`;
  return `Expira às ${new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
}

function approveBtnHtml(id, holdRequired) {
  if (holdRequired) {
    return `<button type="button" class="btn primary btn-hold" data-hold-approve="${esc(id)}" aria-label="Segure para aprovar"><span class="hold-fill" aria-hidden="true"></span><span>Segure para aprovar</span></button>`;
  }
  return `<button type="button" class="btn primary" data-approve="${esc(id)}">Aprovar</button>`;
}

function bindHoldApproves(root, onApprove) {
  if (!root) return;
  const clear = (btn) => {
    if (btn._holdTimer) clearInterval(btn._holdTimer);
    btn._holdTimer = null;
    const fill = btn.querySelector(".hold-fill");
    if (fill) fill.style.width = "0%";
  };
  root.querySelectorAll("[data-hold-approve]").forEach((btn) => {
    const start = () => {
      clear(btn);
      const fill = btn.querySelector(".hold-fill");
      const t0 = Date.now();
      btn._holdTimer = setInterval(() => {
        const p = Math.min(100, ((Date.now() - t0) / HOLD_MS) * 100);
        if (fill) fill.style.width = `${p}%`;
        if (p >= 100) {
          clear(btn);
          onApprove(btn.dataset.holdApprove);
        }
      }, 40);
    };
    btn.onpointerdown = (e) => { if (e.button === 0) start(); };
    btn.onpointerup = () => clear(btn);
    btn.onpointerleave = () => clear(btn);
    btn.onpointercancel = () => clear(btn);
    btn.onkeydown = (e) => {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      if (e.type === "keydown" && !btn._holdTimer) start();
    };
    btn.onkeyup = (e) => {
      if (e.key === " " || e.key === "Enter") clear(btn);
    };
  });
}

function bindDenyMotivo(root, onDeny) {
  if (!root) return;
  root.querySelectorAll("[data-deny-motivo]").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.denyMotivo;
      const box = root.querySelector(`[data-deny-box="${id}"]`);
      if (box) box.hidden = false;
    };
  });
  root.querySelectorAll("[data-deny-send]").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.denySend;
      const input = root.querySelector(`[data-deny-input="${id}"]`);
      onDeny(id, (input && input.value) || "");
    };
  });
}

function approvalActions(message) {
  const hold = Boolean(message.holdRequired);
  const adjust = hold ? "" : `<button type="button" class="btn" data-adjust="${esc(message.id)}">Ajustar</button>`;
  const note = hold
    ? `<div class="row deny-box" data-deny-box="${esc(message.id)}" hidden><input data-deny-input="${esc(message.id)}" placeholder="Motivo (opcional)"><button type="button" class="btn danger" data-deny-send="${esc(message.id)}">Confirmar negação</button></div>`
    : `<input data-note="${esc(message.id)}" placeholder="O que ajustar (ou por que negar)">`;
  const denyBtn = hold
    ? `<button type="button" class="btn danger" data-deny-motivo="${esc(message.id)}">Negar</button>`
    : `<button type="button" class="btn danger" data-deny="${esc(message.id)}">Negar</button>`;
  return `<div class="row">${approveBtnHtml(message.id, hold)}${adjust}${denyBtn}${note}</div>`;
}

window.HeliosHold = { approveBtnHtml, bindHoldApproves, bindDenyMotivo, formatExpires, HOLD_MS };

function questionActions(message) {
  const options = (message.options || []).map((option) => `<button type="button" class="btn" data-qopt="${esc(message.id)}" data-value="${esc(option)}">${esc(option)}</button>`).join("");
  return `${options ? `<div class="row">${options}</div>` : ""}<div class="row"><input data-answer="${esc(message.id)}" placeholder="Sua resposta"><button type="button" class="btn primary" data-reply="${esc(message.id)}">Responder</button><button type="button" class="btn" data-dismiss="${esc(message.id)}">Dispensar</button></div>`;
}

function accountNoticeFor(message) {
  if (!message.accountIssue || !window.HeliosContas) return "";
  const list = state.current ? state.current.messages : [];
  const isLast = Boolean(list.length) && list[list.length - 1].id === message.id && !state.current.busy;
  return window.HeliosContas.noticeHtml(message, { isLast, switched: state.switched, esc });
}

// Aviso de limite: o HELIOS nunca troca de conta nem repete a mensagem sozinho. Cada botão aqui é um clique seu.
function bindAccountNotices() {
  document.querySelectorAll("[data-switch]").forEach((button) => {
    button.onclick = async () => {
      try {
        await call("POST", "/api/accounts/active", { id: button.dataset.switch });
        state.switched[button.dataset.for] = button.dataset.switchLabel;
        banner(`Conta ativa agora: ${button.dataset.switchLabel}. Nada foi reenviado.`);
        renderChat();
      } catch (err) { banner(err.message); }
    };
  });
  document.querySelectorAll("[data-resend]").forEach((button) => {
    button.onclick = async () => {
      const list = state.current ? state.current.messages : [];
      const at = list.findIndex((message) => message.id === button.dataset.resend);
      const before = list.slice(0, Math.max(at, 0)).reverse().find((message) => message.role === "user");
      if (!before || !before.text) { banner("Não achei a mensagem para reenviar. Escreva de novo no campo."); return; }
      try { await sendText(before.text); } catch (err) { banner(err.message); }
    };
  });
  document.querySelectorAll("[data-goto-account]").forEach((button) => {
    button.onclick = () => setView("account");
  });
}

function renderMessage(message, index) {
  if (message.role === "approval") {
    const pending = message.state === "pending";
    return `<article class="card approval${pending ? " pending" : ""}">
      <p class="eyebrow">${esc(approvalTitle(message.kind, message.auto))}</p>
      <h2>${esc(message.summary)}</h2>
      <p>${esc(message.detail || "")}</p>
      ${message.result ? `<p>${esc(message.result)}</p>` : ""}
      ${pending ? approvalActions(message) : message.state === "expired" ? `<p class="muted">${esc(STATE_LABEL.expired)}</p><div class="row"><button type="button" class="btn primary" data-reopen="${esc(message.id)}">Reabrir</button><button type="button" class="btn danger" data-deny="${esc(message.id)}">Descartar</button></div>` : `<p class="muted">${esc(STATE_LABEL[message.state] || message.state)}</p>`}
    </article>`;
  }
  if (message.role === "question") {
    const pending = message.state === "pending";
    return `<article class="card approval${pending ? " pending" : ""}">
      <p class="eyebrow">Pergunta do HELIOS</p>
      <h2>${esc(message.question)}</h2>
      ${message.answer ? `<p>Você respondeu: ${esc(message.answer)}</p>` : ""}
      ${pending ? questionActions(message) : `<p class="muted">${esc(STATE_LABEL[message.state] || message.state)}</p>`}
    </article>`;
  }
  const who = message.role === "user" ? "Você" : "HELIOS";
  const meta = message.role === "assistant" ? `${message.model || ""} ${message.level ? "· " + message.level : ""} ${message.narration || ""}`.trim() : "";
  const sources = (message.sources || []).map((source) => `<li><a href="${esc(source.url)}" target="_blank" rel="noreferrer">${esc(source.title)}</a> ${esc(source.snippet || "")}</li>`).join("");
  return `<div class="bubble ${esc(message.role)}"><div class="meta">${esc(who)}${meta ? " · " + esc(meta) : ""}</div>${esc(message.text || (message.status === "running" ? "Pensando…" : ""))}${message.aviso ? `<div class="muted">${esc(message.aviso)}</div>` : ""}${sources ? `<ul class="sources">${sources}</ul>` : ""}${accountNoticeFor(message)}${voice && message.role === "assistant" && message.text && message.status !== "running" ? voice.ui.speakButton(index) : ""}</div>`;
}

function bindApprovals() {
  document.querySelectorAll("[data-deny]").forEach((button) => {
    button.onclick = () => decide(button.dataset.deny, "deny", document.querySelector(`[data-note="${button.dataset.deny}"]`)?.value || "");
  });
  document.querySelectorAll("[data-qopt]").forEach((button) => {
    button.onclick = () => answer(button.dataset.qopt, button.dataset.value);
  });
  document.querySelectorAll("[data-reply]").forEach((button) => {
    button.onclick = () => answer(button.dataset.reply, document.querySelector(`[data-answer="${button.dataset.reply}"]`)?.value || "");
  });
  document.querySelectorAll("[data-dismiss]").forEach((button) => {
    button.onclick = () => answer(button.dataset.dismiss, "", true);
  });
  document.querySelectorAll("[data-reopen]").forEach((button) => {
    button.onclick = () => decide(button.dataset.reopen, "reopen");
  });
  document.querySelectorAll("[data-approve]").forEach((button) => {
    button.onclick = () => decide(button.dataset.approve, "approve");
  });
  document.querySelectorAll("[data-adjust]").forEach((button) => {
    button.onclick = () => {
      const note = document.querySelector(`[data-note="${button.dataset.adjust}"]`)?.value || "";
      decide(button.dataset.adjust, "adjust", note);
    };
  });
}

async function decide(id, decision, note) {
  try {
    const data = await call("POST", `/api/conversations/${state.current.id}/approvals/${id}`, { decision, note });
    state.current = data.conversation;
    renderChat();
  } catch (err) {
    banner(err.message);
  }
}

async function answer(id, text, dismiss) {
  try {
    const data = await call("POST", `/api/conversations/${state.current.id}/questions/${id}`, { answer: text, dismiss: Boolean(dismiss) });
    state.current = data.conversation;
    renderChat();
    if (state.current.busy) watch(state.current.id);
  } catch (err) {
    banner(err.message);
  }
}

function watch(id) {
  clearInterval(state.poll);
  state.poll = setInterval(async () => {
    if (state.view !== "chat" || !state.current || state.current.id !== id) {
      clearInterval(state.poll);
      return;
    }
    try {
      const data = await call("GET", `/api/conversations/${id}`);
      state.current = data.conversation;
      renderChat();
      if (!state.current.busy) {
        clearInterval(state.poll);
        refreshConversationList();
      }
    } catch (err) {
      banner(err.message);
      clearInterval(state.poll);
    }
  }, 500);
}

const ORIGIN_LABEL = { conversa: "Conversa", rotina: "Rotina", mcp: "MCP", ajudante: "Ajudante" };
const KIND_LABEL = { assistente: "Aprovar a criação de assistente", rotina: "Aprovar o agendamento de rotina" };
const approvalTitle = (tipo, auto) => KIND_LABEL[tipo] || `${auto ? "Feito sozinho: " : "Aprovar antes de "}${tipo}`;

const cardAttrs = (item) => (item.agentId ? `data-conv-id="" data-agent-id="${esc(item.agentId)}"` : `data-conv-id="${esc(item.convId)}"`);
const openBtn = (item) => (item.agentId ? `<button type="button" class="btn" data-open-agent="${esc(item.agentId)}">Abrir agente</button>` : `<button type="button" class="btn" data-open="${esc(item.convId)}">Abrir conversa</button>`);

function inboxCard(item) {
  const when = item.at ? new Date(item.at).toLocaleString("pt-BR") : "";
  const head = `<p class="eyebrow"><span class="chip">${esc(item.originLabel || ORIGIN_LABEL[item.origin] || "Conversa")}</span> ${esc(item.convTitle)} · ${esc(item.assistantName || "HELIOS")} · ${esc(when)}</p>`;
  if (item.kind === "question") {
    const parked = item.parked;
    const parkedInfo = parked ? `<div class="parked">
        <p class="eyebrow">Tarefa estacionada${parked.motivo ? ` · ${esc(PARK_REASON[parked.motivo] || parked.motivo)}` : ""}</p>
        <p><strong>${esc(parked.objetivo)}</strong></p>
        ${parked.feito.length ? `<p class="muted">Já feito: ${esc(parked.feito.join("; "))}</p>` : ""}
        ${parked.falta.length ? `<p class="muted">Falta: ${esc(parked.falta.join("; "))}</p>` : ""}
        <p class="muted">“Retomar” continua do estado salvo, sem refazer o que já foi feito. Pagar e preencher login continuam pedindo antes.</p>
      </div>` : "";
    return `<article class="card approval pending" ${cardAttrs(item)}>${head}
      <p class="eyebrow">${parked ? "Estacionada, esperando você" : item.agentId ? "Pergunta do agente" : "Pergunta do HELIOS"}</p><h2>${esc(item.summary)}</h2>${parkedInfo}
      ${questionActions({ id: item.id, options: item.options })}
      <div class="row">${openBtn(item)}</div></article>`;
  }
  const validade = item.expiresAt ? `<p class="muted">${esc(formatExpires(item.expiresAt))}. Depois disso expira e nada é feito.</p>` : "";
  const exata = item.acaoExata ? `<pre>${esc(item.acaoExata)}</pre>` : "";
  return `<article class="card approval pending" ${cardAttrs(item)}>${head}
    <p class="eyebrow">${esc(approvalTitle(item.tipo, false))}</p><h2>${esc(item.summary)}</h2><p>${esc(item.detail)}</p>${exata}${validade}
    ${approvalActions({ id: item.id, holdRequired: item.holdRequired })}
    <div class="row">${openBtn(item)}</div></article>`;
}

function expiredCard(item) {
  const when = item.expiredAt ? new Date(item.expiredAt).toLocaleString("pt-BR") : "";
  return `<article class="card approval" data-conv-id="${esc(item.convId)}">
    <p class="eyebrow"><span class="chip">${esc(item.originLabel || ORIGIN_LABEL[item.origin] || "Conversa")}</span> ${esc(item.convTitle)} · expirou ${esc(when)}</p>
    <p class="eyebrow">${esc(approvalTitle(item.tipo, false))} · expirado</p><h2>${esc(item.summary)}</h2><p>${esc(item.detail || "")}</p>
    <p class="muted">Ninguém respondeu a tempo, então nada foi feito. Reabra se ainda quiser decidir.</p>
    <div class="row"><button type="button" class="btn primary" data-reopen="${esc(item.id)}">Reabrir</button><button type="button" class="btn danger" data-deny="${esc(item.id)}">Descartar</button><button type="button" class="btn" data-open="${esc(item.convId)}">Abrir conversa</button></div></article>`;
}

async function refreshInbox() {
  const data = await call("GET", "/api/inbox");
  paintInboxBadge(data.count);
  return data;
}

function paintInboxBadge(count) {
  const badge = $("inboxBadge");
  if (!badge) return;
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.classList.toggle("hidden", !count);
  badge.setAttribute("aria-label", `${count} pendentes`);
}

async function loadInbox() {
  const data = await refreshInbox();
  const kept = {};
  document.querySelectorAll("#view input").forEach((el) => {
    const key = el.dataset.note ? `note:${el.dataset.note}` : el.dataset.answer ? `answer:${el.dataset.answer}` : "";
    if (key) kept[key] = el.value;
  });
  const expired = data.expired || [];
  const pendingHtml = data.items.length
    ? `<div class="stack inbox">${data.items.map(inboxCard).join("")}</div>`
    : `<div class="empty">Nada esperando por você. Aprovações e perguntas de todas as conversas e rotinas aparecem aqui.</div>`;
  const expiredHtml = expired.length
    ? `<h2 class="section-title">Expirados (${expired.length})</h2><div class="stack inbox">${expired.map(expiredCard).join("")}</div>`
    : "";
  shell(pendingHtml + expiredHtml);
  document.querySelectorAll("#view [data-note]").forEach((el) => { if (kept[`note:${el.dataset.note}`]) el.value = kept[`note:${el.dataset.note}`]; });
  document.querySelectorAll("#view [data-answer]").forEach((el) => { if (kept[`answer:${el.dataset.answer}`]) el.value = kept[`answer:${el.dataset.answer}`]; });
  const convOf = (el) => el.closest("[data-conv-id]").dataset.convId;
  const act = async (path, body) => {
    try {
      // LEVA I: cartões de agente vão para a API dos agentes.
      const m = path.match(/^\/api\/conversations\/\/(approvals|questions)\/(.+)$/);
      const agentCard = m && document.querySelector(`#view [data-agent-id] [data-approve="${m[2]}"], #view [data-agent-id] [data-hold-approve="${m[2]}"], #view [data-agent-id] [data-deny="${m[2]}"], #view [data-agent-id] [data-deny-send="${m[2]}"], #view [data-agent-id] [data-qopt="${m[2]}"], #view [data-agent-id] [data-reply="${m[2]}"], #view [data-agent-id] [data-dismiss="${m[2]}"]`);
      if (m && agentCard) {
        const agentId = agentCard.closest("[data-agent-id]").dataset.agentId;
        if (m[1] === "approvals") await call("POST", `/api/agentes/${agentId}/aprovacao/${m[2]}`, { decision: body.decision === "approve" ? "approve" : "deny", motivo: body.motivo || body.note || "" });
        else await call("POST", `/api/agentes/${agentId}/resposta/${m[2]}`, { answer: body.dismiss ? "(sem resposta: siga sem isso)" : body.answer });
        await loadInbox();
        return;
      }
      await call("POST", path, body);
      await loadInbox();
    } catch (err) { banner(err.message); }
  };
  const viewRoot = document.getElementById("view");
  bindHoldApproves(viewRoot, (id) => {
    const card = viewRoot.querySelector(`[data-hold-approve="${id}"]`)?.closest("[data-agent-id], [data-conv-id]");
    if (card?.dataset.agentId) act(`/api/conversations//approvals/${id}`, { decision: "approve" });
    else if (card?.dataset.convId) act(`/api/conversations/${card.dataset.convId}/approvals/${id}`, { decision: "approve" });
  });
  bindDenyMotivo(viewRoot, (id, motivo) => {
    const card = viewRoot.querySelector(`[data-deny-send="${id}"]`)?.closest("[data-agent-id], [data-conv-id]");
    if (card?.dataset.agentId) act(`/api/conversations//approvals/${id}`, { decision: "deny", motivo, note: motivo });
    else if (card?.dataset.convId) act(`/api/conversations/${card.dataset.convId}/approvals/${id}`, { decision: "deny", note: motivo });
  });
  document.querySelectorAll("#view [data-approve]").forEach((b) => { b.onclick = () => act(`/api/conversations/${convOf(b)}/approvals/${b.dataset.approve}`, { decision: "approve" }); });
  document.querySelectorAll("#view [data-adjust]").forEach((b) => { b.onclick = () => act(`/api/conversations/${convOf(b)}/approvals/${b.dataset.adjust}`, { decision: "adjust", note: document.querySelector(`#view [data-note="${b.dataset.adjust}"]`)?.value || "" }); });
  document.querySelectorAll("#view [data-deny]").forEach((b) => {
    if (b.dataset.denyMotivo) return;
    b.onclick = () => act(`/api/conversations/${convOf(b)}/approvals/${b.dataset.deny}`, { decision: "deny", note: document.querySelector(`#view [data-note="${b.dataset.deny}"]`)?.value || "" });
  });
  document.querySelectorAll("#view [data-qopt]").forEach((b) => { b.onclick = () => act(`/api/conversations/${convOf(b)}/questions/${b.dataset.qopt}`, { answer: b.dataset.value }); });
  document.querySelectorAll("#view [data-reply]").forEach((b) => { b.onclick = () => act(`/api/conversations/${convOf(b)}/questions/${b.dataset.reply}`, { answer: document.querySelector(`#view [data-answer="${b.dataset.reply}"]`)?.value || "" }); });
  document.querySelectorAll("#view [data-dismiss]").forEach((b) => { b.onclick = () => act(`/api/conversations/${convOf(b)}/questions/${b.dataset.dismiss}`, { dismiss: true }); });
  document.querySelectorAll("#view [data-reopen]").forEach((b) => { b.onclick = () => act(`/api/conversations/${convOf(b)}/approvals/${b.dataset.reopen}`, { decision: "reopen" }); });
  document.querySelectorAll("#view [data-open]").forEach((b) => { b.onclick = () => openConversation(b.dataset.open); });
  document.querySelectorAll("#view [data-open-agent]").forEach((b) => { b.onclick = () => window.HeliosAgents?.open(b.dataset.openAgent); });
}

async function openConversation(id) {
  try {
    const data = await call("GET", `/api/conversations/${id}`);
    state.current = data.conversation;
    setView("chat");
  } catch (err) {
    banner(err.message);
  }
}

setInterval(async () => {
  if (document.hidden) return;
  try {
    if (state.view === "inbox") {
      const typing = [...document.querySelectorAll("#view input")].some((el) => el.value || el === document.activeElement);
      if (typing) await refreshInbox();
      else await loadInbox();
    } else if (state.view === "activity") {
      const editing = [...document.querySelectorAll("#view input")].some((el) => el === document.activeElement);
      await refreshInbox();
      if (!editing) await loadActivity();
    } else {
      await refreshInbox();
    }
  } catch { /* o próximo ciclo tenta de novo */ }
}, 4000);

async function loadVault() {
  const data = await helios.vaultList();
  const plats = data.logins.filter((entry) => entry.categoria === "plataforma");
  const platRows = plats.map((entry) => `<div class="status-line plat-row"><div><strong>${esc(entry.nome)}</strong><div class="muted">${esc(entry.url || "")}${entry.usuario ? " · " + esc(entry.usuario) : ""}</div></div><div class="row"><button type="button" class="btn danger" data-del="${esc(entry.id)}">Remover</button></div></div>`).join("");
  const rows = [...data.logins.filter((entry) => entry.categoria !== "plataforma"), ...data.tokens].map((entry) => `
    <div class="status-line">
      <div><strong>${esc(entry.nome)}</strong><div class="muted">${esc(entry.tipo)}${entry.usuario ? " · " + esc(entry.usuario) : ""} · ${entry.senhaDefinida || entry.valorDefinido ? "definido" : "sem valor"}</div></div>
      <div class="row"><button type="button" class="btn" data-edit="${esc(entry.id)}">Editar</button><button type="button" class="btn danger" data-del="${esc(entry.id)}">Remover</button></div>
    </div>`).join("");
  const blockedCard = data.blocked ? `
    <div class="card stack" id="vaultBlocked" role="alert">
      <h2>O cofre não abriu</h2>
      <p>${esc(data.blockedMessage)}</p>
      <div class="row"><button type="button" class="btn danger" id="vaultStartFresh">Começar um cofre novo</button></div>
    </div>` : "";
  const k = data.keys || {};
  const platCard = `<div class="card stack" id="vaultPlat" style="margin-bottom:12px"><h2 title="Sites de vagas. O HELIOS entra sozinho quando a sessão expira e lê o código de verificação no Gmail.">Plataformas</h2>
      <div class="row"><label>E-mail padrão<input id="platEmail" value="${esc(k.plataformaEmail || "")}" autocomplete="off"></label>
      <label title="A mesma senha para todas as plataformas. Fica criptografada e nunca aparece de novo.">Senha padrão<input id="platSenha" type="password" placeholder="${k.hasPlatformPassword ? "salva — digite para trocar" : ""}" autocomplete="new-password"></label>
      <button type="button" class="btn" id="platPadrao">Salvar</button></div>
      ${platRows || `<div class="empty">Nenhuma plataforma.</div>`}
      <form class="row" id="platForm"><label>Nome<input id="platNome" required placeholder="Gupy"></label><label>Link de login<input id="platUrl" required placeholder="https://"></label><button class="btn primary" type="submit">Adicionar</button></form>
    </div>`;
  shell(`
    ${blockedCard}
    ${platCard}
    <div class="grid-2">
      <form class="card stack" id="vaultForm">
        <h2>Adicionar ou editar</h2>
        <input type="hidden" id="vaultId">
        <label>Tipo<select id="vaultTipo"><option value="login">Login</option><option value="token">Token</option></select></label>
        <label>Nome<input id="vaultNome" required placeholder="GitHub"></label>
        <label>Usuário<input id="vaultUsuario" placeholder="só para login"></label>
        <label>Senha ou token<input id="vaultSenha" type="password" placeholder="vazio ao editar = manter" autocomplete="off"></label>
        <label>Endereço<input id="vaultUrl" placeholder="https://"></label>
        <label>Notas<input id="vaultNotas"></label>
        <button class="btn primary" type="submit">Salvar no cofre</button>
        <p class="muted">${data.blocked ? "Cofre bloqueado: nada será gravado até você restaurar a cópia ou começar um cofre novo." : data.persisted ? "Criptografado com safeStorage neste computador." : "Sem criptografia do sistema: nada foi gravado em disco."}</p>
      </form>
      <div class="card stack">
        <h2>Chaves de reunião</h2>
        <p class="muted">As mesmas chaves da pílula. Groq transcreve. Gemini fica de reserva e lê a tela.</p>
        <label>Groq <input id="keyGroq" type="password" placeholder="${data.keys.hasGroqKey ? "chave salva — cole para trocar" : "gsk_…"}" autocomplete="off"></label>
        <label>Gemini <input id="keyGemini" type="password" placeholder="${data.keys.hasGeminiKey ? "chave salva — cole para trocar" : "AIza…"}" autocomplete="off"></label>
        <button type="button" class="btn" id="saveKeys">Salvar chaves</button>
        <div class="card stack" id="tgCard">
          <h2>Telegram</h2>
          <p class="muted">Controle o HELIOS pelo celular. Crie um bot no @BotFather, cole o token aqui e pareie. Só o seu chat é atendido; o token nunca aparece na tela nem nos logs.</p>
          <label>Token do bot <input id="keyTelegram" type="password" placeholder="${data.keys.hasTelegramKey ? "token salvo — cole para trocar" : "123456:ABC…"}" autocomplete="off"></label>
          <div class="row"><button type="button" class="btn" id="saveTelegram">Salvar token</button><span class="chip" id="tgEstado">…</span></div>
          <div id="tgInfo" class="muted"></div>
          <div class="row"><button type="button" class="btn" id="tgLigar">Ligar</button><button type="button" class="btn" id="tgParear">Gerar código de pareamento</button><button type="button" class="btn" id="tgTeste">Mandar teste</button><button type="button" class="btn danger" id="tgDesparear">Desparear</button></div>
        </div>
        <h2>Itens</h2>
        ${rows || `<div class="empty">O cofre ainda está vazio.</div>`}
      </div>
    </div>`);
  $("platPadrao").onclick = async () => {
    try {
      const email = $("platEmail").value.trim();
      if (email) await helios.setKey("plataformaEmail", email);
      const senha = $("platSenha").value;
      if (senha) await helios.setKey("plataformaSenha", senha);
      $("platSenha").value = "";
      await loadVault();
    } catch (err) { banner(err.message); }
  };
  $("platForm").onsubmit = async (event) => {
    event.preventDefault();
    const url = $("platUrl").value.trim();
    if (!/^https:\/\//i.test(url)) { banner("O link precisa começar com https://."); return; }
    try {
      const saved = await helios.vaultSave({ tipo: "login", nome: $("platNome").value, url, categoria: "plataforma" });
      if (saved && saved.blocked) { banner(saved.error); return; }
      await loadVault();
    } catch (err) { banner(err.message); }
  };
  $("vaultForm").onsubmit = async (event) => {
    event.preventDefault();
    const tipo = $("vaultTipo").value;
    const entry = {
      id: $("vaultId").value || undefined,
      tipo,
      nome: $("vaultNome").value,
      usuario: $("vaultUsuario").value,
      url: $("vaultUrl").value,
      notas: $("vaultNotas").value,
    };
    if (tipo === "token") entry.valor = $("vaultSenha").value;
    else entry.senha = $("vaultSenha").value;
    try {
      const saved = await helios.vaultSave(entry);
      if (saved && saved.blocked) {
        banner(saved.error);
        return;
      }
      await loadVault();
    } catch (err) {
      banner(err.message);
    }
  };
  if ($("vaultStartFresh")) {
    $("vaultStartFresh").onclick = async () => {
      if (!window.confirm("Começar um cofre novo? Logins, tokens e chaves do cofre atual ficam fora do HELIOS. O arquivo atual é copiado para a pasta backups antes, mas só dá para recuperá-lo manualmente. Confirma?")) return;
      const out = await helios.vaultStartFresh();
      if (!out || !out.ok) {
        banner(out?.error || "Não consegui começar um cofre novo.");
        return;
      }
      banner(`Cofre novo criado. Cópia do anterior: ${out.backup || "sem arquivo anterior"}`);
      await loadVault();
    };
  }
  const tgPaint = (t) => {
    if (!$("tgEstado")) return;
    $("tgEstado").textContent = t.ligado ? (t.rodando ? "ligado" : "ligado (sem conexão)") : "desligado";
    $("tgLigar").textContent = t.ligado ? "Desligar" : "Ligar";
    $("tgLigar").dataset.on = t.ligado ? "1" : "";
    $("tgInfo").textContent = !t.temToken ? "Sem token salvo."
      : t.pareado ? `Pareado${t.dono ? " com " + t.dono : ""}. Comandos: /status, /vagas, /parar.`
      : t.codigo ? `No Telegram, mande para o seu bot: /parear ${t.codigo} (vale 15 minutos).`
      : "Ainda não pareado. Gere um código.";
    if (t.erro) $("tgInfo").textContent += ` Último erro: ${t.erro}`;
  };
  const tgRun = async (fn) => { try { const out = await fn(); if (out && out.telegram) tgPaint(out.telegram); } catch (err) { banner(err.message); } };
  tgRun(() => call("GET", "/api/telegram"));
  $("saveTelegram").onclick = () => tgRun(async () => {
    const value = $("keyTelegram").value.trim();
    if (!value) throw new Error("Cole o token do @BotFather.");
    const saved = await helios.setKey("telegram", value);
    if (saved && saved.blocked) throw new Error(saved.error);
    $("keyTelegram").value = "";
    $("keyTelegram").placeholder = "token salvo — cole para trocar";
    return call("POST", "/api/telegram/ligar", { ligado: true });
  });
  $("tgLigar").onclick = () => tgRun(() => call("POST", "/api/telegram/ligar", { ligado: !$("tgLigar").dataset.on }));
  $("tgParear").onclick = () => tgRun(() => call("POST", "/api/telegram/codigo", {}));
  $("tgDesparear").onclick = () => tgRun(() => call("POST", "/api/telegram/desparear", {}));
  $("tgTeste").onclick = () => tgRun(async () => { const r = await call("POST", "/api/telegram/teste", {}); banner(r.enviado ? "Teste enviado." : "Não enviou: confira token, ligado e pareamento."); return call("GET", "/api/telegram"); });
  $("saveKeys").onclick = async () => {
    let blocked = "";
    for (const [name, field] of [["groq", "keyGroq"], ["gemini", "keyGemini"]]) {
      const value = $(field).value.trim();
      if (!value) continue;
      const saved = await helios.setKey(name, value);
      if (saved && saved.blocked) blocked = saved.error;
    }
    if (blocked) {
      banner(blocked);
      return;
    }
    await loadVault();
  };
  document.querySelectorAll("[data-edit]").forEach((button) => {
    button.onclick = async () => {
      const entry = await helios.vaultGet(button.dataset.edit);
      $("vaultId").value = entry.id;
      $("vaultTipo").value = entry.tipo;
      $("vaultNome").value = entry.nome || "";
      $("vaultUsuario").value = entry.usuario || "";
      // O valor salvo nunca chega à tela: só se está "definido".
      $("vaultSenha").value = "";
      $("vaultSenha").placeholder = entry.senhaDefinida || entry.valorDefinido ? "definido — vazio mantém; cole para trocar" : "vazio";
      $("vaultUrl").value = entry.url || "";
      $("vaultNotas").value = entry.notas || "";
    };
  });
  document.querySelectorAll("[data-del]").forEach((button) => {
    button.onclick = async () => {
      if (!window.confirm("Remover este item do cofre? Isso não dá para desfazer.")) return;
      const removed = await helios.vaultRemove(button.dataset.del);
      if (removed && removed.blocked) {
        banner(removed.error);
        return;
      }
      await loadVault();
    };
  });
}

let mcpGallery = null;
async function loadMcp() {
  const data = await call("GET", "/api/mcp");
  const rows = data.servers.map((server) => {
    const pending = server.type === "stdio" && !server.confirmed;
    const command = [server.command, ...(server.args || [])].filter(Boolean).join(" ");
    return `
    <div class="status-line">
      <div><span class="dot ${esc(server.status === "online" ? "online" : server.status === "offline" ? "offline" : "")}"></span><strong>${esc(server.name)}</strong>
        <div class="muted">${esc(server.type)} · ${esc(server.status)} · ${server.toolCount || 0} ferramentas ${server.error ? "· " + esc(server.error) : ""}</div>
        ${pending ? `<div class="muted">Confirme antes de rodar: ${esc(command)}</div>` : ""}
      </div>
      <div class="row">${pending ? `<button type="button" class="btn primary" data-confirm="${esc(server.id)}">Confirmar comando</button>` : `<button type="button" class="btn" data-test="${esc(server.id)}">Testar</button>`}<button type="button" class="btn danger" data-rm="${esc(server.id)}">Remover</button></div>
    </div>`;
  }).join("");
  const manual = rows
    ? `<h2>Servidores</h2>${rows}`
    : `<div class="empty">Nenhum servidor manual ainda.</div>`;
  const paintMcp = () => {
    const form = $("mcpForm");
    if (form) form.onsubmit = async (event) => {
      event.preventDefault();
      const fields = new FormData(form);
      try {
        await call("POST", "/api/mcp", {
          name: fields.get("name"),
          type: fields.get("type"),
          command: fields.get("command"),
          args: String(fields.get("args") || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
          env: String(fields.get("env") || ""),
          url: fields.get("url"),
        });
        await loadMcp();
      } catch (err) { banner(err.message); }
    };
    document.querySelectorAll("[data-confirm]").forEach((button) => {
      button.onclick = async () => {
        try { await call("POST", `/api/mcp/${button.dataset.confirm}/confirm`, {}); await loadMcp(); }
        catch (err) { banner(err.message); }
      };
    });
    document.querySelectorAll("[data-test]").forEach((button) => {
      button.onclick = async () => {
        button.disabled = true;
        try { await call("POST", `/api/mcp/${button.dataset.test}/test`, {}); await loadMcp(); }
        catch (err) { banner(err.message); }
      };
    });
    document.querySelectorAll("[data-rm]").forEach((button) => {
      button.onclick = async () => { await call("DELETE", `/api/mcp/${button.dataset.rm}`); await loadMcp(); };
    });
  };
  if (window.HeliosConectores) {
    if (mcpGallery) mcpGallery.stop();
    mcpGallery = window.HeliosConectores.create({ call, shell, esc, banner, after: paintMcp });
    await mcpGallery.load(manual);
  } else {
    shell(manual);
    paintMcp();
  }
}

function renderSearch(result) {
  const items = (result.results || []).map((item) => `
    <article class="card"><h2><a href="${esc(item.url)}" target="_blank" rel="noreferrer">${esc(item.title)}</a></h2><p>${esc(item.snippet || "")}</p><p class="muted">${esc(item.url)}</p></article>`).join("");
  shell(`
    <form class="row" id="searchForm"><input id="q" placeholder="O que você quer saber?" value="${esc(result.query || "")}"><button class="btn primary" type="submit">Pesquisar</button></form>
    <div class="stack" style="margin-top:12px">${result.error ? `<p class="banner">${esc(result.error)}</p>` : ""}${items || `<div class="empty">As fontes aparecem aqui.</div>`}</div>`);
  $("searchForm").onsubmit = async (event) => {
    event.preventDefault();
    try { renderSearch(await call("POST", "/api/search", { query: $("q").value })); }
    catch (err) { banner(err.message); }
  };
}

async function loadMemory() {
  await refreshAssistants();
  const owner = state.memoryAssistant;
  const data = await call("GET", `/api/memory?assistant=${encodeURIComponent(owner)}`);
  const arch = await call("GET", `/api/memory/arquivo?assistant=${encodeURIComponent(owner)}`);
  const sites = await call("GET", `/api/sites-autorizados?assistant=${encodeURIComponent(owner)}`).catch(() => ({ domains: [] }));
  const KIND_PT = { fato: "fato", preferencia: "preferência", regra: "regra", pendencia: "pendência" };
  const rows = data.items.map((item) => `
    <div class="status-line" data-mem-id="${esc(item.id)}">
      <div>
        <strong>${esc(KIND_PT[item.kind] || item.kind)}</strong>
        <span class="chip">fonte: ${esc(item.source || "—")}</span>
        <div>${esc(item.text)}</div>
        <details class="mem-hist"><summary>Histórico de correção</summary><div class="muted" data-hist-for="${esc(item.id)}">Abrindo…</div></details>
      </div>
      <div class="row">
        <button type="button" class="btn" data-edit-mem="${esc(item.id)}">Corrigir</button>
        <button type="button" class="btn" data-close-mem="${esc(item.id)}" title="Tira do prompt e guarda no arquivo">Fechar</button>
        <button type="button" class="btn danger" data-forget="${esc(item.id)}">Esquecer</button>
      </div>
    </div>`).join("");
  const archRows = arch.items.slice(0, 50).map((item) => `
    <div class="status-line"><div><strong>${esc(KIND_PT[item.kind] || item.kind)}</strong> <span class="chip">${item.archiveReason === "antigo" ? "antigo" : "fechado"}</span><div class="muted">${esc(item.text)}</div></div><button type="button" class="btn" data-reopen-mem="${esc(item.id)}">Reabrir</button></div>`).join("");
  shell(`
    <label class="pick">Memória do assistente
      <select id="memAssistant">${assistantOptions(owner)}</select>
    </label>
    <form class="card stack" id="memSitesForm"><h2>Sites autorizados</h2>
      <p class="muted">Login do perfil principal só é reaproveitado nestes domínios (sessão de tarefa isolada).</p>
      <label>Domínios (um por linha)<textarea name="domains" rows="3" placeholder="linkedin.com&#10;gmail.com">${esc((sites.domains || []).join("\n"))}</textarea></label>
      <button class="btn primary" type="submit">Salvar sites</button></form>
    <form class="card stack" id="memForm" style="margin-top:12px"><h2>Lembrar</h2>
      <label>Tipo<select name="kind"><option value="fato">fato</option><option value="preferencia">preferência</option><option value="regra">regra</option><option value="pendencia">pendência</option></select></label>
      <label>Texto<input name="text" required placeholder="Prefiro respostas curtas em português."></label>
      <button class="btn primary" type="submit">Guardar</button></form>
    <div class="card" style="margin-top:12px"><div class="row"><h2>Ativa (${data.items.length})</h2><button type="button" class="btn" id="memCompact" title="Arquiva o que está fechado e os itens mais antigos se passar do teto">Enxugar agora</button></div>${rows || `<div class="empty">Ainda não há memória.</div>`}</div>
    <details class="card" style="margin-top:12px"><summary>Arquivo (${arch.items.length}) · fora do prompt, nada é apagado</summary>${archRows || `<div class="empty">Arquivo vazio.</div>`}</details>
    <form class="card stack" id="obsForm" style="margin-top:12px"><h2>Obsidian</h2>
      <label>Pasta do cofre<input name="pasta" placeholder="C:\\Users\\…\\Obsidian\\MeuCofre"></label>
      <button class="btn primary" type="submit">Importar</button></form>`);
  if ($("obsForm")) {
    $("obsForm").onsubmit = async (event) => {
      event.preventDefault();
      const pasta = new FormData(event.target).get("pasta");
      try {
        const r = await call("POST", "/api/obsidian/importar", { pasta });
        banner(r.ok === false ? (r.error || "Não importei.") : "Notas importadas para a memória.");
        await loadMemory();
      } catch (err) { banner(err.message); }
    };
  }
  if ($("memSitesForm")) {
    $("memSitesForm").onsubmit = async (event) => {
      event.preventDefault();
      const raw = new FormData(event.target).get("domains");
      const domains = String(raw || "").split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
      try { await call("POST", "/api/sites-autorizados", { assistantId: owner, domains }); banner("Sites autorizados salvos."); await loadMemory(); }
      catch (err) { banner(err.message); }
    };
  }
  $("memCompact").onclick = async () => {
    try { await call("POST", "/api/memory/enxugar", { assistantId: owner }); await loadMemory(); }
    catch (err) { banner(err.message); }
  };
  document.querySelectorAll("[data-close-mem]").forEach((button) => {
    button.onclick = async () => { await call("POST", `/api/memory/${button.dataset.closeMem}/fechar`, { assistantId: owner }); await loadMemory(); };
  });
  document.querySelectorAll("[data-reopen-mem]").forEach((button) => {
    button.onclick = async () => { await call("POST", `/api/memory/${button.dataset.reopenMem}/reabrir`, { assistantId: owner }); await loadMemory(); };
  });
  document.querySelectorAll("[data-edit-mem]").forEach((button) => {
    button.onclick = async () => {
      const id = button.dataset.editMem;
      const item = data.items.find((x) => x.id === id);
      if (!item) return;
      const text = window.prompt("Novo texto", item.text);
      if (text == null) return;
      const motivo = window.prompt("Motivo da correção", "correção manual");
      if (!motivo) return;
      try {
        await call("POST", `/api/memory/${id}/corrigir`, { assistantId: owner, text, motivo });
        await loadMemory();
      } catch (err) { banner(err.message); }
    };
  });
  document.querySelectorAll("[data-hist-for]").forEach(async (box) => {
    const id = box.dataset.histFor;
    try {
      const h = await call("GET", `/api/memory/${id}/historico?assistant=${encodeURIComponent(owner)}`);
      const rowsH = (h.items || []).map((e) => `<div class="muted">${esc(e.at)} · ${esc(e.action)}${e.reason ? ` · ${esc(e.reason)}` : ""}${e.prevText ? `<br><span>antes: ${esc(e.prevText)}</span>` : ""}${e.nextText ? `<br><span>depois: ${esc(e.nextText)}</span>` : ""}</div>`).join("");
      box.innerHTML = rowsH || "Sem correções ainda.";
    } catch { box.textContent = "Histórico indisponível."; }
  });
  $("memAssistant").onchange = async () => { state.memoryAssistant = $("memAssistant").value; await loadMemory(); };
  $("memForm").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try { await call("POST", "/api/memory", { text: form.get("text"), kind: form.get("kind"), assistantId: owner }); await loadMemory(); }
    catch (err) { banner(err.message); }
  };
  document.querySelectorAll("[data-forget]").forEach((button) => {
    button.onclick = async () => {
      const motivo = window.prompt("Motivo para esquecer", "removido manualmente") || "esquecido";
      await call("DELETE", `/api/memory/${button.dataset.forget}?assistant=${encodeURIComponent(owner)}`, { motivo });
      await loadMemory();
    };
  });
}

async function loadGatilhos() {
  await refreshAssistants();
  const data = await call("GET", "/api/gatilhos");
  const rows = (data.gatilhos || []).map((g) => `
    <div class="status-line">
      <div>
        <strong>${esc(g.title)}</strong>
        <span class="chip">${esc(g.kind)}</span>
        ${g.enabled ? "" : `<span class="chip">pausado</span>`}
        <div class="muted">${g.clock ? esc(g.clock) : g.everyMinutes ? `a cada ${esc(g.everyMinutes)} min` : ""}${g.event ? `evento: ${esc(g.event)}` : ""} · ${esc(assistantName(g.assistantId || "default"))}</div>
        <div>${esc(g.prompt)}</div>
      </div>
      <div class="row">
        <button type="button" class="btn" data-trg-toggle="${esc(g.id)}" data-on="${g.enabled ? "1" : "0"}">${g.enabled ? "Pausar" : "Retomar"}</button>
        <button type="button" class="btn danger" data-trg-del="${esc(g.id)}">Remover</button>
      </div>
    </div>`).join("");
  const occ = (data.ocorrencias || []).slice(0, 12).map((o) => `
    <div class="status-line"><div><strong>${esc(o.status)}</strong> <span class="muted">${esc(o.at)}</span><div class="muted">${esc(o.key)}</div></div></div>`).join("");
  shell(`
    <form class="card stack" id="trgForm"><h2>Novo gatilho</h2>
      <label>Nome<input name="title" required></label>
      <label>Tipo<select name="kind"><option value="agendado">Agendado</option><option value="evento">Evento</option></select></label>
      <label>Horário (HH:MM)<input name="clock" placeholder="08:30"></label>
      <label>Evento<input name="event" placeholder="email_recebido"></label>
      <label>Assistente<select name="assistantId">${assistantOptions("default")}</select></label>
      <label>O que fazer<textarea name="prompt" required rows="3"></textarea></label>
      <button class="btn primary" type="submit">Registrar</button></form>
    <div class="card" style="margin-top:12px"><h2>Registrados (${(data.gatilhos || []).length})</h2>${rows || `<div class="empty">Nenhum gatilho.</div>`}</div>
    <details class="card" style="margin-top:12px"><summary>Ocorrências recentes</summary>${occ || `<div class="empty">Nenhuma.</div>`}</details>`);
  $("trgForm").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await call("POST", "/api/gatilhos", {
        title: form.get("title"), kind: form.get("kind"), clock: form.get("clock"), event: form.get("event"),
        prompt: form.get("prompt"), assistantId: form.get("assistantId"),
      });
      await loadGatilhos();
    } catch (err) { banner(err.message); }
  };
  document.querySelectorAll("[data-trg-toggle]").forEach((b) => {
    b.onclick = async () => {
      const act = b.dataset.on === "1" ? "pausar" : "retomar";
      await call("POST", `/api/gatilhos/${b.dataset.trgToggle}/${act}`);
      await loadGatilhos();
    };
  });
  document.querySelectorAll("[data-trg-del]").forEach((b) => {
    b.onclick = async () => { await call("DELETE", `/api/gatilhos/${b.dataset.trgDel}`); await loadGatilhos(); };
  });
}

async function loadRoutines() {
  await refreshAssistants();
  const data = await call("GET", "/api/routines");
  const ev = await call("GET", "/api/routines/eventos");
  const evLabel = Object.fromEntries(ev.eventos.map((item) => [item.id, item.label]));
  const DAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const when = (item) => item.event ? `evento: ${esc((evLabel[item.event] || item.event).toLowerCase())}`
    : item.clock ? `${esc(item.clock)}${item.weekdays && item.weekdays.length && item.weekdays.length < 7 ? " · " + item.weekdays.map((day) => DAYS[day]).join(", ") : ""}`
      : "a cada " + esc(item.everyMinutes) + " min";
  const rows = data.routines.map((item) => `
    <div class="status-line"><div><strong>${esc(item.title)}</strong>${item.readOnly ? ` <span class="chip">só leitura</span>` : ""}<div class="muted">${when(item)} · ${item.enabled ? "ligada" : "pausada"} · ${esc(assistantName(item.assistantId || "default"))} · ${item.lastRun ? "última vez " + esc(new Date(item.lastRun).toLocaleString("pt-BR")) : "ainda não rodou"}</div><div>${esc(item.prompt)}</div></div>
      <div class="row"><button type="button" class="btn" data-toggle="${esc(item.id)}" data-enabled="${item.enabled ? "1" : "0"}">${item.enabled ? "Pausar" : "Ligar"}</button><button type="button" class="btn danger" data-remove="${esc(item.id)}">Apagar</button></div></div>`).join("");
  shell(`
    <form class="card stack" id="rotForm"><h2>Nova rotina</h2>
      <label>Nome<input name="title" required></label>
      <label>O que fazer<input name="prompt" required placeholder="Me lembre de revisar o PR"></label>
      <label>Assistente<select name="assistantId">${assistantOptions("default")}</select></label>
      <label>Gatilho<select name="trigger" id="rotTrigger"><option value="horario">Horário</option><option value="intervalo">Intervalo</option><option value="evento">Evento</option></select></label>
      <div class="row" data-trig="horario"><label>Horário<input name="clock" placeholder="09:30"></label><label>Dias<select name="days"><option value="">Todos os dias</option><option value="1,2,3,4,5">Segunda a sexta</option><option value="0,6">Fim de semana</option></select></label></div>
      <div class="row hidden" data-trig="intervalo"><label>A cada minutos<input name="everyMinutes" type="number" min="1"></label></div>
      <div class="row hidden" data-trig="evento"><label>Quando<select name="event">${ev.eventos.map((item) => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join("")}</select></label></div>
      <button class="btn primary" type="submit">Agendar</button></form>
    <div class="card stack" style="margin-top:12px"><h2>Modelos prontos</h2>
      <div class="status-line"><div><strong>Morning Brief</strong><div class="muted">Agenda, e-mails, tarefas, pendências e notas, de segunda a sexta às 07:30. Entra pausado e só lê.</div></div><button type="button" class="btn" id="installBrief">Instalar</button></div>
      <form class="status-line" id="monForm"><div><strong>Monitor</strong><div class="muted">Vigia algo e só avisa quando muda. Entra pausado, só lê; qualquer ação vira cartão de aprovação.</div>
        <div class="row"><label>O que vigiar<input name="target" required placeholder="vagas de UX/UI remotas no LinkedIn"></label><label>A cada minutos<input name="everyMinutes" type="number" min="15" value="60"></label></div></div>
        <button class="btn" type="submit">Criar Monitor</button></form>
      <div class="status-line"><div><strong>Digest da manhã</strong><div class="muted">O resumo antigo, às 08:00, pausado e só leitura.</div></div><button type="button" class="btn" id="installMorning">Instalar</button></div></div>
    <form class="card stack" id="rotTexto" style="margin-top:12px"><h2>Descrever em português</h2>
      <label>Quando e o que fazer<textarea name="texto" rows="3" placeholder="Ex.: toda segunda às 9h me lembre de revisar o backlog"></textarea></label>
      <button class="btn primary" type="submit">Criar</button></form>
    <div class="card" style="margin-top:12px">${rows || `<div class="empty">Nenhuma rotina.</div>`}</div>`);
  const syncTrigger = () => document.querySelectorAll("[data-trig]").forEach((el) => el.classList.toggle("hidden", el.dataset.trig !== $("rotTrigger").value));
  $("rotTrigger").onchange = syncTrigger;
  $("installBrief").onclick = async () => {
    try { await call("POST", "/api/routines/morning-brief", {}); await loadRoutines(); }
    catch (err) { banner(err.message); }
  };
  $("monForm").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try { await call("POST", "/api/routines/monitor", { target: form.get("target"), everyMinutes: form.get("everyMinutes") }); await loadRoutines(); }
    catch (err) { banner(err.message); }
  };
  $("installMorning").onclick = async () => {
    try { await call("POST", "/api/routines/digest-manha", {}); await loadRoutines(); }
    catch (err) { banner(err.message); }
  };
  if ($("rotTexto")) {
    $("rotTexto").onsubmit = async (event) => {
      event.preventDefault();
      const texto = new FormData(event.target).get("texto");
      try {
        await call("POST", "/api/routines/texto", { texto, criar: true });
        await loadRoutines();
        banner("Rotina criada.");
      } catch (err) { banner(err.message); }
    };
  }
  $("rotForm").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      const trigger = form.get("trigger");
      await call("POST", "/api/routines", { title: form.get("title"), prompt: form.get("prompt"), trigger, clock: trigger === "horario" ? form.get("clock") : "", everyMinutes: trigger === "intervalo" ? form.get("everyMinutes") : "", event: trigger === "evento" ? form.get("event") : "", weekdays: form.get("days") || [], assistantId: form.get("assistantId") === "default" ? undefined : form.get("assistantId") });
      await loadRoutines();
    } catch (err) { banner(err.message); }
  };
  document.querySelectorAll("[data-toggle]").forEach((button) => {
    button.onclick = async () => {
      await call("POST", `/api/routines/${button.dataset.toggle}`, { enabled: button.dataset.enabled !== "1" });
      await loadRoutines();
    };
  });
  document.querySelectorAll("[data-remove]").forEach((button) => {
    button.onclick = async () => {
      await call("DELETE", `/api/routines/${button.dataset.remove}`);
      await loadRoutines();
    };
  });
}

async function loadBrain(query = "", openId = "") {
  const data = await call("GET", `/api/brain${query ? "?q=" + encodeURIComponent(query) : ""}`);
  const open = openId ? (await call("GET", `/api/brain/${encodeURIComponent(openId)}`)).note : null;
  const list = query
    ? data.results.map((hit) => `<div class="status-line"><div><button type="button" class="link" data-note="${esc(hit.id)}"><strong>${esc(hit.title)}</strong></button><div class="muted">${esc(hit.snippet)}</div></div>${hit.tags.map((tag) => `<span class="chip">#${esc(tag)}</span>`).join(" ")}</div>`).join("")
    : data.notes.map((note) => `<div class="status-line"><div><button type="button" class="link" data-note="${esc(note.id)}"><strong>${note.pinned ? `<svg class="sb-ico hx-inline" aria-label="Fixada"><use href="#i-pin"/></svg> ` : ""}${esc(note.title)}</strong></button><div class="muted">${esc(new Date(note.updatedAt).toLocaleDateString("pt-BR"))}${note.tags.length ? " · " + note.tags.map((tag) => "#" + esc(tag)).join(" ") : ""}</div></div></div>`).join("");
  shell(`
    <form class="card row" id="brainSearch"><input id="brainQ" placeholder="Pesquisar nas notas" value="${esc(query)}" aria-label="Pesquisar nas notas"><button class="btn" type="submit">Pesquisar</button>${query ? `<button class="btn" type="button" id="brainClear">Limpar</button>` : ""}</form>
    <form class="card stack" id="brainForm" style="margin-top:12px"><h2>${open ? "Editar nota" : "Nova nota"}</h2>
      <input type="hidden" name="id" value="${esc(open ? open.id : "")}">
      <label>Título<input name="title" required value="${esc(open ? open.title : "")}"></label>
      <label>Texto<textarea name="body" rows="8" placeholder="Ideias, aprendizados, links. Use [[Outra nota]] para ligar.">${esc(open ? open.body : "")}</textarea></label>
      <label>Etiquetas<input name="tags" value="${esc(open ? open.tags.join(", ") : "")}" placeholder="carreira, ux, cliente"></label>
      <div class="row"><button class="btn primary" type="submit">Guardar</button>${open ? `<button class="btn" type="button" id="brainPin">${open.pinned ? "Desafixar" : "Fixar"}</button><button class="btn" type="button" id="brainNew">Nova</button><button class="btn danger" type="button" id="brainDel">Apagar</button>` : ""}</div>
      ${open && (open.links.length || open.backlinks.length) ? `<p class="muted">${open.links.length ? "Liga a: " + open.links.map(esc).join(", ") : ""}${open.backlinks.length ? " · Citada por: " + open.backlinks.map((b) => `<button type="button" class="link" data-note="${esc(b.id)}">${esc(b.title)}</button>`).join(", ") : ""}</p>` : ""}
      <p class="muted">Senhas e chaves são recusadas: guarde no Cofre.</p></form>
    <div class="card" style="margin-top:12px">${data.tags.length ? `<div class="row">${data.tags.slice(0, 20).map((t) => `<span class="chip">#${esc(t.tag)} ${t.total}</span>`).join(" ")}</div>` : ""}${list || `<div class="empty">${query ? "Nada encontrado." : "Nenhuma nota ainda."}</div>`}</div>`);
  $("brainSearch").onsubmit = (event) => { event.preventDefault(); loadBrain($("brainQ").value.trim()).catch((err) => banner(err.message)); };
  if ($("brainClear")) $("brainClear").onclick = () => loadBrain().catch((err) => banner(err.message));
  document.querySelectorAll("[data-note]").forEach((button) => { button.onclick = () => loadBrain(query, button.dataset.note).catch((err) => banner(err.message)); });
  $("brainForm").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const payload = { title: form.get("title"), body: form.get("body"), tags: form.get("tags") };
    try {
      const id = form.get("id");
      const out = id ? await call("POST", `/api/brain/${encodeURIComponent(id)}`, payload) : await call("POST", "/api/brain", payload);
      await loadBrain(query, out.note.id);
    } catch (err) { banner(err.message); }
  };
  if (open) {
    $("brainPin").onclick = async () => { await call("POST", `/api/brain/${encodeURIComponent(open.id)}`, { pinned: !open.pinned }); await loadBrain(query, open.id); };
    $("brainNew").onclick = () => loadBrain(query).catch((err) => banner(err.message));
    $("brainDel").onclick = async () => { if (!window.confirm("Apagar esta nota?")) return; await call("DELETE", `/api/brain/${encodeURIComponent(open.id)}`); await loadBrain(query); };
  }
}

const VAGA_STATUS = { nova: "nova", aguardando_aprovacao: "esperando aprovação", aprovada: "aprovada", enviada: "enviada", falhou: "falhou", descartada: "descartada", preparada: "preparada", negada: "negada", auto_iniciada: "automático começou", enviada_auto: "enviada sozinho", critica: "caso crítico", pulada: "pulada", auto_enviando: "enviando" };

/** Leva G: painel "Hoje" do assistente Vagas: resumo, testes, recusas, padrões e feed. */
function vagasHojeHtml(r) {
  const testes = (r.testes || []).slice(0, 6).map((t) => `<div class="status-line"><div><strong>${esc(t.subject)}</strong><div class="muted">${esc(t.empresa || t.from || "")}</div></div></div>`).join("");
  const recusas = (r.recusas || []).slice(0, 8).map((x) => `<div class="status-line"><div><strong>${esc(x.empresa)}</strong>${x.titulo ? ` · ${esc(x.titulo)}` : ""}<div class="muted">${esc(x.motivo || "sem motivo informado")}</div></div></div>`).join("");
  const pad = r.padroes || { top: [], sugestoes: [] };
  const top = (pad.top || []).map((t) => `<span class="chip">${esc(t.termo)} · ${esc(t.vezes)}</span>`).join(" ");
  const sug = (pad.sugestoes || []).slice(0, 4).map((x) => `<li>${esc(x)}</li>`).join("");
  const feed = (r.feed || []).slice(0, 6).map((f) => `<div class="status-line"><div><strong>${esc(f.autor || "Post")}</strong> <span class="chip">nota ${esc(f.score)}</span><div class="muted">${esc(String(f.texto || "").slice(0, 160))}</div></div>${f.url ? `<div class="row"><button type="button" class="link" data-vg-link="${esc(f.url)}">Abrir</button></div>` : ""}</div>`).join("");
  return `<div class="card stack" id="vgHoje"><div class="row" style="justify-content:space-between"><h2>Hoje</h2>
      <div class="row"><button type="button" class="btn primary" id="vgManha" title="Lê os e-mails, atualiza recusas e testes, busca e se inscreve (no Automático) e manda o resumo no Telegram. Para só no que for crítico.">Verificação da manhã</button>
      <button type="button" class="btn" id="vgFeed" title="Só leitura, devagar e no máximo a cada 30 min. Os termos do LinkedIn proíbem automação: use com moderação.">Ler feed do LinkedIn</button>
      <button type="button" class="btn" id="vgImportar" title="Lê a pasta vagas-helison e mostra prévia antes de gravar.">Importar vagas-helison</button>
      <button type="button" class="btn" id="vgRotinaManha" title="Todo dia às 08:30.">Rotina diária</button>
      <button type="button" class="btn" id="vgScan30" title="A cada 30 min: feed + posts salvos + busca. Nascem pausadas.">Rotina 30 min</button>
      <button type="button" class="btn" id="vgConversar" title="Conversa com o assistente Vagas, com contexto e memória próprios.">Conversar</button></div></div>
    <pre class="vg-resumo muted" style="white-space:pre-wrap;margin:0">${esc(r.texto || "")}</pre>
    <div class="vagas-grid">
      <div><h3>Testes</h3>${testes || `<div class="empty">Nenhum.</div>`}</div>
      <div><h3>Recusas</h3>${recusas || `<div class="empty">Nenhuma.</div>`}</div>
      <div><h3 title="Tirado dos motivos das recusas.">Padrões</h3>${top || `<div class="empty">Sem dados.</div>`}${sug ? `<ul>${sug}</ul>` : ""}</div>
    </div>
    ${feed ? `<details><summary>Feed (${(r.feed || []).length})</summary>${feed}</details>` : ""}
  </div>`;
}

async function loadVagas(notice = "") {
  const data = await call("GET", "/api/vagas");
  const resumo = await call("GET", "/api/vagas/resumo").catch(() => null);
  const p = data.prefs;
  const plat = Object.fromEntries(data.plataformas.map((item) => [item.id, item.label]));
  const head = (v) => `<strong>${esc(v.title)}</strong> <span class="chip">${esc(plat[v.platform] || v.platform)}</span> <span class="chip">nota ${esc(v.score)}</span><div class="muted">${esc(v.company)}${v.location ? " · " + esc(v.location) : ""}${v.motivos && v.motivos.length ? " · " + esc(v.motivos.join("; ")) : ""}</div>`;
  const link = (v) => `<button type="button" class="link" data-vg-link="${esc(v.url)}">Ver no site</button>`;
  const waiting = data.vagas.filter((v) => v.status === "aguardando_aprovacao").map((v) => `
    <div class="card pending stack" style="margin-top:12px"><div>${head(v)}</div>
      <label>Carta de apresentação (edite antes de aprovar)<textarea rows="6" data-vg-carta="${esc(v.id)}">${esc(v.carta || "")}</textarea></label>
      <p class="muted">Aprovar libera esta candidatura. O HELIOS abre a vaga já logado e você dá o envio final no site.</p>
      <div class="row"><button type="button" class="btn primary" data-vg-aprovar="${esc(v.id)}">Aprovar envio</button><button type="button" class="btn danger" data-vg-negar="${esc(v.id)}">Negar</button>${link(v)}</div></div>`).join("");
  const approved = data.vagas.filter((v) => v.status === "aprovada").map((v) => `
    <div class="status-line"><div>${head(v)}</div><div class="row"><button type="button" class="btn" data-vg-abrir="${esc(v.id)}">Abrir para enviar</button><button type="button" class="btn" data-vg-ok="${esc(v.id)}">Marcar como enviada</button><button type="button" class="btn danger" data-vg-falhou="${esc(v.id)}">Falhou</button></div></div>`).join("");
  const fresh = data.vagas.filter((v) => v.status === "nova").slice(0, 40).map((v) => `
    <div class="status-line"><div>${head(v)}</div><div class="row">${link(v)}<button type="button" class="btn" data-vg-preparar="${esc(v.id)}">Preparar inscrição</button><button type="button" class="btn danger" data-vg-descartar="${esc(v.id)}">Descartar</button></div></div>`).join("");
  const pf = p.perfil || {};
  const auto = p.modo === "automatico";
  const crit = (data.criticas || []).map((v) => `
    <div class="card pending stack" id="vgCriticaCard" style="margin-top:12px"><div>${head(v)}</div>
      <p><strong>Caso crítico ${esc(v.critico.codigo)}:</strong> ${esc(v.critico.pergunta)}</p>
      <label>Sua resposta (fica guardada para as próximas)<input data-vg-resp="${esc(v.critico.codigo)}"></label>
      <div class="row"><button type="button" class="btn primary" data-vg-responder="${esc(v.critico.codigo)}">Responder e tentar de novo</button><button type="button" class="btn danger" data-vg-pular="${esc(v.critico.codigo)}">Pular vaga</button>${link(v)}</div></div>`).join("");
  const hist = data.historico.slice(0, 30).map((h) => `<div class="status-line"><div><strong>${esc(h.titulo)}</strong> <span class="chip">${esc(VAGA_STATUS[h.status] || h.status)}</span><div class="muted">${esc(h.empresa)} · ${esc(plat[h.plataforma] || h.plataforma)} · ${esc(new Date(h.at).toLocaleString("pt-BR"))}</div></div></div>`).join("");
  const previa = state.vagasPrevia;
  const rsum = previa && previa.resumo ? previa.resumo : null;
  const previaHtml = previa ? `<div class="card pending stack" id="vgImportPrevia" style="margin-top:12px"><h2>Prévia da importação</h2>
      <p class="muted">Nada foi gravado ainda. Confira e confirme.</p>
      <div class="vagas-grid">
        <div><h3>Perfil</h3><p>${esc(previa.perfil?.tituloCurto || previa.perfil?.nome || "")}</p><p class="muted">${esc(previa.perfil?.cidade || "")} · ${esc(previa.perfil?.ingles || "")} · ${esc(previa.perfil?.pretensao || "")}</p></div>
        <div><h3>Resumo</h3><p class="muted">${rsum ? `${esc(rsum.respostas)} respostas · ${esc(rsum.regras)} regras · ${esc(rsum.templates)} modelos · ${esc(rsum.plataformas)} plataformas · ${esc(rsum.historico)} candidaturas · ${esc(rsum.recruiters)} recrutadores` : ""}</p>
          <p>CPF: <span class="chip">${esc(previa.cpfMascarado || "não encontrado")}</span> <span class="muted">(só cofre após confirmar)</span></p></div>
      </div>
      <div class="row"><button type="button" class="btn primary" id="vgImportAplicar" data-previa-id="${esc(previa.id)}">Confirmar importação</button><button type="button" class="btn" id="vgImportCancelar">Cancelar</button></div></div>` : "";
  const adapters = (data.adaptadores || []).map((a) => `<div class="status-line"><div><strong>${esc(a.label)}</strong> <span class="chip">${esc(a.mode)}</span>${a.feedOnly ? ' <span class="chip">só feed</span>' : ""}${a.realTested ? "" : ' <span class="muted">mock/fixture</span>'}<div class="muted">prioridade ${esc(a.priority)}</div></div></div>`).join("");
  shell(`
    ${notice ? `<div class="card muted">${esc(notice)}</div>` : ""}
    ${resumo ? vagasHojeHtml(resumo) : ""}
    ${previaHtml}
    <form class="card stack" id="vgPrefs" style="margin-top:12px"><h2>O que procurar</h2>
      <label>Cargos ou termos (separe por vírgula)<input name="termos" value="${esc(p.termos.join(", "))}"></label>
      <div class="row"><label>Local<input name="local" value="${esc(p.local)}"></label><label>Nota mínima<input name="notaMinima" type="number" min="0" max="100" value="${esc(p.notaMinima)}"></label></div>
      <div class="row"><label>Precisa ter<input name="incluir" value="${esc(p.incluir.join(", "))}" placeholder="remoto, React"></label><label>Evitar<input name="excluir" value="${esc(p.excluir.join(", "))}" placeholder="estágio, presencial"></label></div>
      <div class="row"><label>Ritmo por hora<input name="porHora" type="number" min="1" max="20" value="${esc(p.porHora)}"></label><span class="muted" style="align-self:end;padding-bottom:8px">Sem teto diário</span></div>
      <div class="row">${data.plataformas.map((item) => `<label class="check"><input type="checkbox" name="plataformas" value="${esc(item.id)}"${p.plataformas.includes(item.id) ? " checked" : ""}> ${esc(item.label)}</label>`).join("")}</div>
      <h2>Modo</h2>
      <div class="row"><label>Como se inscrever<select name="modo" id="vgModo"><option value="aprovacao"${auto ? "" : " selected"}>Com aprovação (padrão)</option><option value="automatico"${auto ? " selected" : ""}>Automático</option></select></label><label>Não repetir empresa por (dias)<input name="repetirDias" type="number" min="1" max="365" value="${esc(p.repetirDias || 30)}"></label></div>
      <p class="muted" id="vgAviso" title="No Automático, vagas com nota ≥ mínima são preenchidas e enviadas com o seu contexto.md, o perfil e o currículo. Para só no que for crítico (pretensão sem valor, presencial fora do perfil, pergunta sem resposta, teste, pagamento, captcha, termos novos, anexo além do CV, raça/gênero, dedicação exclusiva). Os termos do LinkedIn proíbem automação: pode levar a bloqueio.">Automático para só no que for crítico. ⓘ</p>
      <label>Empresas para evitar<input name="evitarEmpresas" value="${esc((p.evitarEmpresas || []).join(", "))}" placeholder="Empresa X, Empresa Y"></label>
      <details${auto ? " open" : ""}><summary>Perfil para preencher formulários</summary><div class="stack">
        <div class="row"><label>Nome<input name="pf_nome" value="${esc(pf.nome || "")}"></label><label>E-mail<input name="pf_email" value="${esc(pf.email || "")}"></label><label>Telefone<input name="pf_telefone" value="${esc(pf.telefone || "")}"></label></div>
        <div class="row"><label>Cidade<input name="pf_cidade" value="${esc(pf.cidade || "")}"></label><label>LinkedIn<input name="pf_linkedin" value="${esc(pf.linkedin || "")}"></label><label>Portfólio<input name="pf_portfolio" value="${esc(pf.portfolio || "")}"></label></div>
        <div class="row"><label>Currículo (caminho do PDF)<input name="pf_cvPath" value="${esc(pf.cvPath || "")}" placeholder="C:\\Users\\...\\curriculo.pdf"></label><label>Pretensão salarial<input name="pf_pretensao" value="${esc(pf.pretensao || "")}" placeholder="vazio = perguntar"></label></div>
        <div class="row"><label class="check"><input type="checkbox" name="pf_aceitaPresencial"${pf.aceitaPresencial ? " checked" : ""}> Aceito presencial/híbrido</label><label>Cidades aceitas<input name="pf_cidadesOk" value="${esc((pf.cidadesOk || []).join(", "))}"></label></div>
      </div></details>
      <div class="row"><button class="btn primary" type="submit">Salvar e buscar</button><span class="muted">Última hora: ${esc(data.ritmo.hora)} de ${esc(p.porHora)}</span></div></form>
    <div class="card stack" id="vgAdaptadores" style="margin-top:12px"><h2>Adaptadores</h2>
      <p class="muted">Estado de cada fonte. Os marcados mock/fixture ainda não foram validados ao vivo.</p>
      ${adapters || `<div class="empty">Nenhum.</div>`}</div>
    <div class="card stack" style="margin-top:12px"><h2>Entrar nas plataformas</h2>
      <p class="muted" title="Usa Cofre › Plataformas (ou a senha padrão). A senha nunca vai para o modelo. Código por e-mail: o HELIOS lê no Gmail e digita. Captcha: a janela abre e você recebe um aviso.">Login pelo cofre, com código do Gmail. ⓘ</p>
      <div class="row">${data.plataformas.map((item) => `<button type="button" class="btn" data-vg-login="${esc(item.id)}">Entrar no ${esc(item.label)}</button>`).join("")}<button type="button" class="btn" id="vgJanela">Mostrar janela das vagas</button></div></div>
    ${auto ? `<div class="card stack" style="margin-top:12px"><h2>Automático</h2><p class="muted">${data.autoRodando ? "Rodando agora." : `${esc(data.fila || 0)} vaga(s) na fila.`} Para rodar sozinho de tempos em tempos, crie a rotina.</p><div class="row"><button type="button" class="btn primary" id="vgAutoRodar">Rodar automático agora</button><button type="button" class="btn" id="vgAutoRotina">Criar rotina (a cada 3 h)</button></div></div>` : ""}
    ${crit ? `<h2 style="margin-top:16px">Casos críticos (${(data.criticas || []).length})</h2>${crit}` : ""}
    ${waiting ? `<h2 style="margin-top:16px">Esperando sua aprovação (${data.pendentes})</h2>${waiting}` : ""}
    ${approved ? `<div class="card" style="margin-top:12px"><h2>Aprovadas</h2>${approved}</div>` : ""}
    <div class="card" style="margin-top:12px"><h2>Vagas encontradas</h2>${fresh || `<div class="empty">Nenhuma vaga nova. Ajuste os termos e clique em "Salvar e buscar".</div>`}</div>
    <details class="card" style="margin-top:12px"><summary>Registro de candidaturas</summary>${hist || `<div class="empty">Nada registrado ainda.</div>`}</details>`);
  const run = async (fn) => { try { await fn(); } catch (err) { banner(err.message); } };
  if ($("vgManha")) $("vgManha").onclick = () => run(async () => { $("vgManha").disabled = true; const r = await call("POST", "/api/vagas/verificacao", {}); await loadVagas(r.texto ? "Verificação feita." : ""); });
  if ($("vgFeed")) $("vgFeed").onclick = () => run(async () => { const r = helios.vagasFeed ? await helios.vagasFeed() : { ok: false, error: "Indisponível." }; await loadVagas(r.ok ? `Feed lido: ${r.novos || 0} novo(s).` : r.error); });
  if ($("vgConversar")) $("vgConversar").onclick = () => { state.current = null; state.assistantId = state.assistants && state.assistants.some((a) => a.id === "vagas") ? "vagas" : state.assistantId; setView("chat"); };
  if ($("vgRotinaManha")) $("vgRotinaManha").onclick = () => run(async () => { await call("POST", "/api/routines/vagas-manha", {}); await loadVagas("Rotina diária criada (08:30)."); });
  if ($("vgScan30")) $("vgScan30").onclick = () => run(async () => { await call("POST", "/api/routines/vagas-scan-30", {}); await loadVagas("Rotina de 30 min criada (pausada)."); });
  if ($("vgImportar")) $("vgImportar").onclick = () => run(async () => {
    const r = await call("POST", "/api/vagas/importar/previa", {});
    state.vagasPrevia = r.previa;
    await loadVagas("Prévia da importação pronta — confira o cartão.");
  });
  if ($("vgImportAplicar")) $("vgImportAplicar").onclick = () => run(async () => {
    const id = $("vgImportAplicar").dataset.previaId;
    await call("POST", "/api/vagas/importar/aplicar", { previaId: id, confirmar: true });
    state.vagasPrevia = null;
    await loadVagas("Importação aplicada. Senhas das plataformas: preencha no Cofre.");
  });
  if ($("vgImportCancelar")) $("vgImportCancelar").onclick = () => { state.vagasPrevia = null; loadVagas(); };
  $("vgPrefs").onsubmit = (event) => run(async () => {
    event.preventDefault();
    const form = new FormData(event.target);
    await call("POST", "/api/vagas/preferencias", { termos: form.get("termos"), local: form.get("local"), notaMinima: form.get("notaMinima"), incluir: form.get("incluir"), excluir: form.get("excluir"), porHora: form.get("porHora"), plataformas: form.getAll("plataformas"),
      modo: form.get("modo"), repetirDias: form.get("repetirDias"), evitarEmpresas: form.get("evitarEmpresas"),
      perfil: { nome: form.get("pf_nome"), email: form.get("pf_email"), telefone: form.get("pf_telefone"), cidade: form.get("pf_cidade"), linkedin: form.get("pf_linkedin"), portfolio: form.get("pf_portfolio"), cvPath: form.get("pf_cvPath"), pretensao: form.get("pf_pretensao"), aceitaPresencial: form.get("pf_aceitaPresencial") === "on", cidadesOk: form.get("pf_cidadesOk") } });
    const out = await call("POST", "/api/vagas/buscar", {});
    await loadVagas(`${out.novas} vaga(s) nova(s) acima da nota mínima.${out.semPerfil ? " Seu contexto.md está vazio: a nota usa só os termos." : ""}${out.erros.length ? " Falhas: " + out.erros.join("; ") : ""}`);
  });
  $("vgJanela").onclick = () => run(async () => { await helios.vagasJanela(); });
  if ($("vgAutoRodar")) $("vgAutoRodar").onclick = () => run(async () => { const r = await call("POST", "/api/vagas/auto/rodar", {}); await loadVagas(r.iniciado ? `Automático rodando: ${r.fila} vaga(s) na fila.` : r.motivo); });
  if ($("vgAutoRotina")) $("vgAutoRotina").onclick = () => run(async () => { await call("POST", "/api/routines/vagas-auto", { everyMinutes: 180 }); await loadVagas("Rotina \"Vagas automático\" criada (a cada 3 h). Veja em Rotinas."); });
  document.querySelectorAll("[data-vg-responder]").forEach((b) => { b.onclick = () => run(async () => { const code = b.dataset.vgResponder; const input = document.querySelector(`[data-vg-resp="${code}"]`); await call("POST", `/api/vagas/critica/${encodeURIComponent(code)}/responder`, { resposta: input ? input.value : "" }); await loadVagas("Resposta guardada. A vaga voltou para a fila."); }); });
  document.querySelectorAll("[data-vg-pular]").forEach((b) => { b.onclick = () => run(async () => { await call("POST", `/api/vagas/critica/${encodeURIComponent(b.dataset.vgPular)}/pular`, {}); await loadVagas(); }); });
  document.querySelectorAll("[data-vg-login]").forEach((b) => { b.onclick = () => run(async () => { const r = await helios.vagasLogin(b.dataset.vgLogin); await loadVagas(r.ok ? r.message : r.error); }); });
  document.querySelectorAll("[data-vg-link]").forEach((b) => { b.onclick = () => helios.openExternal(b.dataset.vgLink); });
  document.querySelectorAll("[data-vg-preparar]").forEach((b) => { b.onclick = () => run(async () => { await call("POST", `/api/vagas/${encodeURIComponent(b.dataset.vgPreparar)}/preparar`, {}); await loadVagas(); }); });
  document.querySelectorAll("[data-vg-descartar]").forEach((b) => { b.onclick = () => run(async () => { await call("POST", `/api/vagas/${encodeURIComponent(b.dataset.vgDescartar)}/descartar`, {}); await loadVagas(); }); });
  document.querySelectorAll("[data-vg-aprovar]").forEach((b) => {
    b.onclick = () => run(async () => {
      const id = b.dataset.vgAprovar;
      const carta = document.querySelector(`[data-vg-carta="${CSS.escape(id)}"]`)?.value || "";
      await call("POST", `/api/vagas/${encodeURIComponent(id)}/aprovar`, { confirmar: true, carta });
      await loadVagas("Aprovada. Clique em \"Abrir para enviar\" para concluir no site.");
    });
  });
  document.querySelectorAll("[data-vg-negar]").forEach((b) => { b.onclick = () => run(async () => { await call("POST", `/api/vagas/${encodeURIComponent(b.dataset.vgNegar)}/negar`, {}); await loadVagas(); }); });
  document.querySelectorAll("[data-vg-abrir]").forEach((b) => { b.onclick = () => run(async () => { const r = await helios.vagasAbrir(b.dataset.vgAbrir); await loadVagas(r.ok ? r.message : r.error); }); });
  document.querySelectorAll("[data-vg-ok]").forEach((b) => { b.onclick = () => run(async () => { await call("POST", `/api/vagas/${encodeURIComponent(b.dataset.vgOk)}/resultado`, { ok: true }); await loadVagas(); }); });
  document.querySelectorAll("[data-vg-falhou]").forEach((b) => { b.onclick = () => run(async () => { await call("POST", `/api/vagas/${encodeURIComponent(b.dataset.vgFalhou)}/resultado`, { ok: false }); await loadVagas(); }); });
}

let assistantDraft = null;

async function loadAssistants() {
  const [data, mcp, aut, skillData] = await Promise.all([
    refreshAssistants(),
    call("GET", "/api/mcp"),
    call("GET", "/api/autonomy"),
    call("GET", `/api/skills?assistant=${encodeURIComponent(state.skillAssignAssistant || "default")}`).catch(() => ({ skills: [], filesystem: [], assignments: {}, manifest: [], pending: [] })),
  ]);
  const servers = mcp.servers.map((server) => server.name);
  const draft = assistantDraft;
  const cards = data.assistants.map((item) => `
    <div class="status-line">
      <div><strong>${esc(item.name)}</strong>${item.builtin ? ` <span class="chip">padrão</span>` : ""}${item.createdBy ? ` <span class="chip">criado por ${esc(item.createdBy.name)}</span>` : ""}
        <div class="muted">${esc(item.role || "sem função definida")} · ${item.mcp === null ? "todos os conectores" : item.mcp.length ? "conectores: " + esc(item.mcp.join(", ")) : "sem conectores"}${Object.keys(item.autonomy || {}).length ? " · autonomia própria" : ""}</div>
        ${item.instructions ? `<div>${esc(item.instructions.slice(0, 160))}${item.instructions.length > 160 ? "…" : ""}</div>` : ""}</div>
      <div class="row">
        <button type="button" class="btn" data-ast-chat="${esc(item.id)}">Conversar</button>
        <button type="button" class="btn" data-ast-mem="${esc(item.id)}">Memória</button>
        <button type="button" class="btn" data-ast-imp="${esc(item.id)}" title="Cole um texto ou escolha um .md/.txt. Vira contexto fixo só deste assistente e continua em qualquer conta do Cursor.">Importar contexto</button>
        ${item.builtin ? "" : `<button type="button" class="btn" data-ast-edit="${esc(item.id)}">Editar</button><button type="button" class="btn danger" data-ast-del="${esc(item.id)}">Remover</button>`}
      </div>
      <form class="stack ast-imp" data-ast-impform="${esc(item.id)}" hidden style="width:100%">
        <textarea rows="5" name="texto" placeholder="Cole o contexto aqui"></textarea>
        <div class="row"><input type="file" name="arquivo" accept=".md,.txt,text/plain,text/markdown"><button class="btn primary" type="submit">Importar</button></div>
      </form>
    </div>`).join("");
  const pendingCards = (data.pending || []).map((item) => `
    <div class="status-line">
      <div><strong>${esc(item.name)}</strong> <span class="chip">aguardando aprovação</span> <span class="chip">criado por ${esc(item.createdBy ? item.createdBy.name : "um assistente")}</span>
        <div class="muted">${esc(item.role || "sem função definida")} · ainda não existe: aprove ou negue na Caixa de entrada.</div></div>
    </div>`).join("");
  const templates = data.templates.map((item) => `<button type="button" class="btn" data-ast-tpl="${esc(item.id)}" title="${esc(item.role)}">${esc(item.name)}</button>`).join("");
  const skillRows = (skillData.skills || []).map((item) => `<div class="status-line"><div><strong>${esc(item.name)}</strong><div class="muted">${esc(item.description)}</div></div><button type="button" class="btn danger" data-skill-del="${esc(item.id)}">Remover</button></div>`).join("");
  const fsLines = skillData.filesystem || [];
  const manifestBy = Object.fromEntries((skillData.manifest || []).map((row) => [row.name, row]));
  const fsRows = fsLines.map((line) => {
    const name = String(line).split(":")[0].trim();
    const st = manifestBy[name]?.status;
    const chip = st && st !== "ok" ? ` <span class="chip summary">${esc(st)}</span>` : "";
    const desc = String(line).includes(":") ? String(line).slice(String(line).indexOf(":") + 1).trim() : "";
    return `<div class="status-line"><div><strong>${esc(name)}</strong>${chip}<div class="muted">${esc(desc)}</div></div></div>`;
  }).join("");
  const assignAsst = state.skillAssignAssistant || "default";
  const assigned = new Set(Array.isArray(skillData.assignments) ? skillData.assignments : (skillData.assignments?.[assignAsst] || []));
  const assignChecks = fsLines.map((line) => {
    const name = String(line).split(":")[0].trim();
    return `<label class="check"><input type="checkbox" data-skill-assign="${esc(name)}"${assigned.has(name) ? " checked" : ""}> ${esc(name)}</label>`;
  }).join("");
  const pendingSkill = (skillData.pending || []).map((p) => `<div class="status-line"><div><strong>${esc(p.source || p.approvalId)}</strong>${p.license ? `<div class="muted">Licença: ${esc(p.license)}</div>` : ""}</div><div class="row"><button type="button" class="btn primary" data-skill-ap="${esc(p.approvalId)}">Aprovar</button><button type="button" class="btn danger" data-skill-rj="${esc(p.approvalId)}">Negar</button></div></div>`).join("");
  const form = draft || { id: "", name: "", role: "", instructions: "", mcp: null, autonomy: {} };
  const autRows = aut.modes.map((row) => `
    <label>${esc(row.label)}
      ${row.locked
        ? `<select disabled><option>Pedir antes (travado)</option></select>`
        : `<select data-ast-aut="${esc(row.tipo)}">
            <option value=""${form.autonomy[row.tipo] ? "" : " selected"}>Seguir a tela Autonomia</option>
            <option value="pedir"${form.autonomy[row.tipo] === "pedir" ? " selected" : ""}>Pedir antes</option>
            <option value="sozinho"${form.autonomy[row.tipo] === "sozinho" ? " selected" : ""}>Sozinho</option>
          </select>`}
    </label>`).join("");
  const mcpRows = servers.map((name) => `<label class="check"><input type="checkbox" data-ast-mcp="${esc(name)}"${Array.isArray(form.mcp) && form.mcp.includes(name) ? " checked" : ""}> ${esc(name)}</label>`).join("") || `<span class="muted">Nenhum conector cadastrado ainda.</span>`;
  shell(`
    <section class="card">
      <h2>Seus assistentes</h2>
      ${cards}
      ${pendingCards ? `<h3>Pedidos de criação</h3>${pendingCards}` : ""}
    </section>
    <form class="card stack" id="astForm" style="margin-top:12px">
      <h2>${form.id ? "Editar assistente" : "Novo assistente"}</h2>
      ${form.id ? "" : `<div><div class="muted">Comece de um modelo pronto:</div><div class="row">${templates}</div></div>`}
      <label>Nome<input name="name" required maxlength="40" value="${esc(form.name)}"></label>
      <label>Função<input name="role" maxlength="120" value="${esc(form.role)}" placeholder="Ex.: Tutor de inglês"></label>
      <label>Instruções<textarea name="instructions" maxlength="2000" rows="5" placeholder="Como este assistente deve trabalhar.">${esc(form.instructions)}</textarea></label>
      <fieldset class="stack"><legend>Conectores MCP</legend>
        <label class="check"><input type="radio" name="mcpMode" value="all"${form.mcp === null ? " checked" : ""}> Todos os conectores</label>
        <label class="check"><input type="radio" name="mcpMode" value="some"${form.mcp === null ? "" : " checked"}> Só os marcados (nenhum marcado = sem conectores)</label>
        <div class="row">${mcpRows}</div>
      </fieldset>
      <fieldset class="stack"><legend>Autonomia deste assistente</legend>
        <p class="muted">Opcional. Pagar e usar senha do cofre ficam sempre em “Pedir antes”.</p>
        ${autRows}
      </fieldset>
      <div class="row"><button class="btn primary" type="submit">${form.id ? "Salvar" : "Criar assistente"}</button>${form.id || draft ? `<button type="button" class="btn" id="astCancel">Cancelar</button>` : ""}</div>
    </form>
    <section class="card stack" style="margin-top:12px">
      <h2>Skills</h2>
      <p class="muted">Texto de instrução, lido sob demanda. Não executa nada e não ganha ferramenta nem autonomia.</p>
      ${skillRows || `<div class="empty">Nenhuma skill gravada no registro interno.</div>`}
      <h3>Catálogo no disco</h3>
      ${fsRows || `<div class="muted">Nenhuma pasta com SKILL.md.</div>`}
      ${pendingSkill ? `<h3>Instalações pendentes</h3>${pendingSkill}` : ""}
      <h3>Atribuir por assistente</h3>
      <label>Assistente<select id="skillAssignAsst">${assistantOptions(assignAsst)}</select></label>
      <div class="row">${assignChecks || `<span class="muted">Nada no catálogo.</span>`}</div>
      <button type="button" class="btn" id="skillAssignSave">Salvar atribuições</button>
      <div class="row"><button type="button" class="btn" id="skillOasis">Instalar exemplo da landing</button></div>
      <label>Importar SKILL.md<textarea id="skillMd" rows="6" placeholder="---&#10;name: nome&#10;description: para que serve&#10;---&#10;Instruções em português."></textarea></label>
      <div class="row"><button type="button" class="btn" id="skillPreview">Ver prévia</button><button type="button" class="btn primary" id="skillApply" disabled>Gravar skill</button></div>
      <pre id="skillOut" class="muted"></pre>
    </section>`);
  const bySel = (selector) => document.querySelectorAll(selector);
  bySel("[data-ast-tpl]").forEach((button) => {
    button.onclick = async () => {
      const tpl = data.templates.find((item) => item.id === button.dataset.astTpl);
      assistantDraft = { id: "", template: tpl.id, name: tpl.name, role: tpl.role, instructions: tpl.instructions, mcp: null, autonomy: {} };
      await loadAssistants();
    };
  });
  bySel("[data-ast-edit]").forEach((button) => {
    button.onclick = async () => {
      assistantDraft = JSON.parse(JSON.stringify(data.assistants.find((item) => item.id === button.dataset.astEdit)));
      await loadAssistants();
    };
  });
  bySel("[data-ast-del]").forEach((button) => {
    button.onclick = async () => {
      const item = data.assistants.find((entry) => entry.id === button.dataset.astDel);
      if (!window.confirm(`Remover “${item.name}”? A memória dele será apagada e as conversas passam para o assistente padrão.`)) return;
      try { await call("DELETE", `/api/assistants/${item.id}`); assistantDraft = null; await loadAssistants(); }
      catch (err) { banner(err.message); }
    };
  });
  bySel("[data-ast-chat]").forEach((button) => {
    button.onclick = () => { state.assistantId = button.dataset.astChat; state.current = null; setView("chat"); };
  });
  bySel("[data-ast-imp]").forEach((button) => {
    button.onclick = () => { const f = document.querySelector(`[data-ast-impform="${button.dataset.astImp}"]`); if (f) f.hidden = !f.hidden; };
  });
  bySel("[data-ast-impform]").forEach((form) => {
    form.onsubmit = async (event) => {
      event.preventDefault();
      try {
        let texto = form.elements.texto.value;
        const file = form.elements.arquivo.files && form.elements.arquivo.files[0];
        if (file) texto = `${texto}\n\n${await file.text()}`.trim();
        if (!texto.trim()) { banner("Cole um texto ou escolha um arquivo."); return; }
        const r = await call("POST", `/api/assistants/${encodeURIComponent(form.dataset.astImpform)}/importar`, { texto });
        banner(r && r.ok === false ? (r.error || "Não importei.") : "Contexto importado.");
        await loadAssistants();
      } catch (err) { banner(err.message); }
    };
  });
  bySel("[data-ast-mem]").forEach((button) => {
    button.onclick = () => { state.memoryAssistant = button.dataset.astMem; setView("memory"); };
  });
  if ($("astCancel")) $("astCancel").onclick = async () => { assistantDraft = null; await loadAssistants(); };
  $("astForm").onsubmit = async (event) => {
    event.preventDefault();
    const fd = new FormData(event.target);
    const autonomy = {};
    bySel("[data-ast-aut]").forEach((select) => { if (select.value) autonomy[select.dataset.astAut] = select.value; });
    const mcpList = fd.get("mcpMode") === "all" ? null : [...bySel("[data-ast-mcp]")].filter((box) => box.checked).map((box) => box.dataset.astMcp);
    const body = { name: fd.get("name"), role: fd.get("role"), instructions: fd.get("instructions"), mcp: mcpList, autonomy };
    try {
      if (form.id) await call("POST", `/api/assistants/${form.id}`, body);
      else await call("POST", "/api/assistants", { ...body, template: form.template || undefined });
      assistantDraft = null;
      banner("Salvo.");
      await loadAssistants();
    } catch (err) { banner(err.message); }
  };
  let skillDraft = null;
  $("skillPreview").onclick = async () => {
    try {
      const preview = await call("POST", "/api/skills/importar/previa", { markdown: $("skillMd").value });
      skillDraft = preview.preview;
      $("skillOut").textContent = `${skillDraft.name}\n${skillDraft.description}\n\n${skillDraft.instrucoes}\n\n${(skillDraft.avisos || []).join(" ")} ${skillDraft.note || ""}`;
      $("skillApply").disabled = false;
    } catch (err) { banner(err.message); }
  };
  $("skillApply").onclick = async () => {
    if (!skillDraft) return;
    try {
      await call("POST", "/api/skills/importar/aplicar", { markdown: $("skillMd").value, confirmar: true });
      banner("Skill gravada. Nada foi executado.");
      await loadAssistants();
    } catch (err) { banner(err.message); }
  };
  $("skillOasis").onclick = async () => {
    try {
      await call("POST", "/api/skills/modelo/pagina-oasis", { confirmar: true });
      await loadAssistants();
    } catch (err) { banner(err.message); }
  };
  document.querySelectorAll("[data-skill-del]").forEach((button) => {
    button.onclick = async () => {
      await call("DELETE", `/api/skills/${button.dataset.skillDel}`);
      await loadAssistants();
    };
  });
  if ($("skillAssignAsst")) {
    $("skillAssignAsst").onchange = async () => {
      state.skillAssignAssistant = $("skillAssignAsst").value;
      await loadAssistants();
    };
  }
  if ($("skillAssignSave")) {
    $("skillAssignSave").onclick = async () => {
      const asst = $("skillAssignAsst").value || "default";
      const nomes = [...document.querySelectorAll("[data-skill-assign]")].filter((el) => el.checked).map((el) => el.dataset.skillAssign);
      try {
        await call("POST", "/api/skills/atribuir", { assistantId: asst, skills: nomes });
        banner("Atribuições salvas.");
        await loadAssistants();
      } catch (err) { banner(err.message); }
    };
  }
  document.querySelectorAll("[data-skill-ap]").forEach((button) => {
    button.onclick = async () => {
      try {
        await call("POST", "/api/skills/instalar/confirmar", { approvalId: button.dataset.skillAp });
        banner("Skill instalada.");
        await loadAssistants();
      } catch (err) { banner(err.message); }
    };
  });
  document.querySelectorAll("[data-skill-rj]").forEach((button) => {
    button.onclick = async () => {
      try {
        await call("POST", "/api/skills/instalar/recusar", { approvalId: button.dataset.skillRj });
        await loadAssistants();
      } catch (err) { banner(err.message); }
    };
  });
}

const fmtDuration = (ms) => {
  const total = Math.round((ms || 0) / 1000);
  return total >= 60 ? `${Math.floor(total / 60)} min ${total % 60} s` : `${total} s`;
};

const USO_STATE = { "sem-limite": "sem limite", ok: "dentro do limite", alerta: "perto do limite", limite: "limite atingido" };

function usageRow(row) {
  const t = row.today;
  const secs = Math.round(t.tempoMs / 1000);
  const tokens = t.execucoesComTokens ? ` · ${esc(t.tokens)} tokens informados` : "";
  const meterHtml = row.percent === null ? "" : `<meter min="0" max="100" low="80" high="99" optimum="0" value="${esc(Math.min(100, row.percent))}" aria-label="Uso do limite de ${esc(row.name)}"></meter> <span class="muted">${esc(row.percent)}%</span>`;
  return `<div class="status-line" data-uso="${esc(row.assistantId)}">
    <div><strong>${esc(row.name)}</strong> <span class="chip${row.state === "limite" ? " summary" : ""}">${esc(USO_STATE[row.state] || row.state)}</span>${row.blocked ? ` <span class="chip summary">bloqueado hoje</span>` : ""}
      <div class="muted">hoje: ${esc(t.mensagens)} mensagens · ${esc(t.chamadas)} chamadas ao modelo · ${esc(t.ajudantes)} ajudantes · ${esc(t.consultas)} consultas · ${esc(t.caracteresEnviados + t.caracteresRecebidos)} caracteres · ${esc(secs)} s de resposta${tokens}</div>
      <div class="muted">acumulado: ${esc(row.total.mensagens)} mensagens · ${esc(row.total.chamadas)} chamadas</div>
      ${meterHtml}</div>
    <div class="stack">
      <label>Limite de chamadas por dia <input type="number" min="0" data-uso-calls="${esc(row.assistantId)}" value="${esc(row.limit.chamadasPorDia)}"></label>
      <label>Limite de tokens por dia <input type="number" min="0" data-uso-tokens="${esc(row.assistantId)}" value="${esc(row.limit.tokensPorDia)}"></label>
      <label class="check"><input type="checkbox" data-uso-block="${esc(row.assistantId)}"${row.limit.bloquear ? " checked" : ""}> Bloquear ao atingir o limite</label>
      <button type="button" class="btn" data-uso-save="${esc(row.assistantId)}">Salvar limite</button>
    </div>
  </div>`;
}

// Registro de fontes de um ajudante: resumo numa linha e, ao abrir, cada afirmação com a fonte e o estado do verificador.
const VERIFY_LABEL = { confirmed: "confirmada", needs_validation: "aguarda verificação", rejected: "rejeitada" };
function ledgerView(reg) {
  const c = reg.counts;
  const claims = reg.claims.map((claim) => `<li><strong>${esc(claim.categoryLabel)}</strong>${claim.important ? ` <span class="chip summary">importante: ${esc(VERIFY_LABEL[claim.verification?.state] || "aguarda verificação")}</span>` : ""} ${esc(claim.text)}
      <span class="muted">${claim.sources.length ? `fonte: ${esc(claim.sources.join("; "))}` : "sem fonte"}${claim.verification?.note ? ` · ${esc(claim.verification.note)}` : ""}</span></li>`).join("");
  return `<details class="ledger" data-ledger="${esc(reg.id)}"${detailsOpen.attr(reg.id)}>
    <summary class="muted">Registro de fontes: ${esc(c.acordada)} acordada(s) · ${esc(c.contestada)} contestada(s) · ${esc(c.nao_verificada)} não verificada(s)${c.importantes ? ` · ${esc(c.importantes)} importante(s)` : ""}</summary>
    <ul class="muted">${claims}</ul>
  </details>`;
}

const AGENT_LIMIT_IDS = ["vagas", "pesquisa", "oasis", "portfolio"];
const AGENT_LIMIT_NAMES = { vagas: "Vagas", pesquisa: "Pesquisa", oasis: "Oasis", portfolio: "Portfólio" };

function agentLimitRow(row) {
  const id = row.assistantId;
  const nome = AGENT_LIMIT_NAMES[id] || row.name || id;
  const share = row.usoContaPct == null ? "sem dados" : `${row.usoContaPct}%`;
  const tokens = row.today?.execucoesComTokens ? `${row.today.tokens} tokens` : "sem tokens";
  const lim = row.limit?.tokensPorDia || 0;
  return `<div class="status-line" data-agent-limite="${esc(id)}">
    <div><strong>${esc(nome)}</strong>
      <div class="muted">hoje: ${esc(tokens)} · fatia da conta ${esc(share)}${lim ? ` · limite ${esc(lim)} tokens/dia` : ""}</div>
    </div>
    <div class="stack">
      <label>Limite diário de tokens <input type="number" min="0" data-agent-tokens="${esc(id)}" value="${esc(lim)}"></label>
      <label class="check"><input type="checkbox" data-agent-block="${esc(id)}"${row.limit?.bloquear ? " checked" : ""}> Pausar ao atingir</label>
      <button type="button" class="btn" data-agent-limite-save="${esc(id)}">Salvar</button>
    </div>
  </div>`;
}

async function loadActivity() {
  const uso = await call("GET", "/api/uso").catch(() => null);
  const obs = await call("GET", "/api/chefe/observabilidade").catch(() => null);
  const data = await call("GET", "/api/atividade");
  paintActivityBadge(data.active);
  const scrollTop = $("view").scrollTop;
  const kept = {};
  document.querySelectorAll("#view [data-limit]").forEach((el) => { kept[el.dataset.limit] = el.value; });
  const helpers = data.helpers.slice().reverse().map((item) => `
    <div class="status-line">
      <div><strong>${esc(item.task)}</strong> <span class="chip${item.active ? " live" : ""}">${esc(item.state)}</span>
        <div class="muted">ajudante de ${esc(item.assistantName)} · nível ${esc(item.depth)} · ${esc(fmtDuration(item.durationMs))}${item.tools.length ? ` · ferramentas: ${esc(item.tools.join(", "))}` : ""}</div>
        ${item.summary ? `<div class="muted">${esc(item.summary)}</div>` : ""}
        ${item.ledger ? ledgerView(item.ledger) : ""}</div>
      ${item.active ? `<button type="button" class="btn danger" data-stop="${esc(item.id)}">Encerrar</button>` : ""}
    </div>`).join("");
  const contexts = data.assistants.map((item) => `
    <div class="status-line">
      <div><strong>${esc(item.name)}</strong>${item.createdBy ? ` <span class="chip">criado por ${esc(item.createdBy.name)}</span>` : ""}
        <div class="muted">contexto ativo: ${esc(item.context.chars)} de ${esc(item.context.limit)} caracteres · ${esc(item.context.items)} itens · ${esc(item.context.archived)} no arquivo
          · ${esc(item.stats.ajudantesCriados)} ajudantes · ${esc(item.stats.consultas)} consultas${item.stats.tokens && (item.stats.tokens.ajudantes + item.stats.tokens.consultas + item.stats.tokens.conversas) ? ` · ${esc(item.stats.tokens.ajudantes + item.stats.tokens.consultas + item.stats.tokens.conversas)} tokens` : ""}</div>
        <meter min="0" max="${esc(item.context.limit)}" value="${esc(Math.min(item.context.chars, item.context.limit))}" aria-label="Uso do contexto"></meter></div>
      <button type="button" class="btn" data-compact="${esc(item.id)}">Compactar agora</button>
    </div>`).join("");
  const limits = data.limits.map((row) => `
    <label>${esc(row.label)} <span class="muted">(padrão ${esc(row.default)}, de ${esc(row.min)} a ${esc(row.max)})</span>
      <input type="number" data-limit="${esc(row.key)}" min="${esc(row.min)}" max="${esc(row.max)}" value="${esc(kept[row.key] ?? row.value)}">
    </label>`).join("");
  const total = data.stats.total;
  const trocas = (data.contaTrocas || []).map((t) => `
    <div class="status-line"><div><strong>Auto-troca de conta</strong>
      <div class="muted">${esc(t.fromLabel)} → ${esc(t.toLabel)} · ${esc(t.reason)} · ${esc(t.at)}</div></div></div>`).join("");
  shell(`
    <section class="card">
      <h2>Resumo</h2>
      <div class="row">
        <span class="chip">${esc(data.active)} ajudantes ativos</span>
        <span class="chip">${esc(total.ajudantesCriados)} ajudantes criados</span>
        <span class="chip">${esc(total.consultas)} consultas entre assistentes</span>
        <span class="chip">${esc(total.assistentesCriados)} assistentes pedidos por bots</span>
        ${data.tokens.reported ? `<span class="chip">${esc(total.tokens.conversas + total.tokens.ajudantes + total.tokens.consultas)} tokens informados</span>` : ""}
      </div>
      <p class="muted">${esc(data.tokens.note)}</p>
    </section>
    ${trocas ? `<section class="card" style="margin-top:12px"><h2>Trocas de conta</h2>
      <p class="muted">Auto-troca ${data.autoSwitch ? "ligada" : "desligada"} (Conta Cursor).</p>
      ${trocas}
    </section>` : ""}
    <section class="card" style="margin-top:12px" id="agentLimitsPanel">
      <h2>Limites diários dos agentes</h2>
      <p class="muted">Tokens por agente (só quando o SDK informa). Ao atingir o limite o agente pausa e o Chefe alerta no quadro. Uso na tela só em % — nunca em dinheiro. 0 = sem limite.</p>
      ${(uso?.assistants || [])
        .filter((row) => AGENT_LIMIT_IDS.includes(row.assistantId))
        .map(agentLimitRow)
        .join("") || AGENT_LIMIT_IDS.map((id) => agentLimitRow({
          assistantId: id,
          name: AGENT_LIMIT_NAMES[id],
          today: { tokens: 0, execucoesComTokens: 0 },
          usoContaPct: obs?.agentes?.find((a) => a.assistantId === id)?.usoContaPct ?? null,
          limit: { tokensPorDia: 0, bloquear: true },
        })).join("")}
    </section>
    ${uso ? `<section class="card" style="margin-top:12px" id="usoPanel">
      <h2>Painel de uso</h2>
      <p class="muted">${esc(uso.note)} Aviso a partir de ${esc(uso.alertAt)}% do limite. 0 = sem limite. Os números do dia zeram à meia-noite.</p>
      ${uso.alerts.length ? `<p><span class="chip summary">${esc(uso.alerts.map((item) => `${item.name} ${item.percent}%`).join(" · "))}</span></p>` : ""}
      ${uso.assistants.map(usageRow).join("")}
    </section>` : ""}
    <section class="card" style="margin-top:12px">
      <h2>Ajudantes</h2>
      <p class="muted">Cada ajudante faz uma tarefa, devolve um relatório curto e é removido. O assistente principal decide o próximo.</p>
      ${helpers || `<div class="empty">Nenhum ajudante ainda.</div>`}
    </section>
    <section class="card" style="margin-top:12px">
      <h2>Contexto por assistente</h2>
      <p class="muted">Só o contexto ativo vai para o modelo. O arquivo nunca é lido sozinho: o assistente só busca nele quando precisa.</p>
      ${contexts}
    </section>
    <form class="card stack" id="limitsForm" style="margin-top:12px">
      <h2>Limites</h2>
      <p class="muted">Valores conservadores por padrão. Ao estourar, o assistente recebe um aviso claro em vez de criar mais.</p>
      ${limits}
      <div class="row"><button class="btn primary" type="submit">Salvar limites</button></div>
    </form>`);
  $("view").scrollTop = scrollTop;
  document.querySelectorAll("[data-stop]").forEach((button) => {
    button.onclick = async () => {
      try { await call("POST", `/api/atividade/ajudantes/${button.dataset.stop}/encerrar`, {}); } catch (err) { banner(err.message); }
      await loadActivity();
    };
  });
  document.querySelectorAll("[data-compact]").forEach((button) => {
    button.onclick = async () => {
      try {
        const res = await call("POST", `/api/contexto/${button.dataset.compact}/compactar`, {});
        banner(res.moved ? `${res.moved} itens foram para o arquivo.` : "O contexto já cabe no limite.");
      } catch (err) { banner(err.message); }
      await loadActivity();
    };
  });
  document.querySelectorAll("[data-uso-save]").forEach((button) => {
    button.onclick = async () => {
      const id = button.dataset.usoSave;
      const field = (attr) => document.querySelector(`[${attr}="${id}"]`);
      try {
        await call("POST", `/api/uso/${encodeURIComponent(id)}/limite`, {
          chamadasPorDia: Number(field("data-uso-calls").value) || 0,
          tokensPorDia: Number(field("data-uso-tokens").value) || 0,
          bloquear: field("data-uso-block").checked,
        });
        banner("Limite de uso salvo.");
      } catch (err) { banner(err.message); }
      await loadActivity();
    };
  });
  document.querySelectorAll("[data-agent-limite-save]").forEach((button) => {
    button.onclick = async () => {
      const id = button.dataset.agentLimiteSave;
      const tokensEl = document.querySelector(`[data-agent-tokens="${id}"]`);
      const blockEl = document.querySelector(`[data-agent-block="${id}"]`);
      try {
        await call("POST", `/api/uso/${encodeURIComponent(id)}/limite`, {
          tokensPorDia: Number(tokensEl?.value) || 0,
          bloquear: blockEl ? blockEl.checked : true,
        });
        banner("Limite do agente salvo.");
      } catch (err) { banner(err.message); }
      await loadActivity();
    };
  });
  $("limitsForm").onsubmit = async (event) => {
    event.preventDefault();
    const body = {};
    document.querySelectorAll("#limitsForm [data-limit]").forEach((el) => { body[el.dataset.limit] = Number(el.value); });
    try {
      await call("POST", "/api/atividade/limites", body);
      banner("Limites salvos.");
      await loadActivity();
    } catch (err) { banner(err.message); }
  };
}

function paintActivityBadge(count) {
  const badge = $("activityBadge");
  if (!badge) return;
  badge.textContent = String(count);
  badge.classList.toggle("hidden", !count);
  badge.setAttribute("aria-label", `${count} ajudantes ativos`);
}

async function loadAutonomy() {
  const [data, licoes, missoes] = await Promise.all([
    call("GET", "/api/autonomy"),
    call("GET", "/api/licoes?pending=1").catch(() => ({ licoes: [] })),
    call("GET", "/api/missoes").catch(() => ({ missoes: [] })),
  ]);
  const rows = data.modes.map((row) => `
    <div class="status-line">
      <div><strong>${esc(row.label)}</strong><div class="muted">${esc(row.hint)}${row.locked ? " · Travado em “Pedir antes”." : ""}</div></div>
      <label class="autonomy-pick">Quando o HELIOS quiser fazer isso
        <select data-autonomy="${esc(row.tipo)}"${row.locked ? " disabled" : ""}>
          <option value="pedir"${row.mode === "pedir" ? " selected" : ""}>Pedir antes</option>
          ${row.locked ? "" : `<option value="sozinho"${row.mode === "sozinho" ? " selected" : ""}>Sozinho</option>`}
        </select>
      </label>
    </div>`).join("");
  shell(`
    <section class="card">
      <h2>Autonomia por ação</h2>
      <p class="muted">“Pedir antes” abre um cartão e nada acontece até você aprovar. “Sozinho” faz na hora e deixa um registro na conversa. Vale para as conversas, as rotinas e o servidor MCP local. O que não está liberado continua pedindo.</p>
      ${data.sandbox && data.sandbox.available === false ? `<p class="muted" id="sandboxNote">${esc(data.sandbox.notice)}</p>` : ""}
      ${rows}
    </section>
    <section class="card" style="margin-top:12px">
      <h2>Rotinas e ajudantes</h2>
      <label class="check"><input type="checkbox" data-auto-pede${data.automaticoPede ? " checked" : ""}> Sempre pedir antes de ${esc((data.automaticoTipos || []).join(", "))} quando quem faz é uma rotina ou um ajudante, mesmo que o tipo esteja em “Sozinho”.</label>
      <p class="muted">Recomendado. Quem rascunha é o robô; quem envia, publica ou apaga é você. Os pedidos de rotinas e ajudantes expiram (validade em Atividade › Limites) e nada é feito se expirarem. Pagar e preencher login ficam sempre travados em “Pedir antes”.</p>
    </section>
    <section class="card stack" style="margin-top:12px">
      <h2>Lições pendentes</h2>
      ${(licoes.licoes || []).length ? (licoes.licoes || []).map((l) => `<div class="status-line"><div>${esc(l.text)}</div><div class="row"><button type="button" class="btn primary" data-lic-ok="${esc(l.id)}">Aceitar</button><button type="button" class="btn" data-lic-no="${esc(l.id)}">Recusar</button></div></div>`).join("") : `<div class="muted">Nenhuma lição aguardando.</div>`}
    </section>
    <section class="card stack" style="margin-top:12px">
      <h2>Missões</h2>
      ${(() => {
        const open = (missoes.missoes || []).flatMap((m) => (m.decisions || []).filter((d) => d.state === "aberta").map((d) => ({ m, d })));
        return open.length
          ? open.slice(0, 6).map(({ m, d }) => `<div class="status-line"><div><strong>${esc(m.title)}</strong><div class="muted">${esc(d.question || d.pergunta || "Decisão pendente")}</div></div></div>`).join("")
          : `<div class="muted">Nenhuma decisão aberta.</div>`;
      })()}
    </section>`);
  document.querySelectorAll("[data-lic-ok]").forEach((b) => {
    b.onclick = async () => { try { await call("POST", `/api/licoes/${b.dataset.licOk}/aceitar`, {}); await loadAutonomy(); } catch (err) { banner(err.message); } };
  });
  document.querySelectorAll("[data-lic-no]").forEach((b) => {
    b.onclick = async () => { try { await call("POST", `/api/licoes/${b.dataset.licNo}/recusar`, {}); await loadAutonomy(); } catch (err) { banner(err.message); } };
  });
  const autoBox = document.querySelector("[data-auto-pede]");
  if (autoBox) {
    autoBox.onchange = async () => {
      try {
        await call("POST", "/api/autonomy", { automaticoPede: autoBox.checked });
        banner("Salvo.");
      } catch (err) {
        banner(err.message);
        await loadAutonomy();
      }
    };
  }
  document.querySelectorAll("[data-autonomy]").forEach((select) => {
    select.onchange = async () => {
      try {
        await call("POST", "/api/autonomy", { modes: { [select.dataset.autonomy]: select.value } });
        banner("Salvo.");
      } catch (err) {
        banner(err.message);
        await loadAutonomy();
      }
    };
  });
}

async function loadDitado() {
  const data = await call("GET", "/api/ditado");
  const prefs = data.prefs;
  const stats = data.stats || {};
  const hoje = stats.hoje || {};
  shell(`
    <section class="card stack hero">
      <p class="eyebrow">Sol no teclado</p>
      <h2 class="hero-title">Ditado na janela em foco</h2>
      <p>Desligado por padrão. O áudio vai para a Groq e o texto é digitado na hora. O HELIOS não guarda o que você falou.</p>
      <div class="proof"><span class="chip">${esc(hoje.words || 0)} palavras hoje</span><span class="chip">${esc(stats.streak || 0)} dias seguidos</span><span class="chip">${esc(hoje.fixes || 0)} ajustes hoje</span></div>
    </section>
    <form class="card stack" id="ditadoForm" style="margin-top:12px">
      <label class="check"><input type="checkbox" name="enabled"${prefs.enabled ? " checked" : ""}> Ligar o ditado global</label>
      <label>Atalho<input name="accelerator" value="${esc(prefs.accelerator)}" placeholder="CommandOrControl+Shift+D"></label>
      <label>Modo<select name="mode"><option value="alternar"${prefs.mode === "alternar" ? " selected" : ""}>Alternar</option><option value="segurar"${prefs.mode === "segurar" ? " selected" : ""}>Segurar (só no Windows)</option></select></label>
      <label>Estilo<select name="style"><option value="padrao">Padrão</option><option value="cursor"${prefs.style === "cursor" ? " selected" : ""}>Cursor</option><option value="whatsapp"${prefs.style === "whatsapp" ? " selected" : ""}>WhatsApp</option><option value="email"${prefs.style === "email" ? " selected" : ""}>E-mail</option></select></label>
      <label class="check"><input type="checkbox" name="cleanup"${prefs.cleanup ? " checked" : ""}> Limpar vícios de fala neste computador</label>
      <label>Glossário<textarea name="glossary" rows="3" placeholder="HELIOS = HELIOS">${esc(prefs.glossary || "")}</textarea></label>
      <label>Atalhos de texto<textarea name="snippets" rows="3" placeholder="oasis = Agência Oasis">${esc(prefs.snippets || "")}</textarea></label>
      <button class="btn primary" type="submit">Salvar ditado</button>
      <p class="muted">${esc(stats.note || "")}</p>
    </form>`);
  $("ditadoForm").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await call("POST", "/api/ditado", {
        enabled: form.get("enabled") === "on",
        accelerator: form.get("accelerator"),
        mode: form.get("mode"),
        style: form.get("style"),
        cleanup: form.get("cleanup") === "on",
        glossary: form.get("glossary"),
        snippets: form.get("snippets"),
      });
      if (helios.dictationRefresh) await helios.dictationRefresh();
      banner("Ditado salvo.");
      await loadDitado();
    } catch (err) { banner(err.message); }
  };
}

async function loadTime() {
  const [check, assistants] = await Promise.all([
    call("GET", "/api/onboarding"),
    call("GET", "/api/assistants"),
  ]);
  const items = (check.itens || []).map((item) => `<li><label class="check"><input type="checkbox" data-check="${esc(item.id)}"${item.done ? " checked" : ""}${item.id === "voz" ? "" : " disabled"}> ${esc(item.label)}</label></li>`).join("");
  const have = (assistants.assistants || []).filter((item) => !item.builtin).map((item) => `<span class="chip">${esc(item.name)}</span>`).join(" ") || `<span class="muted">Ainda só o HELIOS.</span>`;
  shell(`
    <section class="card stack hero">
      <p class="eyebrow">Nascer do time</p>
      <h2 class="hero-title">Montar time</h2>
      <p>Descreva o trabalho. A proposta usa os modelos que já existem. Nada é criado antes do clique.</p>
      <div class="proof">${have}</div>
    </section>
    <form class="card stack" id="timeForm" style="margin-top:12px">
      <label>Objetivo<textarea name="texto" rows="4" placeholder="Quero triar e-mail, organizar a agenda e pesquisar referências."></textarea></label>
      <button class="btn primary" type="submit">Propor time</button>
      <div id="timeOut"></div>
    </form>
    <section class="card" style="margin-top:12px"><h2>Checklist</h2><ul class="stack">${items}</ul></section>`);
  document.querySelectorAll("[data-check='voz']").forEach((box) => {
    box.onchange = async () => {
      try { await call("POST", "/api/onboarding/checklist", { voz: box.checked }); }
      catch (err) { banner(err.message); }
    };
  });
  $("timeForm").onsubmit = async (event) => {
    event.preventDefault();
    const texto = new FormData(event.target).get("texto");
    try {
      const plan = await call("POST", "/api/onboarding/propor", { texto });
      const boxes = (plan.propostas || []).map((item) => `<label class="check"><input type="checkbox" data-modelo="${esc(item.id)}" checked> ${esc(item.name)} <span class="muted">${esc(item.role)} · ${esc(item.porque)}</span></label>`).join("");
      $("timeOut").innerHTML = `${plan.aviso ? `<p class="banner">${esc(plan.aviso)}</p>` : ""}<p>${esc(plan.note || "")}</p><div class="stack">${boxes}</div><button type="button" class="btn primary" id="timeApply">Criar os marcados</button>`;
      $("timeApply").onclick = async () => {
        const modelos = [...document.querySelectorAll("[data-modelo]")].filter((box) => box.checked).map((box) => box.dataset.modelo);
        try {
          const done = await call("POST", "/api/onboarding/aplicar", { modelos });
          banner(`Criei ${done.created.length}. ${done.skipped.length ? done.skipped.length + " já existiam." : ""}`);
          await loadTime();
        } catch (err) { banner(err.message); }
      };
    } catch (err) { banner(err.message); }
  };
}

const contasView = window.HeliosContas.create({ call, shell: (html) => shell(html), esc, banner, helios });
function loadAccount() {
  return contasView.load();
}

document.querySelectorAll("nav button").forEach((button) => {
  button.onclick = () => setView(button.dataset.view);
});
document.querySelectorAll(".meeting-open").forEach((button) => {
  button.onclick = () => helios.openMeeting();
});
// LEVA I/O2: pontes para agents.js e chefe.js (antes do setView inicial).
window.heliosCall = call;
window.heliosState = () => state;
window.heliosBanner = banner;
window.heliosSetMode = (view) => {
  state.view = view;
  if (voice) voice.stopAll();
  clearInterval(state.poll);
  document.querySelectorAll("nav button").forEach((button) => button.classList.toggle("active", false));
  if (view === "chefe") {
    document.querySelectorAll('nav button[data-view="chefe"]').forEach((b) => b.classList.add("active"));
  }
  window.HeliosLayout?.paintSide?.();
  banner("");
};

refreshInbox().catch(() => {});
if (typeof helios.onDictationPhase === "function") {
  helios.onDictationPhase((phase) => {
    state.dictationPhase = phase || "idle";
    syncSolar();
  });
}
if (typeof helios.onDictationNotice === "function") {
  helios.onDictationNotice((text) => banner(text));
}

// LEVA O2: tela inicial = Chefe (HeliosChefe carrega depois; chefe.js dispara open se necessário).
state.view = "chefe";
state._bootChefe = true;
