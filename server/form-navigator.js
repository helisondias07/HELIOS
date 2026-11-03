"use strict";

/**
 * Navegador de formulário por estado. Cada decisão olha um snapshot novo
 * (DOM, URL, texto). Clique não é envio: só há "submitted" com confirmação
 * positiva do site. CAPTCHA não é resolvido.
 */

const { planFill, isSuccess, norm } = require("./jobs-fill");
const { pageResult, STATES } = require("./jobs-application");
const regras = require("./vagas-regras");

const BLOCKED_BUTTON = /(mensagem|inmail|\bmessage\b|responder recrut|reply|conectar|\bconnect\b|seguir empresa|\bfollow\b|salvar vaga|save job|compartilh|\bshare\b|cancelar|\bvoltar\b|fechar|dismiss|continuar com google|sign in with)/;

const PHRASES = [
  ["apply", "candidatar-se no site da empresa"],
  ["apply", "apply on company website"],
  ["apply", "candidatura simplificada"],
  ["apply", "easy apply"],
  ["apply", "quero me candidatar"],
  ["apply", "candidatar-se"],
  ["apply", "inscrever-se"],
  ["apply", "candidate-se"],
  ["apply", "apply now"],
  ["submit", "enviar candidatura"],
  ["submit", "enviar inscricao"],
  ["submit", "finalizar candidatura"],
  ["submit", "submit application"],
  ["submit", "send application"],
  ["submit", "finish application"],
  ["submit", "concluir candidatura"],
  ["review", "revisar candidatura"],
  ["review", "revisar inscricao"],
  ["review", "review application"],
  ["review", "revisar"],
  ["next", "salvar e continuar"],
  ["next", "continuar candidatura"],
  ["next", "ir para a proxima etapa"],
  ["next", "proxima etapa"],
  ["next", "save and continue"],
  ["next", "proximo"],
  ["next", "proxima"],
  ["next", "avancar"],
  ["next", "continuar"],
  ["next", "continue"],
  ["next", "next"],
  ["next", "seguir"],
  ["submit", "enviar"],
  ["submit", "submit"],
].sort((a, b) => b[1].length - a[1].length);

function strategyOf(snapshot = {}) {
  const url = String(snapshot.url || "");
  const text = norm(`${snapshot.text || ""} ${(snapshot.buttons || []).map((button) => button.text).join(" ")}`);
  if (/gupy\.io/i.test(url)) return "gupy";
  if (/linkedin\.com/i.test(url) && (snapshot.modal || /easy apply|candidatura simplificada/.test(text))) return "linkedin-easy-apply";
  if (/linkedin\.com/i.test(url)) return "linkedin";
  if (/greenhouse|lever\.co|ashbyhq|workable|myworkday/i.test(url)) return "ats";
  return "generico";
}

function confirmationOf(snapshot = {}) {
  const text = String(snapshot.text || "");
  const fields = snapshot.fields || [];
  if (isSuccess(text) || pageResult({ url: snapshot.url, text, formVisible: fields.length > 0 }).state === STATES.SUBMITTED) {
    const match = text.match(/.{0,40}(candidatura|application|inscri[cç][aã]o|thank you|obrigado|recebemos).{0,70}/i);
    return (match ? match[0] : "confirmação visível").replace(/\s+/g, " ").trim().slice(0, 160);
  }
  return "";
}

function matchPhrase(text) {
  const value = norm(text);
  if (!value || BLOCKED_BUTTON.test(value)) return null;
  for (const [intent, phrase] of PHRASES) {
    if (value === phrase || value.includes(phrase)) {
      return { intent, phrase, exact: value === phrase };
    }
  }
  return null;
}

function matchTestId(testId) {
  const value = norm(testId);
  if (!value || BLOCKED_BUTTON.test(value)) return null;
  if (/submit|enviar|finalizar/.test(value)) return { intent: "submit", phrase: value, exact: false, fromId: true };
  if (/review|revisar/.test(value)) return { intent: "review", phrase: value, exact: false, fromId: true };
  if (/continue|next|proximo|avancar|salvar/.test(value)) return { intent: "next", phrase: value, exact: false, fromId: true };
  if (/easy-apply|easyapply|candidat|apply/.test(value)) return { intent: "apply", phrase: value, exact: false, fromId: true };
  return null;
}

