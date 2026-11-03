"use strict";

/**
 * Leva G: leitor de código de verificação. Roda só no processo principal.
 * Procura no Gmail (todas as contas conectadas) o e-mail do site, chegado depois do início do login,
 * e injeta o código direto na página do site. O código nunca vai para log, servidor, histórico ou modelo.
 */
const { createGmailClient, waitForCode, header } = require("../server/gmail");
const { classify } = require("../server/vagas-email");

/** Script que digita o código na página: um campo só ou caixinhas de 1 dígito. Devolve true/false. */
function codeScript(code) {
  return `(() => {
    const c = ${JSON.stringify(String(code || ""))};
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"); d.set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
    const vis = (el) => el.offsetParent !== null && !el.disabled;
    const boxes = [...document.querySelectorAll('input[maxlength="1"]')].filter(vis);
    if (boxes.length >= c.length && c.length >= 4) { boxes.slice(0, c.length).forEach((el, i) => set(el, c[i])); }
    else {
      const el = [...document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="pin" i], input[name*="code" i], input[id*="code" i], input[inputmode="numeric"]')].filter(vis)[0];
      if (!el) return false;
      set(el, c);
    }
    const btn = [...document.querySelectorAll('button[type="submit"], input[type="submit"], button')].filter(vis).find((b) => /verific|confirm|continu|enviar|entrar|submit|next|pr[oó]ximo/i.test(b.innerText || b.value || ""));
    if (btn) btn.click();
    return true;
  })()`;
}

function createCodeReader({ getAccounts, getAuthorization, fetchImpl = globalThis.fetch, wait = waitForCode }) {
  function clients() {
    return (getAccounts() || []).map((account) => createGmailClient({ fetchImpl, getAuthorization: () => getAuthorization(account.id) }));
  }
  /** Espera o código e injeta. Devolve só { ok, motivo } — nunca o código. */
  async function fillCode(webContents, { from = "", regex = null, since = Date.now(), timeoutMs = 120000, intervalMs = 4000 } = {}) {
    const list = clients();
    if (!list.length) return { ok: false, motivo: "Nenhuma conta Gmail conectada para ler o código." };
    const got = await wait({ clients: list, from, regex, since, timeoutMs, intervalMs });
    if (!got.code) return { ok: false, motivo: got.motivo || "O código não chegou." };
    const done = await webContents.executeJavaScript(codeScript(got.code), true).catch(() => false);
    got.code = "";
    return done ? { ok: true } : { ok: false, motivo: "Recebi o código, mas não achei o campo na página." };
  }
  /** E-mails recentes de todas as contas (só metadados e trecho). Os de código ficam de fora. */
  async function scanInbox({ query = "newer_than:1d -category:promotions -category:social", max = 25 } = {}) {
    const accounts = getAccounts() || [];
    if (!accounts.length) return { ok: false, error: "Nenhuma conta Gmail conectada ainda." };
    const emails = [];
    const erros = [];
    for (const account of accounts) {
      const gmail = createGmailClient({ fetchImpl, getAuthorization: () => getAuthorization(account.id) });
      try {
        const found = await gmail.search(query, max);
        for (const ref of found) {
          const msg = await gmail.message(ref.id, "metadata");
          const item = { id: msg.id, conta: account.accountHint || account.label || "", from: header(msg, "From"), subject: header(msg, "Subject"), snippet: String(msg.snippet || "").slice(0, 300), at: Number(msg.internalDate) || 0 };
          if (classify(item) === "codigo") continue;
          emails.push(item);
        }
      } catch {
        erros.push(account.label || "Gmail");
      }
    }
    if (!emails.length && erros.length) return { ok: false, error: `Não consegui ler: ${erros.join(", ")}. Reconecte em Conectores.` };
    return { ok: true, emails, erros };
  }
  return { fillCode, scanInbox, available: () => (getAccounts() || []).length > 0 };
}

module.exports = { createCodeReader, codeScript };
