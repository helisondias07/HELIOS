"use strict";
/* global HeliosDetailsState */

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const TITLES = {
  inbox: ["Caixa de entrada", "Tudo o que espera por você: aprovações e perguntas de todas as conversas e rotinas."],
  chat: ["Conversas", "O agente usa ferramentas, memória e pede aprovação antes de enviar, apagar ou pagar."],
  assistants: ["Assistentes", "Cada assistente tem função, instruções, memória e conectores próprios. As conversas pertencem a um deles."],
  vault: ["Cofre", "Logins e chaves ficam criptografados neste computador. A senha não vai para o chat."],
  mcp: ["Conectores", "Clique em Conectar, entre no navegador e volte. O token fica no cofre."],
  search: ["Pesquisa", "Resultados com a fonte ao lado, para você conferir."],
  memory: ["Memória", "Fatos estáveis sobre você. Segredos são recusados."],
  context: ["Contexto", "Exporte e importe o seu contexto (sem segredos), leia ClickUp e e-mail só para consulta e escolha as pastas do PC que o HELIOS pode usar."],
  routines: ["Rotinas", "Um horário ou um intervalo. Ação irreversível continua pedindo aprovação."],
  ditado: ["Ditado", "Segure ou alterne um atalho e o texto entra na janela em foco. O áudio não fica salvo."],
  time: ["Montar time", "Descreva o objetivo. O HELIOS propõe assistentes que já existem e só cria depois do seu clique."],
  activity: ["Atividade", "Ajudantes temporários, consultas entre assistentes, limites e o tamanho do contexto de cada assistente."],
  autonomy: ["Autonomia", "Para cada tipo de ação, escolha se o HELIOS pede antes ou faz sozinho. Pagar e usar senha do cofre sempre pedem."],
  account: ["Conta Cursor", "Até 3 contas. As chaves ficam no cofre e você escolhe qual está ativa. O modo Auto escolhe o modelo mais barato que der conta."],
};

