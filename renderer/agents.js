// LEVA I: agentes autônomos na barra lateral e na tela do agente.
// Usa só a API local (/api/agentes). Sem saudação de chat: o agente recebe uma tarefa e trabalha sozinho.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const call = (m, p, b) => window.heliosCall(m, p, b);
  const hold = () => window.HeliosHold;
  const ST = { queued: ["Na fila", "new"], working: ["Trabalhando", "working"], waiting_you: ["Aguardando você", "waiting"], paused: ["Pausado", "paused"], done: ["Concluído", "done"], error: ["Erro", "error"] };
  let agents = [];
  let openId = null;
  let poll = null;

  /** Status do card: servidor já deriva waiting_you; reforço na UI se ainda houver pendência local. */
  function cardStatus(a) {
    if (!a) return "new";
    const pending = (a.pendentes > 0)
      || (a.approvals || []).some((x) => x.state === "pending")
      || (a.questions || []).some((x) => x.state === "pending")
      || (a.handoff && a.handoff.state === "waiting")
      || (a.missionDecisions || []).some((d) => d.state === "aberta");
    if (pending || a.status === "waiting_you") return "waiting_you";
    return a.status;
  }

  function liveMeta(a) {
    const st = cardStatus(a);
    if (st !== "working" && st !== "queued") return "";
    const tool = a.toolsLabel || a.currentTool || "";
    const parts = [`${a.stepCount || 0} passos`];
    if (tool) parts.push(tool);
    if (a.elapsed) parts.push(a.elapsed);
    return parts.join(" · ");
  }

  // ----- barra lateral -----
  const scroll = document.querySelector(".lf-scroll");
  const box = document.createElement("div");
  box.id = "lfAgentsWrap";
  // LEVA P3: lateral enxuta — tarefas autônomas sem seção extra ruidosa (lbl só se houver).
  box.innerHTML = `<p class="lf-lbl lf-lbl-row" id="lfAgentsLbl" hidden>Em curso <button type="button" class="lf-stopall" id="lfStopAll" hidden title="Parar todos os agentes">Parar todos</button></p><div id="lfAgents" class="lf-list"></div>`;
  scroll.insertBefore(box, $("lfConvs"));
  $("lfStopAll").onclick = async () => { await call("POST", "/api/agentes/parar-todos", {}); refresh(); if (openId) paintView(); };

  function paintList() {
    const filt = ($("lfSearch").value || "").trim().toLowerCase();
    const rows = agents.filter((a) => !filt || `${a.name} ${a.task}`.toLowerCase().includes(filt));
    const viewing = window.heliosState && window.heliosState().view === "agente";
    $("lfAgents").innerHTML = rows.map((a) => {
      const st = cardStatus(a);
      const [tip, cls] = ST[st] || ["", "new"];
      const on = viewing && a.id === openId;
      const live = liveMeta(a);
      const sub = live ? `<small class="lf-agent-live">${esc(live)}</small>` : "";
      return `<div class="lf-agent${on ? " on" : ""}"><button type="button" class="lf-it lf-conv${on ? " on" : ""}" data-agt="${esc(a.id)}" title="${esc(a.last || a.task)}"><i class="lf-st lf-st-${cls}" title="${tip}" aria-label="${tip}"></i><span class="lf-agent-lines"><span>${esc(a.name)}</span>${sub}</span></button></div>`;
    }).join("") || `<p class="lf-none">Nenhum agente</p>`;
    $("lfAgents").querySelectorAll("[data-agt]").forEach((b) => { b.onclick = () => open(b.dataset.agt); });
    $("lfStopAll").hidden = !agents.some((a) => { const s = cardStatus(a); return s === "working" || s === "queued"; });
    const show = rows.length > 0;
    $("lfAgentsWrap").hidden = !show;
    const lbl = $("lfAgentsLbl");
    if (lbl) lbl.hidden = !show;
  }

  async function refresh() {
    try { agents = (await call("GET", "/api/agentes")).agentes || []; paintList(); } catch { /* servidor ainda subindo */ }
  }
  setInterval(() => { if (!document.hidden) refresh(); }, 2500);
  refresh();

  function enterView(title) {
    window.HeliosLayout.closeSettings?.(false);
    window.heliosSetMode("agente");
    window.HeliosLayout.paintSide?.();
    $("title").textContent = title;
    $("eyebrow").textContent = "";
    $("title").title = "";
  }

  // ----- novo agente: só a caixa da tarefa -----
  function newAgent() {
    openId = null;
    clearInterval(poll);
    enterView("Novo agente");
    $("view").innerHTML = `<div class="agt-new">
      <span class="hx-glow agt-mark" aria-hidden="true"><span class="hx-mark hx-96"></span></span>
      <textarea id="agtTask" rows="4" placeholder="Descreva a tarefa. O agente trabalha sozinho e só chama você se precisar."></textarea>
      <div class="agt-new-row"><select id="agtAsst" aria-label="Assistente"></select><button type="button" class="btn primary" id="agtGo">Começar</button></div>
    </div>`;
    call("GET", "/api/assistants").then((d) => {
      const list = (d.assistants || []).filter((a) => a.id !== "vagas");
      $("agtAsst").innerHTML = list.map((a) => `<option value="${esc(a.id)}">${esc(a.id === "default" ? "HELIOS" : a.name)}</option>`).join("");
    }).catch(() => {});
    const go = async () => {
      const tarefa = $("agtTask").value.trim();
      if (tarefa.length < 3) return $("agtTask").focus();
      $("agtGo").disabled = true;
      try {
        const d = await call("POST", "/api/agentes", { tarefa, assistantId: $("agtAsst").value || "default" });
        await refresh();
        open(d.agente.id);
      } catch (e) { $("agtGo").disabled = false; window.heliosBanner?.(e.message); }
    };
    $("agtGo").onclick = go;
    $("agtTask").onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) go(); };
    paintList();
    setTimeout(() => $("agtTask")?.focus(), 30);
  }

  // ----- tela do agente -----
  async function open(id) {
    openId = id;
    enterView("Agente");
    $("view").innerHTML = `<div class="agt-view" id="agtView"></div>`;
    await refresh();
    await paintView();
    clearInterval(poll);
    poll = setInterval(() => {
      if (!window.heliosState || window.heliosState().view !== "agente" || openId !== id) return clearInterval(poll);
      if (!document.hidden) paintView();
    }, 1500);
    paintList();
    window.HeliosLayout?.paintSide?.();
  }

  function feedHtml(a) {
    const steps = a.steps || [];
    const groups = [];
    for (const s of steps) {
      const last = groups[groups.length - 1];
      if (s.kind === "tool" && last && last.kind === "tools") last.items.push(s);
      else groups.push(s.kind === "tool" ? { kind: "tools", items: [s] } : s);
    }
    return groups.map((g) => {
      if (g.kind === "tools") {
        const head = g.items[g.items.length - 1];
        return `<details class="agt-steps"><summary><span class="agt-n">${g.items.length}</span> ${esc(head.label)}</summary><ol>${g.items.map((s) => `<li >${esc(s.label)}${s.detail ? `<small>${esc(s.detail)}</small>` : ""}</li>`).join("")}</ol></details>`;
      }
      const cls = g.kind === "say" ? "agt-say" : g.kind === "you" ? "agt-you" : g.kind === "erro" ? "agt-err" : "agt-sys";
      return `<div class="${cls}">${esc(g.label)}</div>`;
    }).join("");
  }

  function approvalCardHtml(x) {
    const H = hold();
    const exp = x.expiresAt && H ? `<p class="muted">${esc(H.formatExpires(x.expiresAt))}</p>` : "";
    const exata = x.acaoExata ? `<pre>${esc(x.acaoExata)}</pre>` : (x.detalhe ? `<pre>${esc(x.detalhe)}</pre>` : "");
    const ok = H && x.holdRequired ? H.approveBtnHtml(x.id, true) : `<button type="button" class="btn primary" data-agt-ok="${esc(x.id)}">Aprovar</button>`;
    const deny = x.holdRequired
      ? `<button type="button" class="btn danger" data-agt-deny-open="${esc(x.id)}">Negar</button><div class="row deny-box" data-agt-deny-box="${esc(x.id)}" hidden><input data-agt-deny-in="${esc(x.id)}" placeholder="Motivo"><button type="button" class="btn danger" data-agt-deny-send="${esc(x.id)}">Confirmar</button></div>`
      : `<button type="button" class="btn danger" data-agt-no="${esc(x.id)}">Negar</button>`;
    return `<article class="card approval pending agt-card"><p class="eyebrow">Aprovar antes de ${esc(x.tipo)}</p><h2>${esc(x.resumo)}</h2>${exata}${exp}<div class="row">${ok}${deny}</div></article>`;
  }

  function cardsHtml(a) {
    const ap = (a.approvals || []).filter((x) => x.state === "pending").map(approvalCardHtml);
    const qs = (a.questions || []).filter((x) => x.state === "pending").map((x) => `<article class="card approval pending agt-card"><p class="eyebrow">Pergunta</p><h2>${esc(x.question)}</h2><div class="row">${(x.options || []).map((o) => `<button type="button" class="btn" data-agt-opt="${esc(x.id)}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}<input data-agt-ans="${esc(x.id)}" placeholder="Responder"><button type="button" class="btn primary" data-agt-send="${esc(x.id)}">Enviar</button></div></article>`);
    return ap.concat(qs).join("");
  }

  function handoffHtml(a) {
    const h = a.handoff;
    if (!h || h.state !== "waiting") return "";
    const img = a.streamThumb || a.thumb;
    const thumb = img ? `<img src="${esc(img)}" alt="">` : "";
    return `<article class="agt-handoff agt-card"><p class="eyebrow">Navegador</p>${thumb}<p class="muted">Assuma o navegador (captcha/2FA). A senha nunca passa pelo modelo.</p><div class="row"><button type="button" class="btn" id="agtShowBrowserHand">Ver navegador</button><button type="button" class="btn primary" id="agtResolvi">Resolvi</button></div></article>`;
  }

  async function paintView() {
    if (!openId) return;
    let a;
    try { a = (await call("GET", `/api/agentes/${openId}`)).agente; } catch (e) { $("view").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    if (!a.usage) {
      try {
        const u = await call("GET", `/api/agentes/${openId}/uso`);
        if (u.uso) a.usage = u.uso;
      } catch { /* opcional */ }
    }
    const root = $("agtView");
    if (!root) return;
    const typing = document.activeElement && root.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
    const steer = $("agtSteer") ? $("agtSteer").value : "";
    const st = cardStatus(a);
    const [label, cls] = ST[st] || [st, "new"];
    $("title").textContent = a.name;
    const live = st === "working" || st === "queued" || st === "waiting_you";
    const real = a.statusReal || a.status;
    const ctrl = [
      st === "working" || st === "queued" ? `<button type="button" class="btn" data-agt-act="pausar">Pausar</button>` : "",
      real === "paused" || real === "error" ? `<button type="button" class="btn" data-agt-act="retomar">Retomar</button>` : "",
      live || real === "paused" ? `<button type="button" class="btn danger" data-agt-act="parar">Parar</button>` : "",
      !live && st !== "waiting_you" ? `<button type="button" class="btn icon-btn" data-agt-act="apagar" title="Apagar agente" aria-label="Apagar agente"><svg class="sb-ico"><use href="#i-trash"/></svg></button>` : "",
    ].join("");
    const toolsMeta = a.toolsLabel ? ` · ${esc(a.toolsLabel)}` : (a.currentTool ? ` · ${esc(a.currentTool)}` : "");
    const usageLine = a.usage && a.usage.note ? `<span class="agt-meta muted" title="Uso informado pelo SDK">${esc(a.usage.note)}</span>` : "";
    const thumb = a.streamThumb || a.thumb ? `<img src="${esc(a.streamThumb || a.thumb)}" alt="Navegador do agente">` : `<div class="agt-thumb-empty">Sem navegador aberto</div>`;
    const arts = (a.artifacts || []).map((f) => `<li title="${esc(f.path)}">${esc(f.title)}</li>`).join("") || `<li class="muted">Nada ainda</li>`;
    const errExtra = st === "error" ? `<p class="muted"><button type="button" class="btn link" data-agt-goset>Ajustes</button></p>` : "";
    const html = `<header class="agt-head"><span class="hx-mark hx-22" aria-hidden="true"></span>
        <span class="agt-chip agt-chip-${cls}"><i class="lf-st lf-st-${cls}"></i>${esc(label)}</span>
        <span class="agt-meta" title="${esc(a.task)}">${a.stepCount || 0} passos · ${esc(a.elapsed || "")}${toolsMeta}</span>
        ${usageLine}
        <span class="agt-ctrl">${ctrl}</span>
      </header>
      <div class="agt-body">
        <section class="agt-feed" id="agtFeed"><div class="agt-task">${esc(a.task)}</div>${feedHtml(a)}${handoffHtml(a)}${cardsHtml(a)}${st === "done" && a.summary && !(a.steps || []).some((x) => x.label === a.summary) ? `<div class="agt-done">${esc(a.summary)}</div>` : ""}${st === "error" && a.error ? `<div class="agt-err">${esc(a.error)}</div>${errExtra}` : ""}</section>
        <aside class="agt-side">
          <div class="agt-thumb">${thumb}</div>
          ${a.url ? `<p class="agt-url" title="${esc(a.url)}">${esc(a.url)}</p>` : ""}
          <button type="button" class="btn" id="agtShowBrowser" ${a.thumb || a.url || a.streamThumb ? "" : "disabled"}>Ver navegador</button>
          <p class="lf-lbl">Arquivos</p><ul class="agt-arts">${arts}</ul>
          <p class="agt-folder" title="${esc(a.workDir || "")}">${esc(a.workDir || "")}</p>
        </aside>
      </div>
      <div class="agt-steer">
        <input id="agtSteer" placeholder="${live ? "Instruir o agente enquanto trabalha" : "Nova instrução (retoma o agente)"}">
        <button type="button" class="btn" id="agtSteerGo">Enviar</button>
        <button type="button" class="btn primary" id="agtCorrigir" title="Aplica no próximo limite de passo">Corrigir rumo</button>
      </div>
      ${a.steeringPending ? `<p class="muted agt-steer-pending">Corrigir rumo na fila: ${a.steeringPending}</p>` : ""}`;
    if (typing && root.dataset.sig === sig(a)) return;
    const feed = $("agtFeed");
    const atBottom = !feed || feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 30;
    const openDetails = new Set([...root.querySelectorAll("details[open] summary")].map((s) => s.textContent));
    root.innerHTML = html;
    root.dataset.sig = sig(a);
    root.querySelectorAll("details summary").forEach((s) => { if (openDetails.has(s.textContent)) s.parentElement.open = true; });
    if (steer) $("agtSteer").value = steer;
    if (atBottom) $("agtFeed").scrollTop = $("agtFeed").scrollHeight;
    bind(a);
  }
  const sig = (a) => `${cardStatus(a)}:${a.statusReal || ""}:${a.stepCount}:${(a.approvals || []).length}:${(a.questions || []).length}:${a.handoff?.state || ""}:${(a.missionDecisions || []).length}:${a.thumb || ""}`;

  function bindHoldApproves(root, post) {
    const H = hold();
    if (!H) return;
    root.querySelectorAll("[data-hold-approve]").forEach((btn) => {
      const clear = () => {
        if (btn._holdTimer) clearInterval(btn._holdTimer);
        btn._holdTimer = null;
        const fill = btn.querySelector(".hold-fill");
        if (fill) fill.style.width = "0%";
      };
      const start = () => {
        clear();
        const fill = btn.querySelector(".hold-fill");
        const t0 = Date.now();
        btn._holdTimer = setInterval(() => {
          const p = Math.min(100, ((Date.now() - t0) / H.HOLD_MS) * 100);
          if (fill) fill.style.width = `${p}%`;
          if (p >= 100) { clear(); post(`/aprovacao/${btn.dataset.holdApprove}`, { decision: "approve" }); }
        }, 40);
      };
      btn.onpointerdown = (e) => { if (e.button === 0) start(); };
      btn.onpointerup = () => clear();
      btn.onpointerleave = () => clear();
      btn.onkeydown = (e) => { if ((e.key === " " || e.key === "Enter") && !btn._holdTimer) { e.preventDefault(); start(); } };
      btn.onkeyup = (e) => { if (e.key === " " || e.key === "Enter") clear(); };
    });
  }

  function bind(a) {
    const root = $("agtView");
    const post = async (p, b) => { try { await call("POST", `/api/agentes/${a.id}${p}`, b || {}); } catch (e) { window.heliosBanner?.(e.message); } refresh(); paintView(); };
    root.querySelectorAll("[data-agt-act]").forEach((b) => {
      b.onclick = async () => {
        const act = b.dataset.agtAct;
        if (act === "apagar") { await call("DELETE", `/api/agentes/${a.id}`); await refresh(); return newAgent(); }
        post(`/${act}`);
      };
    });
    root.querySelectorAll("[data-agt-ok]").forEach((b) => { b.onclick = () => post(`/aprovacao/${b.dataset.agtOk}`, { decision: "approve" }); });
    root.querySelectorAll("[data-agt-no]").forEach((b) => { b.onclick = () => post(`/aprovacao/${b.dataset.agtNo}`, { decision: "deny" }); });
    root.querySelectorAll("[data-agt-deny-open]").forEach((b) => { b.onclick = () => { const box = root.querySelector(`[data-agt-deny-box="${b.dataset.agtDenyOpen}"]`); if (box) box.hidden = false; }; });
    root.querySelectorAll("[data-agt-deny-send]").forEach((b) => {
      b.onclick = () => {
        const motivo = root.querySelector(`[data-agt-deny-in="${b.dataset.agtDenySend}"]`)?.value || "";
        post(`/aprovacao/${b.dataset.agtDenySend}`, { decision: "deny", motivo });
      };
    });
    bindHoldApproves(root, post);
    root.querySelectorAll("[data-agt-opt]").forEach((b) => { b.onclick = () => post(`/resposta/${b.dataset.agtOpt}`, { answer: b.dataset.v }); });
    root.querySelectorAll("[data-agt-send]").forEach((b) => { b.onclick = () => post(`/resposta/${b.dataset.agtSend}`, { answer: root.querySelector(`[data-agt-ans="${b.dataset.agtSend}"]`).value }); });
    const steer = () => { const t = $("agtSteer").value.trim(); if (!t) return; $("agtSteer").value = ""; post("/instrucao", { texto: t }); };
    const corrigir = () => { const t = $("agtSteer").value.trim(); if (!t) return; $("agtSteer").value = ""; post("/corrigir", { texto: t }); };
    $("agtSteerGo").onclick = steer;
    if ($("agtCorrigir")) $("agtCorrigir").onclick = corrigir;
    $("agtSteer").onkeydown = (e) => { if (e.key === "Enter") steer(); };
    $("agtShowBrowser").onclick = () => post("/navegador");
    const hb = $("agtShowBrowserHand");
    if (hb) hb.onclick = () => post("/navegador");
    const res = $("agtResolvi");
    if (res) res.onclick = () => post("/resolvi");
    const gs = root.querySelector("[data-agt-goset]");
    if (gs) gs.onclick = () => window.HeliosLayout?.openSettings?.("autonomy");
  }

  $("lfNew").onclick = () => newAgent();
  window.HeliosAgents = { open, newAgent, refresh };
})();
