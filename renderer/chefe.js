/* global HeliosLayout, HeliosUsoBar */
// LEVA P3: Chefe estilo Grok Bot — chat + aprovações; agentes só na lateral (ponto + 1 linha).
// Sem painel direito de cartões; config de conector vira aviso curto no chat; sem rótulo de uso vazio.
// Uso só em % (nunca valor monetário / $).
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const call = (m, p, b) => window.heliosCall(m, p, b);
  const STATUS_LABEL = {
    ativo: "Ativo",
    pausado: "Pausado",
    trabalhando: "Trabalhando",
    aguardando: "Aguardando",
  };

  let poll = null;
  let snapshot = null;
  let operation = null;
  let inboxItems = [];
  let oasisSnap = null;
  let portfolioSnap = null;

  function usoLabel(pct) {
    if (pct == null || !Number.isFinite(Number(pct))) return "";
    return `${Math.round(Number(pct))}%`;
  }

  /** P3: só % real; se não houver dado, string vazia (não inventa rótulo). */
  function usoHtml(pct) {
    if (pct == null || !Number.isFinite(Number(pct))) return "";
    return `<p class="hx-agent-uso">Uso ${Math.round(Number(pct))}%</p>`;
  }

  function corpoUsuario(texto) {
    let t = String(texto || "");
    t = t.replace(/[^\n]*sem inventar[^\n]*/gi, "");
    t = t.replace(/[^\n]*não inventar[^\n]*/gi, "");
    t = t.replace(/[^\n]*nao inventar[^\n]*/gi, "");
    t = t.replace(/perfil\.skills/gi, "seu perfil");
    t = t.replace(/\n{3,}/g, "\n\n").trim();
    return t.slice(0, 280);
  }

  function feedKey(it) {
    const ref = String(it.ref || "");
    const periodo = (ref.match(/semana:([^\s:]+)/i) || [])[1]
      || (String(it.criadoEm || "").match(/^(\d{4}-\d{2}-\d{2})/) || [])[1]
      || "";
    const assunto = String(it.assunto || "").replace(/\s+/g, " ").trim().toLowerCase();
    return `${String(it.de || "").toLowerCase()}|${String(it.tipo || "").toLowerCase()}|${assunto}|${periodo}`;
  }

  function dedupeFeed(itens) {
    const seen = new Set();
    const out = [];
    for (const it of itens || []) {
      const key = feedKey(it);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
    return out;
  }

  function agentLine(a) {
    const st = a.status || "ativo";
    const tip = STATUS_LABEL[st] || st;
    const off = a.pausado || st === "pausado";
    const ultimo = a.ultimoResultado
      ? String(a.ultimoResultado.assunto || "").slice(0, 48)
      : (STATUS_LABEL[st] || "Pronto");
    const VIEW_OF = { vagas: "vagas", pesquisa: "search", oasis: "chefe", portfolio: "chefe" };
    return `<button type="button" class="lf-it lf-chefe-agent" data-lf-go="${esc(VIEW_OF[a.id] || "chefe")}" data-agente-id="${esc(a.id || "")}" title="${esc(tip)}">
      <i class="lf-dot${off ? " off" : ""}${st === "trabalhando" ? " on" : ""}" aria-label="${esc(tip)}"></i>
      <span class="lf-agent-lines"><span>${esc(a.nome)}</span><small class="lf-agent-live">${esc(ultimo)}</small></span>
    </button>`;
  }

  function paintSideAgents() {
    const wrap = $("lfChefeAgents");
    if (!wrap) return;
    const agentes = Array.isArray(snapshot?.agentes) ? snapshot.agentes : [];
    wrap.innerHTML = agentes.length
      ? agentes.map(agentLine).join("")
      : `<p class="lf-none">Sem agentes</p>`;
    wrap.querySelectorAll("[data-lf-go]").forEach((b) => {
      b.onclick = () => {
        HeliosLayout?.go?.(b.dataset.lfGo);
        // LEVA S3: Oasis/Portfolio nao tem tela propria: abre o Chefe e rola ate o cartao do agente.
        if (b.dataset.lfGo === "chefe" && b.dataset.agenteId) setTimeout(() => { const el = document.querySelector(`[data-agente="${b.dataset.agenteId}"], #chefe-${b.dataset.agenteId}`); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 300);
      };
    });
  }

  function rackStatusLabel(status) {
    return ({ working: "Trabalhando", queued: "Na fila", waiting_you: "Aguardando você", paused: "Pausado", done: "Concluído", error: "Erro" })[status] || "Pronto";
  }

  function rackAgent(a) {
    const status = a.status || "ativo";
    const off = a.pausado || status === "pausado";
    const uso = usoLabel(a.usoPct);
    return `<article class="hx-rack-agent">
      <div class="hx-rack-agent-head"><span class="hx-rack-dot${off ? " off" : status === "trabalhando" ? " live" : ""}"></span><strong>${esc(a.nome)}</strong><span class="hx-rack-status">${esc(rackStatusLabel(status))}</span></div>
      <p>${esc(a.ultimoResultado?.assunto || a.missao || "Sem tarefa em andamento")}</p>
      <small>${a.missoesAtivas || 0} missão(ões)${uso ? ` · uso ${esc(uso)}` : ""}</small>
    </article>`;
  }

  function rackWorker(w) {
    const tools = Array.isArray(w.tools) && w.tools.length ? w.tools.join(", ") : (w.currentTool || "sem ferramenta registrada");
    return `<article class="hx-rack-worker">
      <div><strong>${esc(w.name || "Sessão")}</strong><span class="hx-rack-status">${esc(rackStatusLabel(w.status))}</span></div>
      <p>${esc(w.currentTool || w.task || w.motivo || "Aguardando próximo passo")}</p>
      <small>${esc(tools)} · ${Number(w.stepCount) || 0} passo(s)${w.elapsed ? ` · ${esc(w.elapsed)}` : ""}</small>
    </article>`;
  }

  function paintRack() {
    const box = $("hxChefeRack");
    if (!box) return;
    const op = operation || { maquina: { nome: "HELIOS local", status: "online", modo: "operacional; só bloqueios críticos pedem você" }, agentes: [], workers: [], pendencias: 0, emExecucao: 0 };
    const agents = Array.isArray(op.agentes) ? op.agentes : [];
    const workers = Array.isArray(op.workers) ? op.workers.slice(0, 5) : [];
    box.innerHTML = `<section class="hx-rack-machine">
      <div class="hx-rack-machine-head"><span class="hx-rack-live"></span><strong>${esc(op.maquina?.nome || "HELIOS local")}</strong><span class="hx-rack-status">${esc(op.maquina?.status || "online")}</span></div>
      <p>${esc(op.maquina?.modo || "com confirmações")}</p>
    </section>
    <div class="hx-rack-summary"><div><strong>${agents.length}</strong><span>agentes</span></div><div><strong>${Number(op.emExecucao) || 0}</strong><span>em execução</span></div><div><strong>${Number(op.pendencias) || 0}</strong><span>pendências</span></div></div>
    <section class="hx-rack-section"><p class="eyebrow">Gabinete</p>${agents.length ? agents.map(rackAgent).join("") : `<p class="muted">Nenhum agente registrado.</p>`}</section>
    <section class="hx-rack-section"><p class="eyebrow">Sessões vivas</p>${workers.length ? workers.map(rackWorker).join("") : `<p class="muted">Nenhuma sessão em execução.</p>`}</section>`;
  }

  function oasisPendCard(p) {
    const tipo = p.tipo === "clickup" ? "ClickUp" : "execução no repo";
    return `<article class="card approval pending hx-chefe-ap">
      <p class="eyebrow">Oasis · ${esc(tipo)}</p>
      <h2>${esc(p.titulo || "Tarefa Oasis")}</h2>
      <p class="muted">${esc(p.taskId || "")}</p>
      <div class="row">
        <button type="button" class="btn primary" data-oasis-ok="${esc(p.id)}">Aprovar</button>
        <button type="button" class="btn danger" data-oasis-no="${esc(p.id)}">Negar</button>
      </div>
    </article>`;
  }

  function approvalCard(p) {
    return `<article class="card approval pending hx-chefe-ap">
      <p class="eyebrow">Aprovação do Chefe</p>
      <h2>${esc(p.motivo || "Ação crítica")}</h2>
      <p class="muted">${esc(p.quadroId || "")}</p>
      <div class="row">
        <button type="button" class="btn primary" data-chefe-ok="${esc(p.id)}">Aprovar</button>
        <button type="button" class="btn danger" data-chefe-no="${esc(p.id)}">Negar</button>
      </div>
    </article>`;
  }

  function inboxLite(item) {
    const title = String(item.summary || item.title || item.question || item.kind || "Pendência").slice(0, 100);
    return `<article class="card approval pending hx-chefe-ap">
      <p class="eyebrow">${esc(item.originLabel || "Aguardando você")}</p>
      <h2>${esc(title)}</h2>
      <div class="row"><button type="button" class="btn" data-chefe-inbox>Abrir caixa</button></div>
    </article>`;
  }

  /** P3: config vira mensagem curta do Chefe no chat (não card). */
  function configHints() {
    const hints = [];
    if (oasisSnap && oasisSnap.clickupConfigurado === false) {
      hints.push({
        de: "chefe",
        tipo: "aviso",
        assunto: "Oasis precisa do ClickUp",
        corpo: "Abra Ajustes › Avançado › Conectores e salve o token do ClickUp.",
      });
    }
    if (portfolioSnap && portfolioSnap.conectoresOk === false) {
      hints.push({
        de: "chefe",
        tipo: "aviso",
        assunto: "Portfólio sem GitHub/Vercel",
        corpo: "Em Ajustes › Avançado › Conectores, salve o token no bloco Tokens manuais.",
      });
    }
    return hints;
  }

  function bind(root) {
    root.querySelectorAll("[data-chefe-ok]").forEach((b) => {
      b.onclick = async () => {
        try {
          await call("POST", `/api/chefe/aprovacao/${encodeURIComponent(b.dataset.chefeOk)}`, { decision: "approve" });
          await refresh();
        } catch (e) { window.heliosBanner?.(e.message); }
      };
    });
    root.querySelectorAll("[data-chefe-no]").forEach((b) => {
      b.onclick = async () => {
        try {
          await call("POST", `/api/chefe/aprovacao/${encodeURIComponent(b.dataset.chefeNo)}`, { decision: "deny" });
          await refresh();
        } catch (e) { window.heliosBanner?.(e.message); }
      };
    });
    root.querySelectorAll("[data-chefe-inbox]").forEach((b) => {
      b.onclick = () => HeliosLayout?.go?.("inbox");
    });
    root.querySelectorAll("[data-oasis-ok]").forEach((b) => {
      b.onclick = async () => {
        try {
          await call("POST", "/api/agente/oasis/aprovar", { id: b.dataset.oasisOk, decision: "approve" });
          await refresh();
        } catch (e) { window.heliosBanner?.(e.message); }
      };
    });
    root.querySelectorAll("[data-oasis-no]").forEach((b) => {
      b.onclick = async () => {
        try {
          await call("POST", "/api/agente/oasis/aprovar", { id: b.dataset.oasisNo, decision: "deny" });
          await refresh();
        } catch (e) { window.heliosBanner?.(e.message); }
      };
    });
    const pauseChefe = root.querySelector("[data-chefe-pause]");
    if (pauseChefe) {
      pauseChefe.onclick = async () => {
        const next = pauseChefe.dataset.pausar === "1";
        try {
          await call("POST", "/api/chefe/pausar", { pausado: next });
          await refresh();
        } catch (e) { window.heliosBanner?.(e.message); }
      };
    }
    const form = root.querySelector("#chefeForm");
    if (form) {
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const input = $("chefeDraft");
        const texto = (input?.value || "").trim();
        if (texto.length < 3) { input?.focus(); return; }
        const btn = $("chefeSend");
        if (btn) btn.disabled = true;
        try {
          await call("POST", "/api/chefe/ordem", { texto });
          if (input) input.value = "";
          await refresh();
        } catch (e) { window.heliosBanner?.(e.message); }
        finally { if (btn) btn.disabled = false; }
      };
    }
    root.querySelectorAll("[data-chefe-prompt]").forEach((button) => {
      button.onclick = () => {
        const input = $("chefeDraft");
        if (!input) return;
        input.value = button.dataset.chefePrompt || "";
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      };
    });
  }

  function paint() {
    const st = snapshot || { agentes: [], pendenciasAprovacao: [], pausado: true, ultimoResumo: "" };
    const pend = Array.isArray(st.pendenciasAprovacao) ? st.pendenciasAprovacao : [];
    const oasisPend = Array.isArray(oasisSnap?.pendencias) ? oasisSnap.pendencias : [];
    const inboxHtml = (inboxItems || []).slice(0, 5).map(inboxLite).join("");
    const apHtml = pend.map(approvalCard).join("") + oasisPend.map(oasisPendCard).join("") + inboxHtml;
    const estadoLabel = st.pausado ? "Chefe pausado" : "Chefe ativo";
    const estadoChip = `<span class="chip hx-chefe-st${st.pausado ? " hx-chefe-st-pausado" : ""}">${esc(estadoLabel)}</span>`;
    $("view").innerHTML = `<div class="hx-chefe hx-chefe-solo" id="hxChefe">
      <section class="hx-chefe-main">
        <header class="hx-chefe-top">
          <div>
            <h2 class="hx-chefe-title">Chefe</h2>
            <p class="hx-chefe-guide">Diga o resultado. O HELIOS coordena, executa e só pede sua decisão quando necessário.</p>
            <p class="hx-chefe-estado">${estadoChip}</p>
          </div>
        </header>
        <div class="hx-chefe-approvals stack">${apHtml || ""}</div>
        <div class="hx-chefe-feed stack" id="hxChefeFeed"></div>
        <div class="hx-composer-wrap">
          <form class="hx-chefe-composer composer" id="chefeForm">
            <textarea id="chefeDraft" rows="2" placeholder="O que você quer que o HELIOS resolva?" aria-label="Pedido para o HELIOS"></textarea>
            <button type="submit" class="btn primary send-btn" id="chefeSend" title="Enviar" aria-label="Enviar">
              <svg class="sb-ico" aria-hidden="true"><use href="#i-send"/></svg>
            </button>
          </form>
          <div class="hx-chefe-shortcuts" aria-label="Atalhos de pedido">
            <button type="button" class="chip" data-chefe-prompt="Analise o código deste projeto, corrija o que estiver impedindo os testes e me entregue um resumo.">Trabalhar no código</button>
            <button type="button" class="chip" data-chefe-prompt="Pesquise as melhores opções para este pedido e me mostre só as decisões necessárias.">Pesquisar</button>
            <button type="button" class="chip" data-chefe-prompt="Encontre vagas compatíveis com meu perfil, preencha o que for seguro e pare antes de qualquer decisão crítica.">Candidatar a vagas</button>
          </div>
          <div id="hxUsoBarChefe" class="hx-uso-bar" hidden></div>
        </div>
      </section>
    </div>`;
    bind($("hxChefe"));
    paintFeed();
    paintSideAgents();
    if ($("hxChefeRack")) paintRack();
    HeliosUsoBar?.mount?.($("hxUsoBarChefe"));
  }

  async function paintFeed() {
    const box = $("hxChefeFeed");
    if (!box) return;
    try {
      const q = await call("GET", "/api/quadro?para=helison&limite=24");
      void configHints();
      // Avisos de ClickUp e GitHub ficam em Ajustes, não no chat.
      // Itens cancelados continuam no quadro para auditoria, mas não podem
      // reaparecer como alerta ativo depois da migração para o modo automático.
      const ativos = (q.itens || []).filter((item) => item.status !== "cancelado");
      const itens = dedupeFeed(ativos).slice(0, 8);
      if (!itens.length) {
        box.innerHTML = `<div class="lf-hello"><span class="hx-glow lf-hello-logo"><span class="hx-mark hx-96" aria-hidden="true"></span></span><p class="lf-hello-q">Como posso ajudar?</p></div>`;
        return;
      }
      box.innerHTML = itens.map((it) => {
        const who = it.de === "chefe" ? "Chefe" : esc(it.de);
        const corpo = corpoUsuario(it.corpo);
        const corpoHtml = corpo ? `<p class="muted">${esc(corpo)}</p>` : "";
        return `<div class="msg bot hx-chefe-msg"><span class="hx-mark hx-28" aria-hidden="true"></span><div><p class="eyebrow">${who} · ${esc(it.tipo)}</p><p>${esc(it.assunto)}</p>${corpoHtml}</div></div>`;
      }).join("");
    } catch {
      box.innerHTML = "";
    }
  }

  async function refresh() {
    try {
      const [st, op, inbox, oasis, portfolio] = await Promise.all([
        call("GET", "/api/chefe"),
        call("GET", "/api/chefe/operacao").catch(() => null),
        call("GET", "/api/inbox").catch(() => ({ items: [], count: 0 })),
        call("GET", "/api/agente/oasis").catch(() => ({ agente: null })),
        call("GET", "/api/agente/portfolio").catch(() => ({ agente: null })),
      ]);
      snapshot = st;
      operation = op;
      inboxItems = Array.isArray(inbox.items) ? inbox.items : [];
      oasisSnap = oasis?.agente || null;
      portfolioSnap = portfolio?.agente || null;
      if (window.heliosState?.().view === "chefe") paint();
      window.HeliosChefe?.onSnapshot?.(st);
      paintSideAgents();
      paintRack();
    } catch (e) {
      if (window.heliosState?.().view === "chefe") window.heliosBanner?.(e.message);
    }
  }

  function open() {
    window.HeliosLayout?.closeSettings?.(false);
    window.heliosSetMode?.("chefe");
    $("title").textContent = "Chefe";
    $("eyebrow").textContent = "";
    $("title").title = "";
    window.HeliosLayout?.paintSide?.();
    paint();
    refresh();
    clearInterval(poll);
    poll = setInterval(() => {
      if (!window.heliosState || window.heliosState().view !== "chefe") return clearInterval(poll);
      if (!document.hidden) refresh();
    }, 4000);
  }

  window.HeliosChefe = {
    open,
    refresh,
    usoLabel,
    usoHtml,
    dedupeFeed,
    feedKey,
    corpoUsuario,
    agentLine,
    paintSideAgents,
    STATUS_LABEL,
    onSnapshot(st) {
      const n = (st?.pendenciasAprovacao || []).length;
      const badge = $("chefeBadge");
      if (badge) {
        badge.textContent = n > 99 ? "99+" : String(n);
        badge.classList.toggle("hidden", !n);
      }
    },
  };

  /** Lateral sempre atualizada (mesmo fora da tela do Chefe). */
  async function refreshSide() {
    try {
      const st = await call("GET", "/api/chefe");
      snapshot = st;
      paintSideAgents();
    paintRack();
      window.HeliosChefe?.onSnapshot?.(st);
    } catch { /* servidor subindo */ }
  }
  setInterval(() => { if (!document.hidden) refreshSide(); }, 5000);
  refreshSide();

  if (window.heliosState?.()?._bootChefe || window.heliosState?.()?.view === "chefe") {
    open();
  }
})();
