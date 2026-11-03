"use strict";
/* Tela "Conta Cursor": até 3 contas (chave só no cofre, nunca exibida), conta ativa escolhida por você,
   uso local do HELIOS e a caixa avançada de conexão MCP. Também monta o aviso de limite que aparece no chat.
   Os montadores de HTML são funções puras (testáveis em Node); a tela usa só as classes que já existem. */

(function () {
  const ISSUE_CHIP = {
    usage: ["bad", "limite de uso atingido"],
    rate: ["warn", "Cursor pediu calma (muitas requisições)"],
    auth: ["bad", "chave não vale mais"],
  };

  const clock = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function usageText(local) {
    if (!local) return "Uso no HELIOS: sem registro ainda";
    const tokens = local.week.tokens ? ` · ${local.week.tokens.toLocaleString("pt-BR")} tokens (quando o SDK informa)` : "";
    return `Uso no HELIOS: hoje ${plural(local.today.chamadas, "chamada", "chamadas")} · últimos 7 dias ${plural(local.week.chamadas, "chamada", "chamadas")}${tokens}`;
  }

  /** Data curta DD/MM (pt-BR) para o fim do ciclo. */
  function fmtReinicia(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  }

  /** US$ com vírgula pt-BR a partir de centavos. Nunca inventa. */
  function fmtUsdCents(cents) {
    if (cents == null || !Number.isFinite(Number(cents))) return null;
    const n = Number(cents) / 100;
    return `US$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  /**
   * Rótulo da barra a partir dos campos reais. Nunca usa message/displayMessage/"demo".
   * Trechos ausentes são omitidos.
   */
  function fmtBarLabel(cu) {
    if (!cu) return "";
    const real = cu.real && typeof cu.real === "object" ? cu.real : {};
    const usedCents = real.usedCents != null ? real.usedCents : cu.remaining?.usedCents;
    const limitCents = real.limitCents != null
      ? real.limitCents
      : (cu.limit?.kind === "usd" && cu.limit?.value != null ? Math.round(Number(cu.limit.value) * 100) : null);
    const remainingCents = real.remainingCents != null
      ? real.remainingCents
      : (cu.remaining?.kind === "usd" && cu.remaining?.value != null ? Math.round(Number(cu.remaining.value) * 100) : null);
    const cycleEnd = real.cycleEnd || cu.nextResetAt || null;
    const parts = [];
    const usedTxt = fmtUsdCents(usedCents);
    const limTxt = fmtUsdCents(limitCents);
    if (usedTxt && limTxt) parts.push(`${usedTxt} de ${limTxt} usados`);
    else if (limTxt) parts.push(`${limTxt} limite`);
    else if (usedTxt) parts.push(`${usedTxt} usados`);
    const remTxt = fmtUsdCents(remainingCents);
    if (remTxt) parts.push(`restam ${remTxt}`);
    const reinicia = fmtReinicia(cycleEnd);
    if (reinicia) parts.push(`reinicia ${reinicia}`);
    return parts.join(" · ");
  }

  function fmtUsed(cu) {
    if (!cu || !cu.used) return "Sem uso no período";
    const parts = [];
    if (cu.used.totalTokens) parts.push(`${Number(cu.used.totalTokens).toLocaleString("pt-BR")} tokens`);
    if (cu.used.costInformado && cu.used.costCents != null) {
      const usd = fmtUsdCents(cu.used.costCents);
      if (usd) parts.push(usd);
    } else if (cu.used.costRotulo) parts.push(cu.used.costRotulo);
    if (!parts.length) parts.push(cu.used.runs ? `${cu.used.runs} execução(ões), sem tokens` : "Sem uso no período");
    return parts.join(" · ");
  }

  /** Uma linha secundária: uso local HELIOS + SDK. */
  function secondaryUsageHtml(account, cu, esc) {
    const helios = usageText(account.localUsage);
    const sdk = fmtUsed(cu);
    return `<p class="muted acct-secondary">${esc(helios)} · SDK: ${esc(sdk)}</p>`;
  }

  /** Percentual em pt-BR (12,5 — não 12.5). */
  function fmtPct(n) {
    if (n == null || !Number.isFinite(Number(n))) return null;
    return Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  }

  /**
   * Formato oasis pct(): "<1%" se 0<n<1; 1 casa se <10; inteiro caso contrário (pt-BR).
   */
  function pct(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    if (v > 0 && v < 1) return "<1%";
    return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v)}%`;
  }

  /** Dias até cycleEnd (ceil), igual daysLeft do oasis. */
  function daysLeft(iso, nowMs = Date.now()) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.ceil((t - nowMs) / 86400000));
  }

  function renewLabel(iso, nowMs = Date.now()) {
    const d = daysLeft(iso, nowMs);
    if (d === null) return "";
    if (d === 0) return "Renova hoje";
    if (d === 1) return "Renova amanhã";
    return `Renova em ${d} dias`;
  }

  /**
   * Percentual de exibição (usageModel do oasis):
   * se auto/api → max; senão usedCents/limitCents*100; senão percent.
   */
  function usageTopPercent(cu) {
    if (!cu) return null;
    const pools = cu.pools || {};
    const auto = pools.autoPercent;
    const api = pools.apiPercent;
    // Igual oasis: Number.isFinite(null) === false (não usar Number(null) → 0).
    const hasPools = Number.isFinite(auto) || Number.isFinite(api);
    if (hasPools) return Math.max(Number.isFinite(auto) ? auto : 0, Number.isFinite(api) ? api : 0);
    const real = cu.real && typeof cu.real === "object" ? cu.real : {};
    const used = Number(real.usedCents != null ? real.usedCents : cu.remaining?.usedCents);
    const limit = Number(real.limitCents != null
      ? real.limitCents
      : (cu.limit?.kind === "usd" && cu.limit?.value != null ? Math.round(Number(cu.limit.value) * 100) : NaN));
    if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) return (used / limit) * 100;
    const p = Number(cu.percent);
    return Number.isFinite(p) ? p : null;
  }

  /** Semanal se ciclo ≤ 10 dias; senão mensal. Fallback: period.type. */
  function periodKind(cu) {
    const real = cu?.real && typeof cu.real === "object" ? cu.real : {};
    const start = real.cycleStart || null;
    const end = real.cycleEnd || cu?.nextResetAt || null;
    const a = Date.parse(start || "");
    const b = Date.parse(end || "");
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      return (b - a) <= 10 * 86400000 ? "weekly" : "monthly";
    }
    return cu?.period?.type === "monthly" ? "monthly" : "weekly";
  }

  function usageTip(cu) {
    if (!cu) return "";
    const bits = [];
    const label = fmtBarLabel(cu);
    if (label) bits.push(label);
    const pools = cu.pools || {};
    if (Number.isFinite(pools.autoPercent)) bits.push(`Modelos do Cursor: ${pct(pools.autoPercent)}`);
    if (Number.isFinite(pools.apiPercent)) bits.push(`Outros modelos: ${pct(pools.apiPercent)}`);
    return bits.join("\n");
  }

  function poolsHtml(cu, esc) {
    // LEVA N4: baldes saem do display principal (ficam só no title/tooltip).
    void cu; void esc;
    return "";
  }

  function cursorBarHtml(account, maisRestanteId, esc, demo = false, nowMs = Date.now()) {
    const cu = account.cursorUsage;
    if (!cu) return "";
    // Assinatura estável (tests/callers); chips de maisRestante/demo ficam no acct-head (N4b).
    void maisRestanteId;
    void demo;
    const meBits = [];
    if (cu.me?.name) meBits.push(cu.me.name);
    if (cu.me?.email) meBits.push(cu.me.email);
    // Nunca exibir "demo" no lugar dos valores da barra.
    if (cu.me?.apiKeyName && !/^demo$/i.test(String(cu.me.apiKeyName).trim())) meBits.push(cu.me.apiKeyName);
    const meLine = meBits.length ? `<p class="muted acct-me">${esc(meBits.join(" · "))}</p>` : "";
    const tip = usageTip(cu);
    const tipAttr = tip ? ` title="${esc(tip)}"` : "";
    const activeBar = account.active ? " acct-bar-active" : "";
    const kind = periodKind(cu);
    const periodWord = kind === "monthly" ? "mensal" : "semanal";
    const hasPeriod = Boolean(cu.period?.type || (cu.real?.cycleStart && cu.real?.cycleEnd) || cu.nextResetAt);
    const cap = kind === "monthly"
      ? "Uso incluído na sua assinatura. Renova todo mês."
      : "Uso incluído na sua assinatura. Renova toda semana.";
    const cycleEnd = cu.real?.cycleEnd || cu.nextResetAt || null;
    const top = usageTopPercent(cu);
    const realOk = cu.source === "real" && top != null && cu.showBar;
    const showPct = top != null && cu.showBar && cu.source !== "auth" && cu.source !== "indisponivel" && cu.source !== "none";
    let card = "";
    if (showPct) {
      const width = Math.min(100, top);
      const now = Math.round(width);
      const pctTxt = pct(top) || `${now}%`;
      const renew = renewLabel(cycleEnd, nowMs);
      card = `<div class="acct-uso"${tipAttr}>
        <p class="acct-uso-title">Limite de uso ${esc(periodWord)}</p>
        <p class="acct-uso-pct"><strong>${esc(pctTxt)}</strong> <span class="muted">usado</span></p>
        <div class="acct-bar${activeBar}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(now)}" aria-label="Uso do plano Cursor"><span style="width:${esc(width)}%"></span></div>
        ${renew ? `<p class="muted acct-uso-renew">${esc(renew)}</p>` : ""}
      </div>
      <p class="muted acct-uso-cap">${esc(cap)}</p>`;
    } else {
      const stateLabel = cu.source === "auth"
        ? (cu.real?.error || "Entre de novo com o Cursor para ver o uso.")
        : "Uso indisponível agora";
      // LEVA N5: motivo curto real sob o título (sem segredos).
      const reason = cu.source === "auth"
        ? ""
        : String(cu.reason || cu.limiteRotulo || cu.real?.error || "").replace(/^Uso indisponível agora:\s*/i, "").trim();
      const reasonLine = reason && reason !== stateLabel && reason !== "limite não informado pelo Cursor"
        ? `<p class="muted acct-uso-fail-reason">${esc(reason.slice(0, 80))}</p>`
        : (cu.source === "none" && !reason ? `<p class="muted acct-uso-fail-reason">sem dados de uso</p>` : "");
      // LEVA N4b: sem %, sem barra; título com período se conhecido.
      card = `<div class="acct-uso acct-uso-fail"${tipAttr}>
        <p class="acct-uso-title">Limite de uso${hasPeriod ? ` ${esc(periodWord)}` : ""}</p>
        <p class="acct-uso-fail-msg">${esc(stateLabel)}</p>
        ${reasonLine}
      </div>`;
    }
    const manual = cu.manualLimit || (cu.source === "manual" ? cu.limit : null) || (cu.source === "real" ? null : cu.limit);
    const limitKind = manual?.kind || cu.limit?.kind || "usd";
    const limitVal = manual
      ? String(manual.value)
      : (cu.source === "real" ? "" : (cu.limit ? String(cu.limit.value) : ""));
    const periodType = cu.period?.type || "weekly";
    const resetDay = cu.period?.resetDay ?? "";
    // Uso real ok → formulário colapsado atrás do link; falha/vazio → já expandido (sem o link).
    const limitCollapsed = realOk;
    const secondary = secondaryUsageHtml(account, cu, esc);
    const form = `<form class="stack acct-limit" data-limit-form="${esc(account.id)}">
      <div class="row">
        <label class="acct-grow">Limite manual (fallback)
          <select name="kind"><option value="usd"${limitKind === "usd" ? " selected" : ""}>US$</option><option value="tokens"${limitKind === "tokens" ? " selected" : ""}>tokens</option></select>
        </label>
        <label class="acct-grow">Valor<input name="value" type="number" min="0" step="any" value="${esc(limitVal)}" placeholder="opcional"></label>
      </div>
      <div class="row">
        <label class="acct-grow">Período
          <select name="period"><option value="weekly"${periodType === "weekly" ? " selected" : ""}>semanal</option><option value="monthly"${periodType === "monthly" ? " selected" : ""}>mensal</option></select>
        </label>
        <label class="acct-grow">Dia do reset<input name="resetDay" type="number" min="0" max="28" value="${esc(resetDay)}" title="Semanal: 0=dom … 6=sáb. Mensal: 1–28."></label>
        <button type="submit" class="btn">Salvar</button>
      </div>
    </form>`;
    // LEVA N4b: linha HELIOS/SDK atrás de "Definir limite manual"; fallback SEM <details>
    // (details aberto sem summary gera ▼/"Saiba mais" anônimo no Chromium).
    const limitBlock = limitCollapsed
      ? `<details class="acct-limit-wrap"><summary class="acct-limit-toggle">Definir limite manual</summary>${secondary}${form}</details>`
      : `<div class="acct-limit-wrap acct-limit-open">${secondary}${form}</div>`;
    return `${meLine}${card}${limitBlock}`;
  }

  function accountRowHtml(account, esc, maisRestanteId = null, demo = false) {
    const id = esc(account.id);
    const env = account.kind === "env";
    const chip = account.issue && ISSUE_CHIP[account.issue.kind]
      ? ` <span class="chip ${ISSUE_CHIP[account.issue.kind][0]}">${esc(ISSUE_CHIP[account.issue.kind][1])} às ${esc(clock(account.issue.at))}</span>`
      : "";
    const more = account.id === maisRestanteId ? ` <span class="chip">mais restante</span>` : "";
    const mockTag = demo ? ` <span class="chip acct-mock-tag">dados de teste</span>` : "";
    const labelForm = env
      ? `<p class="muted">Esta conta vem do arquivo .env deste computador e não tem apelido editável.</p>`
      : `<form class="row acct-label" data-label-form="${id}"><label class="acct-grow">Apelido<input name="label" value="${esc(account.label)}" maxlength="40" autocomplete="off"></label><button type="submit" class="btn">Salvar apelido</button></form>`;
    const replace = env
      ? ""
      : `<details class="acct-replace"><summary class="btn">Trocar chave</summary><form class="stack" data-replace-form="${id}"><label>Nova chave<input name="apiKey" type="password" required autocomplete="off" placeholder="Cole a chave inteira"></label><button type="submit" class="btn primary">Conferir e guardar</button></form></details>`;
    return `<article class="acct${account.active ? " active" : ""}" data-acct="${id}">
      <div class="acct-head"><strong>${esc(account.label)}</strong>${account.active ? ` <span class="chip live">ativa</span>` : ""} <span class="chip">${account.hasKey === false ? "sem chave" : "chave definida"}</span>${more}${mockTag}${chip}</div>
      <p class="muted">${esc(account.kindLabel || "")} · a chave não aparece de novo depois de salva.</p>
      ${cursorBarHtml(account, maisRestanteId, esc, demo)}
      ${labelForm}
      <div class="row">${account.active ? "" : `<button type="button" class="btn primary" data-use="${id}">Tornar ativa</button>`}${replace}<button type="button" class="btn danger" data-rmacc="${id}">Remover</button></div>
    </article>`;
  }

  function nextSlotName(data) {
    const used = new Set((data.accounts || []).map((account) => String(account.label || "").toLowerCase()));
    return (data.slotNames || []).find((name) => !used.has(name.toLowerCase())) || "";
  }

  function usageCardHtml(data, esc) {
    const usage = data.usage || {};
    const g = usage.global || null;
    const parts = [];
    if (g && g.max > 0) {
      const percent = Math.min(100, g.percent || 0);
      parts.push(`<p>Teto diário do HELIOS: ${esc(g.used)} de ${esc(g.max)} chamadas ao modelo hoje (${esc(g.percent)}%). <meter min="0" max="100" low="80" high="99" optimum="0" value="${esc(percent)}" aria-label="Uso do teto diário de chamadas"></meter></p>`);
      if (g.blocked) parts.push(`<p><span class="chip bad">teto atingido</span> Novas mensagens ficam bloqueadas até amanhã ou até você aumentar o teto em Atividade › Limites.</p>`);
      else if (g.alert) parts.push(`<p><span class="chip warn">perto do fim</span> Você já usou ${esc(g.percent)}% do teto diário de chamadas do HELIOS (alerta a partir de 80%).</p>`);
    }
    for (const row of usage.assistantAlerts || []) {
      parts.push(`<p><span class="chip ${row.state === "limite" ? "bad" : "warn"}">${row.state === "limite" ? "limite" : "perto do fim"}</span> ${esc(row.name)}: ${esc(row.percent)}% do limite diário. Veja em Atividade › Painel de uso.</p>`);
    }
    const accountIssue = (data.accounts || []).find((account) => account.active && account.issue && account.issue.kind === "usage");
    if (accountIssue) parts.push(`<p><span class="chip bad">limite da conta</span> A conta ${esc(accountIssue.label)} avisou que o limite de uso acabou às ${esc(clock(accountIssue.issue.at))}.</p>`);
    return `<div class="card stack" id="usageCard"><h2>Uso perto do fim</h2>
      ${parts.join("") || `<p class="muted">Nenhum alerta de uso agora.</p>`}
      <p class="muted">${esc(usage.note || "")}</p>
      <p class="muted"><a href="${esc(usage.realLimitUrl || "https://cursor.com/dashboard")}" target="_blank" rel="noreferrer">Ver o limite semanal real no painel do Cursor</a> (o uso do plano Grok vinculado aparece ali e no app do Grok).</p>
    </div>`;
  }

  /** Estado do login pelo navegador: honesto sobre o que está acontecendo, sem prometer o que não aconteceu. */
  function loginStateHtml(login, demo, esc) {
    if (demo) return `<p class="muted" id="loginState">Modo demonstração: este botão só simula a entrada e não abre o Cursor de verdade. Para usar uma conta real, cole uma chave de API.</p>`;
    if (!login || login.status === "done" || login.status === "cancelled") {
      return `<p class="muted" id="loginState">Abre o site do Cursor no seu navegador; você entra lá e o HELIOS recebe o acesso sozinho. Se não funcionar, use a chave de API abaixo.</p>`;
    }
    if (login.needsKey) {
      const page = login.keyPage ? `<a href="${esc(login.keyPage)}" target="_blank" rel="noreferrer">abrir a página de chaves do Cursor</a>` : "abra a página de chaves do Cursor";
      return `<p id="loginState"><span class="chip bad">sem conta</span> ${esc(login.error || "O navegador não entregou uma conta.")} ${page}.</p>`;
    }
    if (login.status === "waiting") {
      const link = login.url ? `<a href="${esc(login.url)}" target="_blank" rel="noreferrer">abrir o link de novo</a>` : "esperando o endereço do Cursor…";
      return `<p id="loginState"><span title="Pode levar até 5 minutos.">Aguardando você no navegador.</span> ${link}. <button type="button" class="btn" id="cancelLogin">Cancelar</button></p>`;
    }
    return `<p id="loginState"><span class="chip bad">não deu certo</span> ${esc(login.error || "A entrada pelo navegador não terminou.")} Tente a chave de API.</p>`;
  }

  function accountsHtml(data, models, login, esc) {
    const list = data.accounts || [];
    const storedCount = list.filter((account) => account.kind !== "env").length;
    const max = data.max || 3;
    const full = storedCount >= max;
    const mais = data.maisRestanteId || null;
    const rows = list.map((account) => accountRowHtml(account, esc, mais, Boolean(data.demo))).join("");
    const autoOn = data.autoSwitch === true;
    const addCard = full
      ? `<div class="card stack" id="keyForm"><h2>Adicionar conta</h2><p class="muted">Você já tem ${max} contas. Para usar outra, remova uma ou use "Trocar chave" em uma delas.</p></div>`
      : `<form class="card stack" id="keyForm"><h2>Adicionar conta (${storedCount} de ${max})</h2>
        <button type="button" class="btn primary" id="doLogin">Entrar com o Cursor pelo navegador</button>
        ${loginStateHtml(login, data.demo, esc)}
        <details class="acct-key"><summary title="Vai para o cofre e não aparece de novo. A conta nova só vira ativa se for a primeira.">Usar chave de API</summary>
          <label>Apelido<input name="label" value="${esc(nextSlotName(data))}" maxlength="40" autocomplete="off"></label>
          <label>Chave de API<input name="apiKey" type="password" autocomplete="off" placeholder="Cole a chave inteira"></label>
          <button class="btn" type="submit">Conferir e guardar</button>
        </details>
      </form>`;
    return `<div class="grid-2">
      <div class="stack">
        <div class="card stack" id="accountList"><h2>Suas contas (${storedCount} de ${max})</h2>
          <div class="row">
            <p class="muted acct-grow">Só a conta ativa é usada. Barra = ciclo do plano Cursor; SDK abaixo.</p>
            <button type="button" class="btn" id="acctRefresh">Atualizar</button>
          </div>
          <label class="check acct-auto"><input type="checkbox" id="acctAutoSwitch"${autoOn ? " checked" : ""}> Trocar automaticamente para a conta com mais uso restante quando a ativa acabar</label>
          ${rows || `<div class="empty">Nenhuma conta ainda. Sem conta ativa, o HELIOS responde em modo demonstração.</div>`}
        </div>
        ${addCard}
      </div>
      <div class="stack">
        <div class="card stack"><h2>Auto agora</h2>
          <p>${models.mock ? "Sem conta ativa: as respostas ficam no modo demonstração." : "Conta pronta para o agente."}</p>
          <p class="muted">${esc(models.auto.label)} · ${esc(models.auto.level)} · ${esc(models.auto.reason)}</p>
          ${(models.estimates || []).map((item) => `<p class="muted">${esc(item.label)}: cerca de ${esc(item.cents)} centavos de dólar numa tarefa curta de referência.</p>`).join("")}
        </div>
        ${usageCardHtml(data, esc)}
      </div>
    </div>
    <details class="card stack acct-mcp" id="mcpBox" style="margin-top:12px">
      <summary><h2>Conectar outros programas ao HELIOS (avançado)</h2></summary>
      <p class="muted" title="Para o Cursor (editor) ou outro programa deste computador falar com o HELIOS. Só funciona em 127.0.0.1. O token é uma senha: não cole em público. Nada lê o cofre; ações de risco continuam no cartão.">Não é uma conta. Pode ignorar se não usa.</p>
      <label>Endereço<input id="mcpUrl" readonly></label>
      <label>Token de acesso<input id="mcpToken" type="password" readonly autocomplete="off"></label>
      <div class="row">
        <button type="button" class="btn" id="mcpShow">Mostrar token</button>
        <button type="button" class="btn" id="mcpCopy">Copiar token</button>
        <button type="button" class="btn" id="mcpNew">Gerar outro token</button>
      </div>
      <p class="muted" id="mcpNote"></p>
      <hr>
      <h3>MCP remoto (túnel)</h3>
      <p class="muted">Token separado do local. Desligado por padrão. A UI não mostra o valor — só se está definido. Allowlist: quadro + chefe + status. Túnel: docs/operacao/tunel.md e scripts/tunel.ps1.</p>
      <p id="mcpRemoteState" class="muted">Token remoto: não definido</p>
      <label class="check"><input type="checkbox" id="mcpRemoteOn"> Ligar MCP remoto</label>
      <div class="row">
        <button type="button" class="btn" id="mcpRemoteGen">Gerar / regenerar</button>
        <button type="button" class="btn" id="mcpRemoteCopy">Copiar para a área de transferência</button>
        <button type="button" class="btn" id="mcpRemoteRevoke">Revogar</button>
      </div>
      <p class="muted" id="mcpRemoteNote"></p>
    </details>`;
  }

  /** Aviso de limite dentro da mensagem de erro do chat. Só aparece na última mensagem; nada é feito sem clique. */
  function noticeHtml(message, { isLast = false, switched = {}, esc }) {
    const issue = message && message.accountIssue;
    if (!issue || !isLast) return "";
    const id = esc(message.id);
    const moved = switched[message.id] || issue.autoSwitched?.toLabel;
    if (moved) {
      return `<div class="account-notice" data-notice="${id}"><p class="muted">Conta ativa agora: <strong>${esc(moved)}</strong>. Nada foi reenviado sozinho.</p><div class="row"><button type="button" class="btn primary" data-resend="${id}">Reenviar mensagem</button></div></div>`;
    }
    if (issue.kind === "rate") {
      return `<div class="account-notice" data-notice="${id}"><div class="row"><button type="button" class="btn primary" data-resend="${id}">Reenviar mensagem</button></div><p class="muted">A mensagem só é reenviada quando você clicar. É melhor esperar cerca de um minuto antes.</p></div>`;
    }
    const swap = issue.next
      ? `<button type="button" class="btn primary" data-switch="${esc(issue.next.id)}" data-switch-label="${esc(issue.next.label)}" data-for="${id}">Trocar para a ${esc(issue.next.label)}</button>`
      : "";
    return `<div class="account-notice" data-notice="${id}"><div class="row">${swap}<button type="button" class="btn" data-goto-account="${id}">Abrir Conta Cursor</button></div><p class="muted">Depois de trocar, o HELIOS não repete a mensagem sozinho: aparece o botão "Reenviar mensagem".</p></div>`;
  }

  function create({ call, shell, esc, banner, helios, doc = document, confirmFn = (text) => window.confirm(text) }) {
    const $ = (id) => doc.getElementById(id);
    let loginTimer = null;
    let refreshTimer = null;

    async function load(opts = {}) {
      if (opts.refresh) {
        try { await call("POST", "/api/accounts/usage/refresh", {}); } catch { /* barra segue com o que houver */ }
      }
      const [data, models] = await Promise.all([call("GET", "/api/accounts"), call("GET", "/api/models?text=oi")]);
      shell(accountsHtml(data, models, data.login, esc));
      bind();
      await paintMcp();
      if (data.login && data.login.status === "waiting" && !data.demo) watchLogin();
      clearInterval(refreshTimer);
      refreshTimer = setInterval(() => { load({ refresh: true }).catch(() => {}); }, 15 * 60 * 1000);
      if (refreshTimer.unref) refreshTimer.unref();
    }

    async function guarded(fn) {
      try { await fn(); } catch (err) { banner(err.message); }
    }

    function bind() {
      const form = $("keyForm");
      if (form && form.tagName === "FORM") {
        form.onsubmit = (event) => {
          event.preventDefault();
          const fields = new FormData(form);
          if (!String(fields.get("apiKey") || "").trim()) return banner("Cole a chave de API, ou use o botão para entrar pelo navegador.");
          return guarded(async () => {
            await call("POST", "/api/accounts/key", { apiKey: fields.get("apiKey"), label: fields.get("label") });
            await load();
            banner("Conta guardada. Ela não virou ativa sozinha: use \"Tornar ativa\" quando quiser.");
          });
        };
      }
      const refresh = $("acctRefresh");
      if (refresh) {
        refresh.onclick = () => guarded(async () => {
          await call("POST", "/api/accounts/usage/refresh", {});
          await load();
          banner("Uso atualizado.");
        });
      }
      const auto = $("acctAutoSwitch");
      if (auto) {
        auto.onchange = () => guarded(async () => {
          await call("POST", "/api/accounts/auto-switch", { enabled: auto.checked });
          banner(auto.checked ? "Auto-troca ligada." : "Auto-troca desligada.");
        });
      }
      doc.querySelectorAll("[data-limit-form]").forEach((limitForm) => {
        limitForm.onsubmit = (event) => {
          event.preventDefault();
          const fields = new FormData(limitForm);
          const id = limitForm.dataset.limitForm;
          const value = String(fields.get("value") || "").trim();
          return guarded(async () => {
            if (!value) await call("POST", `/api/accounts/${encodeURIComponent(id)}/limite`, { clear: true });
            else await call("POST", `/api/accounts/${encodeURIComponent(id)}/limite`, { kind: fields.get("kind"), value: Number(fields.get("value")) });
            await call("POST", `/api/accounts/${encodeURIComponent(id)}/periodo`, { type: fields.get("period"), resetDay: Number(fields.get("resetDay")) });
            await load();
            banner("Limite e período salvos.");
          });
        };
      });
      const login = $("doLogin");
      if (login) {
        login.onclick = () => guarded(async () => {
          login.disabled = true;
          const started = await call("POST", "/api/accounts/login", {});
          const state = $("loginState");
          if (state && started.login) state.outerHTML = loginStateHtml(started.login, false, esc);
          bindCancel();
          watchLogin();
        });
      }
      doc.querySelectorAll("[data-replace-form]").forEach((replaceForm) => {
        replaceForm.onsubmit = (event) => {
          event.preventDefault();
          const fields = new FormData(replaceForm);
          return guarded(async () => {
            await call("POST", "/api/accounts/key", { apiKey: fields.get("apiKey"), replaceId: replaceForm.dataset.replaceForm });
            await load();
            banner("Chave trocada e conferida.");
          });
        };
      });
      doc.querySelectorAll("[data-label-form]").forEach((labelForm) => {
        labelForm.onsubmit = (event) => {
          event.preventDefault();
          const fields = new FormData(labelForm);
          return guarded(async () => {
            await call("POST", "/api/accounts/label", { id: labelForm.dataset.labelForm, label: fields.get("label") });
            await load();
            banner("Apelido salvo.");
          });
        };
      });
      doc.querySelectorAll("[data-use]").forEach((button) => {
        button.onclick = () => guarded(async () => { await call("POST", "/api/accounts/active", { id: button.dataset.use }); await load(); });
      });
      doc.querySelectorAll("[data-rmacc]").forEach((button) => {
        button.onclick = () => guarded(async () => {
          const name = button.closest("[data-acct]")?.querySelector("strong")?.textContent || "esta conta";
          if (!confirmFn(`Remover ${name}? A chave sai do cofre do HELIOS. A conta no Cursor não é apagada.`)) return;
          await call("DELETE", `/api/accounts/${button.dataset.rmacc}`);
          await load();
        });
      });
    }

    function bindCancel() {
      const cancel = $("cancelLogin");
      if (cancel) cancel.onclick = () => guarded(async () => {
        await call("POST", "/api/accounts/login/cancel", {});
        await load();
        banner("Entrada pelo navegador cancelada.");
      });
    }

    function watchLogin() {
      clearInterval(loginTimer);
      bindCancel();
      loginTimer = setInterval(async () => {
        try {
          const data = await call("GET", "/api/accounts");
          const state = data.login;
          if (state && state.status === "waiting") {
            const box = $("loginState");
            if (box && !box.querySelector("a") && state.url) { box.outerHTML = loginStateHtml(state, false, esc); bindCancel(); }
            return;
          }
          clearInterval(loginTimer);
          await load();
          if (state && state.status === "done") banner("Conta conectada pelo navegador. Se não era a primeira, use \"Tornar ativa\" quando quiser.");
          else if (state && state.status === "error") banner(state.error || "A entrada pelo navegador não deu certo.");
        } catch (err) {
          clearInterval(loginTimer);
          banner(err.message);
        }
      }, 1000);
    }

    async function paintMcp() {
      const note = $("mcpNote");
      if (!note || !helios || typeof helios.mcpAccess !== "function") return;
      const paint = (access) => {
        $("mcpUrl").value = access?.url || "";
        $("mcpToken").value = access?.token || "";
        note.textContent = access?.persisted
          ? "Token guardado no cofre. Cole no mcp.json do programa que for conectar (Cursor, ou Claude Code se você usar)."
          : "Sem criptografia do sistema: o token vale só enquanto o HELIOS estiver aberto e não é gravado em disco.";
      };
      try { paint(await helios.mcpAccess()); }
      catch (err) { note.textContent = err.message || "Não consegui ler o token."; }
      $("mcpShow").onclick = () => {
        const field = $("mcpToken");
        const show = field.type === "password";
        field.type = show ? "text" : "password";
        $("mcpShow").textContent = show ? "Ocultar token" : "Mostrar token";
      };
      $("mcpCopy").onclick = async () => {
        try {
          await navigator.clipboard.writeText($("mcpToken").value);
          banner("Token copiado.");
        } catch {
          banner("Não consegui copiar. Use \"Mostrar token\" e copie à mão.");
        }
      };
      $("mcpNew").onclick = async () => {
        if (!confirmFn("Gerar outro token invalida o anterior nos aplicativos que já conectaram. Continuar?")) return;
        try { paint(await helios.mcpRegenerate()); banner("Novo token gerado. Atualize o mcp.json."); }
        catch (err) { banner(err.message); }
      };

      const remoteState = $("mcpRemoteState");
      const remoteNote = $("mcpRemoteNote");
      const remoteOn = $("mcpRemoteOn");
      if (!remoteState || typeof helios.mcpRemoteStatus !== "function") return;
      const paintRemote = (st) => {
        remoteState.textContent = st?.definido ? "Token remoto: definido" : "Token remoto: não definido";
        if (remoteOn) remoteOn.checked = Boolean(st?.enabled);
        if (remoteNote) {
          remoteNote.textContent = st?.enabled
            ? "MCP remoto ligado. Só a allowlist (quadro/chefe/status) responde; rate limit ativo. Veja docs/operacao/tunel.md."
            : "MCP remoto desligado (padrão). Não abra túnel sem ler docs/operacao/tunel.md.";
        }
      };
      try { paintRemote(await helios.mcpRemoteStatus()); }
      catch (err) { if (remoteNote) remoteNote.textContent = err.message || "Não li o MCP remoto."; }
      if (remoteOn) {
        remoteOn.onchange = () => guarded(async () => {
          paintRemote(await helios.mcpRemoteSet({ enabled: remoteOn.checked }));
          banner(remoteOn.checked ? "MCP remoto ligado." : "MCP remoto desligado.");
        });
      }
      const gen = $("mcpRemoteGen");
      if (gen) {
        gen.onclick = () => guarded(async () => {
          if (!confirmFn("Gerar o token remoto invalida o anterior (se existir). O valor vai para a área de transferência e a tela só mostra \"definido\". Continuar?")) return;
          const out = await helios.mcpRemoteGenerate();
          paintRemote({ ...out, enabled: remoteOn?.checked });
          try {
            if (out.token) await navigator.clipboard.writeText(out.token);
            banner("Token remoto gerado e copiado. Ele não aparece na tela.");
          } catch {
            banner("Token remoto gerado (definido). Use \"Copiar\" se a área de transferência falhou.");
          }
        });
      }
      const copyR = $("mcpRemoteCopy");
      if (copyR) {
        copyR.onclick = () => guarded(async () => {
          const out = await helios.mcpRemoteCopy();
          if (!out?.ok) return banner(out?.error || "Sem token remoto.");
          banner("Token remoto copiado.");
        });
      }
      const rev = $("mcpRemoteRevoke");
      if (rev) {
        rev.onclick = () => guarded(async () => {
          if (!confirmFn("Revogar o token remoto? Quem já conectou pelo túnel deixa de autenticar.")) return;
          paintRemote({ ...(await helios.mcpRemoteRevoke()), enabled: remoteOn?.checked });
          banner("Token remoto revogado.");
        });
      }
    }

    return { load: () => load({ refresh: true }) };
  }

  const api = {
    create, accountsHtml, loginStateHtml, accountRowHtml, noticeHtml, usageCardHtml, usageText, nextSlotName,
    cursorBarHtml, fmtUsed, poolsHtml, fmtBarLabel, fmtUsdCents, fmtReinicia, fmtPct, pct, daysLeft, renewLabel,
    usageTopPercent, periodKind, secondaryUsageHtml, usageTip,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else window.HeliosContas = api;
})();