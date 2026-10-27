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
    if (!local) return "Uso no HELIOS: sem registro ainda.";
    const tokens = local.week.tokens ? ` · ${local.week.tokens.toLocaleString("pt-BR")} tokens (quando o SDK informa)` : "";
    return `Uso no HELIOS: hoje ${plural(local.today.chamadas, "chamada", "chamadas")} · últimos 7 dias ${plural(local.week.chamadas, "chamada", "chamadas")}${tokens}.`;
  }

  function accountRowHtml(account, esc) {
    const id = esc(account.id);
    const env = account.kind === "env";
    const chip = account.issue && ISSUE_CHIP[account.issue.kind]
      ? ` <span class="chip ${ISSUE_CHIP[account.issue.kind][0]}">${esc(ISSUE_CHIP[account.issue.kind][1])} às ${esc(clock(account.issue.at))}</span>`
      : "";
    const labelForm = env
      ? `<p class="muted">Esta conta vem do arquivo .env deste computador e não tem apelido editável.</p>`
      : `<form class="row acct-label" data-label-form="${id}"><label class="acct-grow">Apelido<input name="label" value="${esc(account.label)}" maxlength="40" autocomplete="off"></label><button type="submit" class="btn">Salvar apelido</button></form>`;
    const replace = env
      ? ""
      : `<details class="acct-replace"><summary class="btn">Trocar chave</summary><form class="stack" data-replace-form="${id}"><label>Nova chave<input name="apiKey" type="password" required autocomplete="off" placeholder="Cole a chave inteira"></label><button type="submit" class="btn primary">Conferir e guardar</button></form></details>`;
    return `<article class="acct${account.active ? " active" : ""}" data-acct="${id}">
      <div class="acct-head"><strong>${esc(account.label)}</strong>${account.active ? ` <span class="chip live">ativa</span>` : ""} <span class="chip">${account.hasKey === false ? "sem chave" : "chave definida"}</span>${chip}</div>
      <p class="muted">${esc(account.kindLabel || "")} · a chave não aparece de novo depois de salva.</p>
      <p class="muted">${esc(usageText(account.localUsage))}</p>
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
    if (login.status === "waiting") {
      const link = login.url ? `<a href="${esc(login.url)}" target="_blank" rel="noreferrer">abrir o link de novo</a>` : "esperando o endereço do Cursor…";
      return `<p id="loginState">Aguardando você entrar no navegador e aprovar o HELIOS. Pode levar até 5 minutos. Se a página não abriu, ${link}. <button type="button" class="btn" id="cancelLogin">Cancelar</button></p>`;
    }
    return `<p id="loginState"><span class="chip bad">não deu certo</span> ${esc(login.error || "A entrada pelo navegador não terminou.")} Use a chave de API abaixo: é o caminho mais firme.</p>`;
  }

  function accountsHtml(data, models, login, esc) {
    const list = data.accounts || [];
    const storedCount = list.filter((account) => account.kind !== "env").length;
    const max = data.max || 3;
    const full = storedCount >= max;
    const rows = list.map((account) => accountRowHtml(account, esc)).join("");
    const addCard = full
      ? `<div class="card stack" id="keyForm"><h2>Adicionar conta</h2><p class="muted">Você já tem ${max} contas. Para usar outra, remova uma ou use "Trocar chave" em uma delas.</p></div>`
      : `<form class="card stack" id="keyForm"><h2>Adicionar conta (${storedCount} de ${max})</h2>
        <button type="button" class="btn primary" id="doLogin">Entrar com o Cursor pelo navegador</button>
        ${loginStateHtml(login, data.demo, esc)}
        <p class="muted"><strong>Ou use uma chave de API</strong> (caminho mais firme; vai para o cofre e não aparece de novo). A conta nova não vira ativa sozinha, exceto se for a primeira.</p>
        <label>Apelido<input name="label" value="${esc(nextSlotName(data))}" maxlength="40" autocomplete="off"></label>
        <label>Chave de API<input name="apiKey" type="password" autocomplete="off" placeholder="Cole a chave inteira"></label>
        <button class="btn" type="submit">Conferir e guardar</button>
      </form>`;
    return `<div class="grid-2">
      <div class="stack">
        <div class="card stack" id="accountList"><h2>Suas contas (${storedCount} de ${max})</h2>
          <p class="muted">O HELIOS usa só a conta ativa. Ele nunca troca de conta sozinho: quem troca é você, no botão "Tornar ativa" ou no aviso de limite do chat.</p>
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
      <p><strong>Isto não é uma conta nem um login.</strong> Serve para o Cursor (o editor), ou outro programa deste computador, como o Claude Code se você usar, conversar com o HELIOS: criar tarefas, ver rotinas e mandar mensagens. Se você não usa nada disso, pode ignorar esta caixa. Ela não mexe nas contas acima.</p>
      <p class="muted">Só funciona neste computador (127.0.0.1). O token abaixo é uma senha de acesso: não cole em lugares públicos. Nenhuma ferramenta lê o cofre. Enviar para fora, apagar, pagar ou publicar continua no cartão de aprovação.</p>
      <label>Endereço<input id="mcpUrl" readonly></label>
      <label>Token de acesso<input id="mcpToken" type="password" readonly autocomplete="off"></label>
      <div class="row">
        <button type="button" class="btn" id="mcpShow">Mostrar token</button>
        <button type="button" class="btn" id="mcpCopy">Copiar token</button>
        <button type="button" class="btn" id="mcpNew">Gerar outro token</button>
      </div>
      <p class="muted" id="mcpNote"></p>
    </details>`;
  }

  /** Aviso de limite dentro da mensagem de erro do chat. Só aparece na última mensagem; nada é feito sem clique. */
  function noticeHtml(message, { isLast = false, switched = {}, esc }) {
    const issue = message && message.accountIssue;
    if (!issue || !isLast) return "";
    const id = esc(message.id);
    const moved = switched[message.id];
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

    async function load() {
      const [data, models] = await Promise.all([call("GET", "/api/accounts"), call("GET", "/api/models?text=oi")]);
      shell(accountsHtml(data, models, data.login, esc));
      bind();
      await paintMcp();
      if (data.login && data.login.status === "waiting" && !data.demo) watchLogin();
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
    }

    return { load };
  }

  const api = { create, accountsHtml, loginStateHtml, accountRowHtml, noticeHtml, usageCardHtml, usageText, nextSlotName };
  if (typeof module === "object" && module.exports) module.exports = api;
  else window.HeliosContas = api;
})();