function chooseButton(snapshot = {}) {
  const formOpen = Boolean(snapshot.modal) || (snapshot.fields || []).some((field) => field.inForm || field.inModal || field.required);
  const scored = [];
  for (const button of snapshot.buttons || []) {
    if (button.visible === false || button.disabled) continue;
    const text = norm([button.text, button.ariaLabel, button.title, button.name].filter(Boolean).join(" "));
    const hit = matchPhrase(text) || matchTestId(button.testId);
    if (!hit) continue;
    if ((hit.phrase === "enviar" || hit.phrase === "submit") && !(button.inForm || button.inModal)) continue;
    let score = hit.exact ? 10 : 7;
    if (hit.fromId) score += 2;
    if (/easy apply|candidatura simplificada/.test(text) || /easy/.test(norm(button.testId || ""))) score += 3;
    if (button.inModal) score += 5;
    if (button.inForm) score += 3;
    if (button.tag === "button" || button.role === "button" || button.type === "submit") score += 2;
    if (formOpen && !button.inForm && !button.inModal) score -= 4;
    scored.push({ button, score, intent: hit.intent, text });
  }
  const order = formOpen ? ["next", "review", "submit"] : ["apply", "next", "review", "submit"];
  if (!scored.some((item) => item.intent === "next" || item.intent === "review")) order.unshift("submit");
  const seen = new Set();
  for (const intent of order) {
    if (seen.has(intent)) continue;
    seen.add(intent);
    const group = scored.filter((item) => item.intent === intent).sort((a, b) => b.score - a.score);
    if (!group.length || group[0].score < 8) continue;
    const twin = group[1];
    if (twin && group[0].score - twin.score < 2 && group[0].button.inForm && twin.button.inForm && Boolean(group[0].button.inModal) === Boolean(twin.button.inModal)) {
      return { ambiguous: true, intent };
    }
    return { button: group[0].button, intent, score: group[0].score };
  }
  return { button: null };
}

function finish(kind, extra, memory) {
  return {
    kind,
    terminal: kind !== "act",
    fills: extra.fills || [],
    click: extra.click || null,
    motivo: extra.motivo || "",
    pergunta: extra.pergunta || "",
    codigo: extra.codigo || "",
    confirmacao: extra.confirmacao || "",
    estrategia: extra.estrategia || "",
    via: "rules",
    memory,
  };
}

function step(snapshot = {}, ctx = {}) {
  const memory = { ...(ctx.memory || {}) };
  const estrategia = strategyOf(snapshot);
  if (snapshot.captcha) {
    return finish("pause", {
      codigo: "captcha",
      motivo: "O site mostrou captcha. Resolva na janela; o HELIOS não contorna captcha.",
      pergunta: "Resolva o captcha na janela do HELIOS. As outras vagas seguem.",
      estrategia,
    }, memory);
  }
  const confirmacao = confirmationOf(snapshot);
  if (confirmacao) return finish("submitted", { confirmacao, estrategia }, memory);
  if (memory.pendingClick && Array.isArray(snapshot.errors) && snapshot.errors.length) {
    memory.pendingClick = false;
    return finish("pause", {
      codigo: "validacao",
      motivo: String(snapshot.errors[0]).slice(0, 180),
      pergunta: "O site recusou a etapa. Confira o campo e responda se quiser tentar de novo.",
      estrategia,
    }, memory);
  }
  const salaryAnswer = ctx.salaryAnswer || regras.pretensao(ctx.vaga || snapshot.vaga || {}, ctx.profile || {});
  const plan = planFill(snapshot.fields || [], ctx.profile || {}, ctx.respostas || {}, {
    text: snapshot.text || "",
    captcha: false,
    salaryAnswer,
  }, ctx.secrets || {});
  if (plan.criticos.length) {
    return finish("pause", {
      codigo: "critico",
      motivo: plan.criticos[0],
      pergunta: plan.criticos.join(" | "),
      estrategia,
    }, memory);
  }
  const fills = (plan.acoes || []).filter((action) => !memory.filled || !memory.filled[action.sel]);
  if (fills.length) {
    memory.filled = { ...(memory.filled || {}) };
    for (const action of fills) memory.filled[action.sel] = true;
    memory.pendingClick = false;
    return finish("act", { fills, estrategia }, memory);
  }
  const choice = chooseButton(snapshot);
  if (choice.ambiguous) {
    return finish("pause", {
      codigo: "ambiguidade",
      motivo: "Há mais de um botão possível e nenhum é seguro.",
      pergunta: "O formulário tem dois avanços parecidos. Escolha na janela.",
      estrategia,
    }, memory);
  }
  if (!choice.button) {
    return finish("failed", {
      codigo: "botao",
      motivo: "Não achei o próximo botão do formulário com segurança.",
      estrategia,
    }, memory);
  }
  if (memory.pendingClick && memory.lastSel === choice.button.sel) {
    memory.stall = (memory.stall || 0) + 1;
    if (memory.stall >= 2) {
      return finish("pause", {
        codigo: "travado",
        motivo: "O formulário não avançou depois do clique.",
        estrategia,
      }, memory);
    }
  } else {
    memory.stall = 0;
  }
  if (ctx.enviar === false && choice.intent === "submit") {
    return finish("review", { estrategia, motivo: "Preenchido. Nada foi enviado." }, memory);
  }
  memory.lastSel = choice.button.sel;
  memory.pendingClick = true;
  if (choice.intent === "review") memory.phase = "reviewed";
  return finish("act", {
    estrategia,
    click: {
      sel: choice.button.sel,
      intent: choice.intent,
      text: String(choice.button.text || choice.button.ariaLabel || choice.button.testId || choice.intent).slice(0, 80),
    },
  }, memory);
}