const state = { switched: {}, view: "chat", conversations: [], current: null, level: "auto", error: "", poll: null, assistants: [], assistantId: "default", memoryAssistant: "default", dictationPhase: "idle" };

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
  const [title, eyebrow] = TITLES[view];
  $("title").textContent = title;
  $("eyebrow").textContent = eyebrow;
  banner("");
  dawn();
  syncSolar();
  if (view === "chat") loadChat().catch((err) => banner(err.message));
  else if (view === "inbox") loadInbox().catch((err) => banner(err.message));
  else if (view === "assistants") loadAssistants().catch((err) => banner(err.message));
  else if (view === "ditado") loadDitado().catch((err) => banner(err.message));
  else if (view === "time") loadTime().catch((err) => banner(err.message));
  else if (view === "vault") loadVault().catch((err) => banner(err.message));
  else if (view === "mcp") loadMcp().catch((err) => banner(err.message));
  else if (view === "search") renderSearch({ query: "", results: [], error: "" });
  else if (view === "memory") loadMemory().catch((err) => banner(err.message));
  else if (view === "context") contextView.load().catch((err) => banner(err.message));
  else if (view === "routines") loadRoutines().catch((err) => banner(err.message));
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
  const messages = current ? current.messages.map(renderMessage).join("") : `<div class="empty">Escreva a primeira mensagem. Sem conta do Cursor, o HELIOS responde em modo demonstração.</div>`;
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
          ${voice ? voice.ui.options() : ""}
          <label>Nível
            <select id="level">
              <option value="auto">Auto</option>
              <option value="rapido">Rápido</option>
              <option value="padrao">Padrão</option>
              <option value="avancado">Avançado</option>
            </select>
          </label>
        </header>
        <div class="messages" id="messages">${messages}</div>
        ${routerHintHtml()}
        <form class="composer" id="composer">
          <textarea id="draft" placeholder="Peça, pergunte, ou diga: preencher login GitHub"></textarea>
          ${voice ? voice.ui.mic() : ""}
          <button type="button" class="btn" id="routeBtn" title="Sugere qual assistente cuida deste pedido. Não envia nada.">Quem cuida disso?</button>
          <button class="btn primary" type="submit">Enviar</button>
        </form>
      </div>
    </div>`);
  $("level").value = state.level;
  $("level").onchange = () => { state.level = $("level").value; };
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

function approvalActions(message) {
  return `<div class="row"><button type="button" class="btn primary" data-approve="${esc(message.id)}">Aprovar</button><button type="button" class="btn" data-adjust="${esc(message.id)}">Ajustar</button><button type="button" class="btn danger" data-deny="${esc(message.id)}">Negar</button><input data-note="${esc(message.id)}" placeholder="O que ajustar (ou por que negar)"></div>`;
}

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
    return `<article class="card approval pending" data-conv-id="${esc(item.convId)}">${head}
      <p class="eyebrow">${parked ? "Estacionada, esperando você" : "Pergunta do HELIOS"}</p><h2>${esc(item.summary)}</h2>${parkedInfo}
      ${questionActions({ id: item.id, options: item.options })}
      <div class="row"><button type="button" class="btn" data-open="${esc(item.convId)}">Abrir conversa</button></div></article>`;
  }
  const validade = item.expiresAt ? `<p class="muted">Vale até ${esc(new Date(item.expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }))}. Depois disso expira e nada é feito.</p>` : "";
  return `<article class="card approval pending" data-conv-id="${esc(item.convId)}">${head}
    <p class="eyebrow">${esc(approvalTitle(item.tipo, false))}</p><h2>${esc(item.summary)}</h2><p>${esc(item.detail)}</p>${validade}
    ${approvalActions({ id: item.id })}
    <div class="row"><button type="button" class="btn" data-open="${esc(item.convId)}">Abrir conversa</button></div></article>`;
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
      await call("POST", path, body);
      await loadInbox();
    } catch (err) { banner(err.message); }
  };
  document.querySelectorAll("#view [data-approve]").forEach((b) => { b.onclick = () => act(`/api/conversations/${convOf(b)}/approvals/${b.dataset.approve}`, { decision: "approve" }); });
  document.querySelectorAll("#view [data-adjust]").forEach((b) => { b.onclick = () => act(`/api/conversations/${convOf(b)}/approvals/${b.dataset.adjust}`, { decision: "adjust", note: document.querySelector(`#view [data-note="${b.dataset.adjust}"]`)?.value || "" }); });
  document.querySelectorAll("#view [data-deny]").forEach((b) => { b.onclick = () => act(`/api/conversations/${convOf(b)}/approvals/${b.dataset.deny}`, { decision: "deny", note: document.querySelector(`#view [data-note="${b.dataset.deny}"]`)?.value || "" }); });
  document.querySelectorAll("#view [data-qopt]").forEach((b) => { b.onclick = () => act(`/api/conversations/${convOf(b)}/questions/${b.dataset.qopt}`, { answer: b.dataset.value }); });
  document.querySelectorAll("#view [data-reply]").forEach((b) => { b.onclick = () => act(`/api/conversations/${convOf(b)}/questions/${b.dataset.reply}`, { answer: document.querySelector(`#view [data-answer="${b.dataset.reply}"]`)?.value || "" }); });
  document.querySelectorAll("#view [data-dismiss]").forEach((b) => { b.onclick = () => act(`/api/conversations/${convOf(b)}/questions/${b.dataset.dismiss}`, { dismiss: true }); });
  document.querySelectorAll("#view [data-reopen]").forEach((b) => { b.onclick = () => act(`/api/conversations/${convOf(b)}/approvals/${b.dataset.reopen}`, { decision: "reopen" }); });
  document.querySelectorAll("#view [data-open]").forEach((b) => { b.onclick = () => openConversation(b.dataset.open); });
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
  const rows = [...data.logins, ...data.tokens].map((entry) => `
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
  shell(`
    ${blockedCard}
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
        <h2>Itens</h2>
        ${rows || `<div class="empty">O cofre ainda está vazio.</div>`}
      </div>
    </div>`);
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
  const rows = data.items.map((item) => `
    <div class="status-line"><div><strong>${esc(item.kind)}</strong><div>${esc(item.text)}</div></div><button type="button" class="btn danger" data-forget="${esc(item.id)}">Esquecer</button></div>`).join("");
  shell(`
    <label class="pick">Memória do assistente
      <select id="memAssistant">${assistantOptions(owner)}</select>
    </label>
    <form class="card stack" id="memForm"><h2>Lembrar</h2>
      <label>Tipo<select name="kind"><option value="fato">fato</option><option value="preferencia">preferência</option><option value="regra">regra</option></select></label>
      <label>Texto<input name="text" required placeholder="Prefiro respostas curtas em português."></label>
      <button class="btn primary" type="submit">Guardar</button></form>
    <div class="card" style="margin-top:12px">${rows || `<div class="empty">Ainda não há memória.</div>`}</div>`);
  $("memAssistant").onchange = async () => { state.memoryAssistant = $("memAssistant").value; await loadMemory(); };
  $("memForm").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try { await call("POST", "/api/memory", { text: form.get("text"), kind: form.get("kind"), assistantId: owner }); await loadMemory(); }
    catch (err) { banner(err.message); }
  };
  document.querySelectorAll("[data-forget]").forEach((button) => {
    button.onclick = async () => { await call("DELETE", `/api/memory/${button.dataset.forget}?assistant=${encodeURIComponent(owner)}`); await loadMemory(); };
  });
}

async function loadRoutines() {
  await refreshAssistants();
  const data = await call("GET", "/api/routines");
  const rows = data.routines.map((item) => `
    <div class="status-line"><div><strong>${esc(item.title)}</strong>${item.readOnly ? ` <span class="chip">só leitura</span>` : ""}<div class="muted">${item.clock ? esc(item.clock) : "a cada " + esc(item.everyMinutes) + " min"} · ${item.enabled ? "ligada" : "pausada"} · ${esc(assistantName(item.assistantId || "default"))} · ${item.lastRun ? "última vez " + esc(new Date(item.lastRun).toLocaleString("pt-BR")) : "ainda não rodou"}</div><div>${esc(item.prompt)}</div></div>
      <div class="row"><button type="button" class="btn" data-toggle="${esc(item.id)}" data-enabled="${item.enabled ? "1" : "0"}">${item.enabled ? "Pausar" : "Ligar"}</button><button type="button" class="btn danger" data-remove="${esc(item.id)}">Apagar</button></div></div>`).join("");
  shell(`
    <form class="card stack" id="rotForm"><h2>Nova rotina</h2>
      <label>Nome<input name="title" required></label>
      <label>O que fazer<input name="prompt" required placeholder="Me lembre de revisar o PR"></label>
      <label>Assistente<select name="assistantId">${assistantOptions("default")}</select></label>
      <div class="row"><label>Horário<input name="clock" placeholder="09:30"></label><label>Ou a cada minutos<input name="everyMinutes" type="number" min="1"></label></div>
      <button class="btn primary" type="submit">Agendar</button>
      <button type="button" class="btn" id="installMorning">Instalar digest da manhã</button>
      <p class="muted">O digest entra pausado, às 08:00, e a conversa fica só leitura.</p></form>
    <div class="card" style="margin-top:12px">${rows || `<div class="empty">Nenhuma rotina.</div>`}</div>`);
  $("installMorning").onclick = async () => {
    try { await call("POST", "/api/routines/digest-manha", {}); await loadRoutines(); }
    catch (err) { banner(err.message); }
  };
  $("rotForm").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await call("POST", "/api/routines", { title: form.get("title"), prompt: form.get("prompt"), clock: form.get("clock"), everyMinutes: form.get("everyMinutes"), assistantId: form.get("assistantId") === "default" ? undefined : form.get("assistantId") });
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

let assistantDraft = null;

async function loadAssistants() {
  const [data, mcp, aut, skillData] = await Promise.all([
    refreshAssistants(),
    call("GET", "/api/mcp"),
    call("GET", "/api/autonomy"),
    call("GET", "/api/skills").catch(() => ({ skills: [] })),
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
        ${item.builtin ? "" : `<button type="button" class="btn" data-ast-edit="${esc(item.id)}">Editar</button><button type="button" class="btn danger" data-ast-del="${esc(item.id)}">Remover</button>`}
      </div>
    </div>`).join("");
  const pendingCards = (data.pending || []).map((item) => `
    <div class="status-line">
      <div><strong>${esc(item.name)}</strong> <span class="chip">aguardando aprovação</span> <span class="chip">criado por ${esc(item.createdBy ? item.createdBy.name : "um assistente")}</span>
        <div class="muted">${esc(item.role || "sem função definida")} · ainda não existe: aprove ou negue na Caixa de entrada.</div></div>
    </div>`).join("");
  const templates = data.templates.map((item) => `<button type="button" class="btn" data-ast-tpl="${esc(item.id)}" title="${esc(item.role)}">${esc(item.name)}</button>`).join("");
  const skillRows = (skillData.skills || []).map((item) => `<div class="status-line"><div><strong>${esc(item.name)}</strong><div class="muted">${esc(item.description)}</div></div><button type="button" class="btn danger" data-skill-del="${esc(item.id)}">Remover</button></div>`).join("");
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
      ${skillRows || `<div class="empty">Nenhuma skill instalada.</div>`}
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

async function loadActivity() {
  const uso = await call("GET", "/api/uso").catch(() => null);
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
  const data = await call("GET", "/api/autonomy");
  const rows = data.modes.map((row) => `
    <div class="status-line">
      <div><strong>${esc(row.label)}</strong><div class="muted">${esc(row.hint)}${row.locked ? " 🔒 Travado em “Pedir antes”." : ""}</div></div>
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
      ${rows}
    </section>
    <section class="card" style="margin-top:12px">
      <h2>Rotinas e ajudantes</h2>
      <label class="check"><input type="checkbox" data-auto-pede${data.automaticoPede ? " checked" : ""}> Sempre pedir antes de ${esc((data.automaticoTipos || []).join(", "))} quando quem faz é uma rotina ou um ajudante, mesmo que o tipo esteja em “Sozinho”.</label>
      <p class="muted">Recomendado. Quem rascunha é o robô; quem envia, publica ou apaga é você. Os pedidos de rotinas e ajudantes expiram (validade em Atividade › Limites) e nada é feito se expirarem. Pagar e preencher login ficam sempre travados em “Pedir antes”.</p>
    </section>`);
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
      <h2 class="hero-title">Quem entra no gabinete</h2>
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
setView("chat");
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