function simulate(pages, ctx = {}) {
  let memory = {};
  let index = 0;
  const trace = [];
  for (let guard = 0; guard < 24 && index < pages.length; guard += 1) {
    const decision = step(pages[index], { ...ctx, memory });
    memory = decision.memory || memory;
    trace.push({
      index,
      kind: decision.kind,
      codigo: decision.codigo || "",
      intent: decision.click ? decision.click.intent : "",
      sel: decision.click ? decision.click.sel : "",
      fills: (decision.fills || []).length,
      motivo: decision.motivo || "",
      confirmacao: decision.confirmacao || "",
    });
    if (decision.kind !== "act") return { final: decision, trace };
    if (decision.click) index += 1;
  }
  return { final: { kind: "failed", motivo: "sem confirmação do site" }, trace };
}

const SNAPSHOT_SCRIPT = `(() => {
  const roots = [];
  const collect = (root) => {
    if (!root || roots.indexOf(root) >= 0) return;
    roots.push(root);
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of all) if (el.shadowRoot) collect(el.shadowRoot);
  };
  collect(document);
  const frames = document.querySelectorAll("iframe");
  for (const frame of frames) {
    try { if (frame.contentDocument) collect(frame.contentDocument); } catch (e) { /* outro domínio */ }
  }
  const visible = (el) => {
    try {
      const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const style = view.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
    } catch (e) { /* segue pelo retângulo */ }
    return el.getClientRects().length > 0;
  };
  const text = (el) => String((el && (el.innerText || el.textContent)) || "").replace(/\\s+/g, " ").trim();
  const labelOf = (el) => {
    const doc = el.ownerDocument || document;
    const labelled = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelled) {
      const parts = labelled.split(/\\s+/).map((id) => doc.getElementById(id)).filter(Boolean).map(text);
      if (parts.length) return parts.join(" ");
    }
    if (el.getAttribute && el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    if (el.id) {
      const lab = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) return text(lab);
    }
    const wrap = el.closest ? el.closest("label, fieldset, [data-test-form-element], .form-group") : null;
    const legend = el.closest ? el.closest("fieldset") : null;
    return text(legend && legend.querySelector("legend")) || text(wrap && wrap.querySelector("label, span, legend")) || el.getAttribute("placeholder") || "";
  };
  let n = 0;
  const fields = [];
  const seenRadio = new Set();
  for (const root of roots) {
    const nodes = root.querySelectorAll ? root.querySelectorAll("input, select, textarea, [role='combobox']") : [];
    for (const el of nodes) {
      if (!visible(el) || el.disabled) continue;
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "input" && /^(hidden|submit|button)$/i.test(el.type || "")) continue;
      if ((el.getAttribute("role") || "") !== "combobox" && tag !== "input" && tag !== "select" && tag !== "textarea") continue;
      const type = (el.getAttribute("role") === "combobox" ? "combobox" : tag === "select" ? "select" : tag === "textarea" ? "textarea" : (el.type || "text")).toLowerCase();
      if (type === "radio") {
        if (seenRadio.has(el.name)) continue;
        seenRadio.add(el.name);
      }
      const id = "hf" + (n++);
      el.setAttribute("data-helios-field", id);
      const inModal = Boolean(el.closest && el.closest("[role='dialog'], .jobs-easy-apply-modal, [data-test-modal], .modal"));
      const inForm = Boolean(el.closest && el.closest("form, [role='dialog'], .jobs-easy-apply-modal"));
      let options = [];
      if (type === "select") options = [...el.options].map((option) => ({ value: option.value, text: option.text }));
      if (type === "combobox") {
        const listId = el.getAttribute("aria-controls");
        const list = listId ? (el.ownerDocument || document).getElementById(listId) : null;
        const opts = list ? [...list.querySelectorAll("[role='option']")] : [];
        options = opts.map((option) => ({ value: option.getAttribute("data-value") || text(option), text: text(option) }));
      }
      fields.push({
        sel: '[data-helios-field="' + id + '"]',
        tag, type, role: el.getAttribute("role") || "",
        label: labelOf(el).slice(0, 200),
        ariaLabel: (el.getAttribute("aria-label") || "").slice(0, 160),
        name: el.name || "",
        id: el.id || "",
        autocomplete: el.getAttribute("autocomplete") || "",
        placeholder: el.getAttribute("placeholder") || "",
        required: Boolean(el.required) || el.getAttribute("aria-required") === "true",
        checked: Boolean(el.checked),
        value: type === "file" ? "" : (el.value || ""),
        options, inModal, inForm,
      });
    }
  }
  const buttons = [];
  for (const root of roots) {
    const nodes = root.querySelectorAll ? root.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button'], a, [data-testid*='button' i]") : [];
    for (const el of nodes) {
      if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      const visibleText = text(el);
      if ((el.tagName || "") === "A" && (visibleText.length < 2 || visibleText.length > 80)) continue;
      const id = "hb" + (n++);
      el.setAttribute("data-helios-btn", id);
      buttons.push({
        sel: '[data-helios-btn="' + id + '"]',
        text: text(el).slice(0, 160),
        ariaLabel: (el.getAttribute("aria-label") || "").slice(0, 160),
        title: (el.getAttribute("title") || "").slice(0, 160),
        testId: (el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-qa") || "").slice(0, 120),
        name: el.getAttribute("name") || "",
        type: el.getAttribute("type") || "",
        role: el.getAttribute("role") || "",
        tag: (el.tagName || "").toLowerCase(),
        disabled: false,
        visible: true,
        inModal: Boolean(el.closest && el.closest("[role='dialog'], .jobs-easy-apply-modal, [data-test-modal], .modal")),
        inForm: Boolean(el.closest && el.closest("form, [role='dialog'], .jobs-easy-apply-modal, [data-test-modal]")),
      });
    }
  }
  const alerts = [];
  for (const root of roots) {
    const nodes = root.querySelectorAll ? root.querySelectorAll("[role='alert'], [aria-invalid='true']") : [];
    for (const el of nodes) {
      const message = text(el).slice(0, 180);
      if (message) alerts.push(message);
    }
  }
  const bodyText = (document.body && document.body.innerText || "").slice(0, 6000);
  const captcha = Boolean(document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, #captcha'));
  const modal = Boolean(document.querySelector(".jobs-easy-apply-modal, [role='dialog'], [data-test-modal]"));
  return { url: location.href, title: document.title, text: bodyText, captcha, modal, fields, buttons, errors: alerts.slice(0, 8), frames: frames.length };
})()`;

function applyScript(acoes) {
  return `(() => {
    const acoes = ${JSON.stringify((acoes || []).filter((action) => action.kind !== "file"))};
    const setVal = (el, value) => {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    };
    let done = 0;
    for (const action of acoes) {
      if (action.kind === "radio") {
        const radio = document.querySelector('[data-helios="' + action.valor + '"]') || document.querySelector(action.sel);
        if (radio) { radio.click(); done += 1; }
        continue;
      }
      const el = document.querySelector(action.sel);
      if (!el) continue;
      if (action.kind === "combobox") {
        el.click();
        const want = String(action.texto || action.valor || "").trim().toLowerCase();
        const root = el.getRootNode && el.getRootNode().querySelectorAll ? el.getRootNode() : document;
        const options = [...root.querySelectorAll("[role='option']")];
        const hit = options.find((option) => (option.innerText || "").trim().toLowerCase() === want) || options.find((option) => (option.innerText || "").toLowerCase().includes(want));
        if (hit) { hit.click(); done += 1; }
        continue;
      }
      if (action.kind === "check") { if (!el.checked) el.click(); done += 1; continue; }
      setVal(el, action.valor);
      done += 1;
    }
    return done;
  })()`;
}

function clickScript(sel) {
  const selector = String(sel || "");
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return "";
    el.scrollIntoView({ block: "center", inline: "nearest" });
    el.click();
    return String(el.innerText || el.getAttribute("aria-label") || el.getAttribute("data-testid") || "clique").replace(/\\s+/g, " ").trim().slice(0, 160);
  })()`;
}

module.exports = {
  step,
  simulate,
  strategyOf,
  chooseButton,
  confirmationOf,
  SNAPSHOT_SCRIPT,
  applyScript,
  clickScript,
  nuncaMensagemRecrutador: regras.nuncaMensagemRecrutador,
};
